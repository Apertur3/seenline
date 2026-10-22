// Plainview through convert(), the same call the CLI and the MCP server make. No OCR callback is
// supplied, so scans and images fail closed; that is recorded, not hidden.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { convert } from "../src/index.ts";
import type { ConvertOptions } from "../src/types.ts";
import { version } from "../src/version.ts";
import type { Entry } from "./corpus.ts";
import { type Outcome, outcome } from "./score.ts";
import { median } from "./stats.ts";

export const REPS = 3;

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
	join(cache, mode === "describe" ? "plainview" : `plainview-${mode}`);

export async function ours(
	cache: string,
	entries: Entry[],
	reps = REPS,
	hidden: Mode = "describe",
): Promise<void> {
	const dir = dirOf(cache, hidden);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "environment.json"),
		JSON.stringify({
			candidate: "plainview",
			version,
			date: new Date().toISOString().slice(0, 10),
			node: process.version,
			...hardware(),
			configuration: `convert() from src, no OCR callback, hidden ${hidden}`,
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
				const result = await convert(bytes, { name: entry.file, path: entry.path, hidden });
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
