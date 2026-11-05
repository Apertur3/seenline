// Set D: what the location anchors cost in tokens, and whether they point at the right place.
// Overhead is measured on every fixture document and subtitle file; accuracy on the fixtures whose
// true location is known (the page of each fact, the cue of each subtitle line, the structure labels).
// `anchors` writes <cache>/anchors.json; `anchorSection` renders it with the corpus rows.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { clock, formatCue } from "../src/cues.ts";
import { convert } from "../src/index.ts";
import type { Row } from "./report.ts";
import { median } from "./stats.ts";
import { tokens } from "./tokens.ts";

const FIXTURES = join(import.meta.dirname, "../test/fixtures");
// A line that is only an anchor, or a cue line's timestamp prefix.
const ANCHOR_LINE = /^(\[(p\.|slide|row) \d+\]|\[Sheet: .*\])$/;
const CUE_PREFIX = /^\[\d\d:\d\d:\d\d\.\d{3} --> [^\]]+\] /;

/** The text with its anchors removed: the tokens the document would cost without them. */
const bare = (text: string) =>
	text
		.split("\n")
		.filter((line) => !ANCHOR_LINE.test(line))
		.map((line) => line.replace(CUE_PREFIX, ""))
		.join("\n");

/** Source cues (expected line prefix, last characters of the first text line) of a WebVTT or SubRip file, read independently of the converter. */
function cues(source: string): [string, string][] {
	const time = "(?:(\\d+):)?(\\d+):(\\d+)[.,](\\d+)";
	const re = new RegExp(`^${time} --> ${time}[^\\n]*\\n([^\\n]+)`, "gm");
	return [...source.replace(/\r/g, "").matchAll(re)].map((m) => [
		formatCue(clock(m.slice(1, 5)), clock(m.slice(5, 9)), ""),
		(m[9] ?? "")
			.replace(/<[^>]*>/g, "")
			.trim()
			.slice(-12),
	]);
}

export async function anchors(cache: string): Promise<void> {
	const overhead: Record<string, number[]> = {};
	let cueHit = 0;
	let cueAll = 0;
	for (const dir of ["documents", "subtitles"]) {
		for (const name of readdirSync(join(FIXTURES, dir))) {
			const path = join(FIXTURES, dir, name);
			const bytes = readFileSync(path);
			const text = (await convert(bytes, { name, path }).catch(() => null))?.markdown;
			if (!text) continue;
			const ext = extname(name).slice(1).toLowerCase();
			const all = tokens(text);
			overhead[ext] = [...(overhead[ext] ?? []), all ? (all - tokens(bare(text))) / all : 0];
			if (dir !== "subtitles") continue;
			const lines = text.split("\n");
			for (const [prefix, words] of cues(bytes.toString("utf8"))) {
				cueAll++;
				if (lines.some((l) => l.startsWith(prefix) && l.includes(words))) cueHit++;
			}
		}
	}
	writeFileSync(join(cache, "anchors.json"), JSON.stringify({ overhead, cueHit, cueAll }));
}

const table = (head: string[], body: (string | number)[][]) =>
	[head, head.map(() => "---"), ...body].map((r) => `| ${r.join(" | ")} |`).join("\n");

export function anchorSection(cache: string, rs: Row[]): string {
	let a: { overhead: Record<string, number[]>; cueHit: number; cueAll: number };
	try {
		a = JSON.parse(readFileSync(join(cache, "anchors.json"), "utf8"));
	} catch {
		return "## Anchors (set D)\n\nNot run for this report (`npm run bench -- anchors`); no claim is made.\n";
	}
	const found = new Map<string, [number, number]>();
	for (const r of rs.filter((r) => r.candidate === "seenline" && r.status === "ok")) {
		const [hit, all] = (r.score[3] ?? "0/0").split("/").map(Number);
		const ext = extname(r.entry.file).slice(1).toLowerCase();
		const prior = found.get(ext) ?? [0, 0];
		if (all) found.set(ext, [prior[0] + (hit ?? 0), prior[1] + all]);
	}
	const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
	return `## Anchors (set D)

Anchor overhead is the share of o200k tokens in Seenline's output that the anchors account for (page, slide,
sheet and row lines; the timestamp prefix of a cue). Median per file over the fixture documents and subtitle files;
formats without anchors show 0.

${table(
	["format", "files", "anchor overhead of tokens"],
	Object.entries(a.overhead)
		.sort()
		.map(([f, xs]) => [f, xs.length, pct(median(xs))]),
)}

Accuracy, on fixtures where the true location is known. PDFs: each fact sits under its own \`[p. N]\` anchor.
Office and mail files: the structure labels (heading, slide, sheet, header) are present. Subtitles: each source cue
appears with its own start and end time. A format whose fixture key states no location is not scored.

${table(
	["format", "anchors correct"],
	[
		...[...found].sort().map(([f, [hit, all]]) => [f, `${hit}/${all}`]),
		["srt and vtt cues", `${a.cueHit}/${a.cueAll}`],
	],
)}
`;
}
