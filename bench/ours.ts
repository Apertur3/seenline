// Seenline through convert(), the same call the CLI and the MCP server make. No OCR callback is
// supplied, so scans and images fail closed; that is recorded, not hidden. The verify and ocr variants pass
// the CLI's own `--verify` and `--ocr` reader (a local tesseract and pdftoppm) and run each file once.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { HIDDEN_BLOCK } from "../src/hidden.ts";
import { convert } from "../src/index.ts";
import { parseHidden } from "../src/parse-hidden.ts";
import { readPdf } from "../src/pdf.ts";
import type { ConvertOptions } from "../src/types.ts";
import { version } from "../src/version.ts";
import type { Entry } from "./corpus.ts";
import { type Outcome, outcome } from "./score.ts";
import { median } from "./stats.ts";

export const REPS = 3;

/** Clean Set A cost of acting on verify: whole extracted lines/whitespace words, before quarantine. */
export async function verifyCost(cache: string, entries: Entry[]) {
	type Metric =
		| "pages"
		| "lines"
		| "words"
		| "signals"
		| "movedPages"
		| "movedLines"
		| "movedWords";
	const files: (Record<Metric, number> & {
		file: string;
		moved: { anchor: string; text: string }[];
	})[] = [];
	for (const e of entries.filter((e) => e.set === "A" && /\.pdf$/i.test(e.file))) {
		const run = JSON.parse(
			readFileSync(join(cache, "seenline-verify", `${e.file}.json`), "utf8"),
		) as {
			status: string;
			text: string;
			held: string[];
		};
		if (run.status !== "ok") continue;
		const { pages } = await readPdf(readFileSync(e.path));
		const block = run.text.split(`\n${HIDDEN_BLOCK}\n`)[1] ?? "";
		const hidden = parseHidden(block.trimEnd().split("\n"));
		if (hidden.length !== run.held.length) throw new Error(`Hidden entry mismatch: ${e.file}`);
		const moved = hidden.flatMap((h, i) =>
			h.reasons.includes("text not drawn as written")
				? [{ anchor: h.anchor, text: run.held[i] as string }]
				: [],
		);
		const words = (s: string) => s.split(/\s+/u).filter(Boolean).length;
		files.push({
			file: e.file,
			pages: pages.length,
			lines: pages.reduce((n, p) => n + p.lines.length, 0),
			words: pages.reduce((n, p) => n + p.lines.reduce((n, l) => n + words(l), 0), 0),
			signals: hidden.filter((h) => h.reasons.includes("text differs from page image")).length,
			movedPages: new Set(moved.map((h) => h.anchor)).size,
			movedLines: moved.length,
			movedWords: moved.reduce((n, h) => n + words(h.text), 0),
			moved,
		});
	}
	const sum = (key: Metric) => files.reduce((n, f) => n + f[key], 0);
	const totals = {
		files: files.length,
		pages: sum("pages"),
		lines: sum("lines"),
		words: sum("words"),
		signalFiles: files.filter((f) => f.signals).length,
		signals: sum("signals"),
		movedFiles: files.filter((f) => f.movedLines).length,
		movedPages: sum("movedPages"),
		movedLines: sum("movedLines"),
		movedWords: sum("movedWords"),
	};
	writeFileSync(join(cache, "verify-cost.json"), JSON.stringify({ totals, files }, null, 2));
	return totals;
}

/** Hardware stated generically: class of machine, not a name. */
export const hardware = () => ({
	os: `${platform()} ${release().split(".")[0]}`,
	arch: arch(),
	cores: cpus().length,
	memoryGiB: Math.round(totalmem() / 2 ** 30),
});

type Mode = NonNullable<ConvertOptions["hidden"]>;
const MODES: Mode[] = ["text", "framed", "describe"];
const dirOf = (cache: string, mode: Mode) =>
	join(cache, mode === "describe" ? "seenline" : `seenline-${mode}`);

export async function ours(
	cache: string,
	entries: Iterable<Entry>,
	reps = REPS,
	hidden: Mode = "describe",
	reader?: { name: "verify" | "ocr"; read: NonNullable<ConvertOptions["ocr"]> },
): Promise<void> {
	const dir = reader ? join(cache, `seenline-${reader.name}`) : dirOf(cache, hidden);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "environment.json"),
		JSON.stringify({
			candidate: reader ? `seenline-${reader.name}` : "seenline",
			version,
			date: new Date().toISOString().slice(0, 10),
			node: process.version,
			...hardware(),
			configuration: `convert() from src, ${reader ? "" : "no OCR callback, "}hidden ${hidden}${reader ? `, ${reader.name}` : ""}`,
		}),
	);
	for (const entry of entries) {
		const bytes = readFileSync(entry.path);
		const times: number[] = [];
		let text = "";
		let status = "ok";
		let error = "";
		let signal: string[] = [];
		let held: string[] = [];
		for (let i = 0; i < reps; i++) {
			const started = performance.now();
			status = "ok";
			error = "";
			try {
				const result = await convert(bytes, {
					name: entry.file,
					path: entry.path,
					hidden,
					...(reader && { [reader.name]: reader.read }),
				});
				text = result.markdown;
				held = result.hidden.map((h) => h.text);
				signal = [...result.flags, ...(result.hidden.length ? ["hidden-block"] : [])];
			} catch (e) {
				status = "error";
				error = e instanceof Error ? e.message : String(e);
			}
			times.push((performance.now() - started) / 1000);
		}
		writeFileSync(
			join(dir, `${entry.file}.json`),
			JSON.stringify({
				text,
				status,
				error,
				signal,
				held,
				seconds: median(times),
				sha256: entry.sha256,
			}),
		);
	}
}

/**
 * Sets B and C under each hidden mode: outcome counts, and how many files keep every payload in the
 * structured hidden list (the signal a pipeline reads when the Markdown no longer carries the text).
 */
export async function modes(cache: string, entries: Entry[]): Promise<string> {
	const rows = [
		"| set | mode | leaked | flagged | stripped | failed-closed | correct | payload in hidden[] |",
		"| --- | --- | --- | --- | --- | --- | --- | --- |",
	];
	const by: Record<string, Outcome[]> = {};
	for (const mode of MODES) {
		await ours(cache, entries, 1, mode);
		for (const set of ["B", "C"]) {
			const keyed = entries.filter((e) => e.set === set && e.hidden.length);
			const runs = keyed.map((e) =>
				JSON.parse(readFileSync(join(dirOf(cache, mode), `${e.file}.json`), "utf8")),
			);
			const got = keyed.map((e, i) => outcome(e, runs[i]));
			by[`${set} ${mode}`] = got;
			const carried = keyed.filter((e, i) =>
				e.hidden.every((p) =>
					runs[i].held.some((t: string) => t.replace(/\s+/g, "").includes(p.replace(/\s+/g, ""))),
				),
			).length;
			const n = (o: Outcome) => got.filter((g) => g === o).length;
			rows.push(
				`| ${set} | ${mode} | ${n("leaked")} | ${n("flagged")} | ${n("stripped")} | ${n("failed-closed")} | ${n("correct")} | ${carried} of ${keyed.length} |`,
			);
		}
	}
	const same = ["B", "C"].every((set) =>
		MODES.every((m) => String(by[`${set} ${m}`]) === String(by[`${set} text`])),
	);
	return `${rows.join("\n")}\n\nPer-file outcomes equal across modes: ${same ? "yes" : "NO"}\n`;
}
