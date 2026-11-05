// Set E, fairness part: token medians over the files every core tool read (so a tool that fails on
// the hard files does not look cheaper), and what Seenline's hidden block costs in tokens.
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { HIDDEN_BLOCK } from "../src/hidden.ts";
import type { Row } from "./report.ts";
import { median } from "./stats.ts";
import { tokens } from "./tokens.ts";

const CORE = ["seenline", "markitdown", "docling", "unstructured"];
const fmt = (row: Row) => extname(row.entry.file).slice(1).toLowerCase();

export function commonTokens(rs: Row[], cache: string): string {
	const a = rs.filter((r) => r.entry.set === "A" && CORE.includes(r.candidate));
	const files = [...new Set(a.map((r) => r.entry.file))].filter((f) =>
		CORE.every((c) => a.some((r) => r.entry.file === f && r.candidate === c && r.status === "ok")),
	);
	const row = (f: string, c: string) => a.find((r) => r.entry.file === f && r.candidate === c);
	const formats = [...new Set(files.map((f) => fmt(row(f, "seenline") as Row)))].sort();
	const cells = formats.map((x) => {
		const fs = files.filter((f) => fmt(row(f, "seenline") as Row) === x);
		const share = fs.map((f) => {
			const file = join(cache, "seenline", `${f}.json`);
			const text: string = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).text : "";
			const i = text.indexOf(`\n${HIDDEN_BLOCK}\n`);
			return i < 0 ? 0 : tokens(text.slice(i)) / Math.max(1, tokens(text));
		});
		return [
			x,
			String(fs.length),
			...CORE.map((c) => String(Math.round(median(fs.map((f) => row(f, c)?.tokens ?? 0))))),
			`${(median(share) * 100).toFixed(1)}%`,
		];
	});
	const head = ["format", "files", ...CORE, "hidden block share (seenline)"];
	const line = (xs: string[]) => `| ${xs.join(" | ")} |`;
	return [
		`Common files:${files.length} public files that Seenline, MarkItDown, Docling and Unstructured all read (median o200k tokens per file).`,
		"",
		line(head),
		line(head.map(() => "---")),
		...cells.map(line),
	].join("\n");
}

/** How often Seenline puts something in the hidden block of an ordinary public file: a measure of noise, not of detection. */
export function hiddenRate(rs: Row[], cache: string): string {
	const a = rs.filter(
		(r) => r.entry.set === "A" && r.candidate === "seenline" && r.status === "ok",
	);
	const by = new Map<string, [number, number]>();
	for (const r of a) {
		const file = join(cache, "seenline", `${r.entry.file}.json`);
		const text: string = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).text : "";
		const [n, k] = by.get(fmt(r)) ?? [0, 0];
		by.set(fmt(r), [n + 1, k + (text.includes(`\n${HIDDEN_BLOCK}\n`) ? 1 : 0)]);
	}
	const body = [...by].sort().map(([x, [n, k]]) => `| ${x} | ${n} | ${k} |`);
	return [
		"Hidden block on ordinary public files (Set A, files Seenline read): the entries are not verified as malicious, they are what Seenline lists. Package metadata, covered text and white text on slides are common in clean documents, so this is noise a user sees with `--fail-on-hidden`.",
		"",
		"| format | files | with a hidden block |",
		"| --- | --- | --- |",
		...body,
	].join("\n");
}
