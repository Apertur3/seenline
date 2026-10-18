// `report`: one row per tool and file into bench/results.tsv, and the tables of docs/BENCHMARK.md.
// A tool that did not run is a row that says so and why; nothing is skipped silently.
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { HIDDEN_BLOCK } from "../src/hidden.ts";
import { anchorSection } from "./anchors.ts";
import { corpus, data, type Entry, SPLITVIEW } from "./corpus.ts";
import { assess, type Outcome, outcome } from "./score.ts";
import { speedSection } from "./speed.ts";
import { median, stats } from "./stats.ts";
import { tokens } from "./tokens.ts";
import { commonTokens, hiddenRate } from "./tokens-report.ts";

interface Spec {
	formats: "*" | string[];
	configuration: string;
}
export const CANDIDATES = data<{ candidates: Record<string, Spec> }>("environment.json").candidates;
export const HEAD = [
	"candidate version date set group file gap sha256 status outcome",
	"facts rows order anchors flagged passed dropped tokens seconds error",
]
	.join(" ")
	.split(" ");

export interface Row {
	candidate: string;
	version: string;
	date: string;
	entry: Entry;
	status: string;
	outcome: Outcome | "-";
	/** The tool itself named the hidden content: a signal, or a hidden block. */
	signalled: boolean;
	score: string[];
	tokens: number | null;
	seconds: number | null;
	error: string;
}
interface Env {
	version?: string;
	dateUTC?: string;
	date?: string;
	reason?: string;
	configuration?: string;
}
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const NONE = Array(7).fill("-");

function row(cache: string, candidate: string, entry: Entry, env: Env): Row {
	const base = {
		candidate,
		version: env.version ?? "-",
		date: env.date ?? env.dateUTC?.slice(0, 10) ?? "-",
		entry,
	};
	const bare = {
		...base,
		outcome: "-" as const,
		signalled: false,
		score: NONE,
		tokens: null,
		seconds: null,
	};
	const formats = CANDIDATES[candidate]?.formats ?? "*";
	if (formats !== "*" && !formats.includes(extname(entry.file).slice(1).toLowerCase()))
		return { ...bare, status: "unsupported", error: "format outside the tool's declared formats" };
	const file = join(cache, candidate, `${entry.file}.json`);
	if (!existsSync(file))
		return {
			...bare,
			status: "not-run",
			error: scrub(env.reason ?? "no result file; the adapter was not run for this report"),
		};
	const run = read(file);
	if (run.sha256 !== entry.sha256) throw new Error(`Input mismatch: ${candidate}/${entry.file}`);
	const ok = run.status === "ok";
	const result = assess(entry, ok ? run.text : "");
	// A refusal has zero recovery but no hidden outcome: refusing is not a successful drop.
	const hidden = ok ? Object.values(result.hidden).map(String) : ["-", "-", "-"];
	const pairs = [result.facts, result.rows, result.order, result.anchors].map((p) => p.join("/"));
	return {
		...base,
		status: run.status,
		outcome: entry.hidden.length ? outcome(entry, run) : "-",
		signalled: (run.signal?.length ?? 0) > 0 || String(run.text).split("\n").includes(HIDDEN_BLOCK),
		score: [...pairs, ...hidden],
		tokens: ok ? tokens(run.text) : null,
		seconds: run.seconds,
		error: scrub(String(run.error ?? "")),
	};
}

export function rows(cache: string): Row[] {
	const entries = corpus(cache);
	return Object.keys(CANDIDATES).flatMap((candidate) => {
		const dir = join(cache, candidate);
		const env: Env = existsSync(join(dir, "environment.json"))
			? read(join(dir, "environment.json"))
			: {};
		if (existsSync(join(dir, "not-run.json")))
			env.reason = `not-run: ${read(join(dir, "not-run.json")).reason}`.replace(/\s+/g, " ");
		return entries.map((entry) => row(cache, candidate, entry, env));
	});
}

export const tsv = (rs: Row[]): string =>
	`${[
		HEAD.join("\t"),
		...rs.map((r) =>
			[
				r.candidate,
				r.version,
				r.date,
				r.entry.set,
				r.entry.group,
				r.entry.file,
				r.entry.gap ?? "-",
				r.entry.sha256,
				r.status,
				r.outcome,
				...r.score,
				r.tokens ?? "-",
				r.seconds?.toFixed(4) ?? "-",
				r.error || "-",
			].join("\t"),
		),
	].join("\n")}\n`;

const table = (head: string[], body: (string | number)[][]) =>
	[head, head.map(() => "---"), ...body].map((r) => `| ${r.join(" | ")} |`).join("\n");
const tools = (rs: Row[]) => [...new Set(rs.map((r) => r.candidate))];
const ext = (r: Row) => extname(r.entry.file).slice(1).toLowerCase();
const OUTCOMES: Outcome[] = ["leaked", "flagged", "stripped", "failed-closed", "correct"];
const cell = (r?: Row) => (r ? (r.outcome === "-" ? r.status : r.outcome) : "-");

/** Outcome per file (rows) and tool (columns) for one set, then the totals per tool. */
function outcomes(rs: Row[], set: string, label: (e: Entry) => string[], head: string[]): string {
	const mine = rs.filter((r) => r.entry.set === set && r.entry.hidden.length > 0);
	const names = tools(rs);
	const files = [...new Set(mine.map((r) => r.entry.file))];
	const body = files.map((file) => {
		const e = mine.find((r) => r.entry.file === file)?.entry as Entry;
		return [
			...label(e),
			...names.map((t) => cell(mine.find((r) => r.candidate === t && r.entry.file === file))),
		];
	});
	const totals = OUTCOMES.map((o) => [
		...head.map((_, i) => (i === 0 ? `**${o}**` : "")),
		...names.map((t) => mine.filter((r) => r.candidate === t && r.outcome === o).length),
	]);
	// Flagged under the scanner's reading includes raw invisible characters passed through; this line is the tool's own doing.
	const own = [
		...head.map((_, i) => (i === 0 ? "**flagged by the tool itself**" : "")),
		...names.map(
			(t) => mine.filter((r) => r.candidate === t && r.outcome === "flagged" && r.signalled).length,
		),
	];
	return table([...head, ...names], [...body, ...totals, own]);
}

function byFormat(
	rs: Row[],
	pick: (r: Row) => number | null,
	show: (xs: number[]) => string,
): string {
	const formats = [...new Set(rs.map(ext))].sort();
	const names = tools(rs);
	const body = formats.map((f) => [
		f,
		...names.map((t) => {
			const xs = rs
				.filter((r) => r.candidate === t && ext(r) === f)
				.map(pick)
				.filter((x) => x !== null);
			return xs.length ? show(xs) : "-";
		}),
	]);
	return table(["format", ...names], body);
}

/** Provider counts for PDFs, when the optional step has run: the native upload against each tool's Markdown. */
function provider(cache: string): string {
	const file = join(cache, "provider-tokens.json");
	if (!existsSync(file))
		return "Provider token counts of the native upload are a separate optional step (`provider-tokens.ts`); none were run for this table.";
	const counts: Record<string, Record<string, number>> = read(file);
	const names = Object.keys(CANDIDATES);
	const med = (key: string) => {
		const xs = Object.values(counts).flatMap((c) => (c[key] === undefined ? [] : [c[key]]));
		return xs.length ? String(Math.round(median(xs))) : "-";
	};
	const share = (key: string) => {
		const xs = Object.values(counts).flatMap((c) =>
			c[key] && c.native ? [c[key] / c.native] : [],
		);
		return xs.length ? `${Math.round(median(xs) * 100)}%` : "-";
	};
	return `Provider counts, PDFs, median per file (the native upload against each tool's Markdown):\n\n${table(
		["", "native", ...names],
		[
			["tokens", med("native"), ...names.map(med)],
			["share of native", "100%", ...names.map(share)],
		],
	)}`;
}

/** One line, with home directories and the scratch cache path removed: tool errors quote absolute paths. */
export const scrub = (text: string): string =>
	text
		.replace(/[\t\r\n]+/g, " ")
		.replace(/(?:\/private)?\/tmp\/[^\s'"]*?\/(?=input\/|cache\/)/g, "<cache>/")
		.replace(/\/(?:Users|home)\/[^/\s'"]+/g, "~");

interface Limits {
	leaked: { gap: string; reason: string }[];
	failedClosedByFloor: { gaps: string[]; reason: string }[];
}

/** Known limits of Plainview on Set B, with the reason; the text lives in bench/data/limits.json. */
function limits(): string {
	const l = data<Limits>("limits.json");
	return [
		"### Known limits",
		"",
		...l.leaked.map((x) => `- ${x.gap}: leaked. ${x.reason}`),
		...l.failedClosedByFloor.map((x) => `- ${x.gaps.join(", ")}: failed closed. ${x.reason}`),
		"",
		"Failed-closed here is not detection: these canary pages are shorter than Plainview's text threshold, so the harness (no OCR) never reaches the text layer.",
	].join("\n");
}

export function markdown(rs: Row[], cache: string): string {
	const fid = tools(rs).map((t) => {
		const all = rs.filter((r) => r.candidate === t);
		const mine = all.filter((r) => r.status === "ok");
		const sum = (i: number) => {
			const parts = mine.map((r) => (r.score[i] ?? "-").split("/").map(Number));
			return `${parts.reduce((a, p) => a + (p[0] || 0), 0)}/${parts.reduce((a, p) => a + (p[1] || 0), 0)}`;
		};
		return [t, `${mine.length}/${all.length}`, sum(0), sum(1), sum(2), sum(3)];
	});
	const run = tools(rs).map((t) => {
		const mine = rs.filter((r) => r.candidate === t);
		const first = mine[0];
		return [
			t,
			first?.version ?? "-",
			first?.date ?? "-",
			`${mine.filter((r) => r.status === "ok").length}/${mine.length}`,
			mine.some((r) => r.status === "not-run")
				? (mine.find((r) => r.status === "not-run")?.error ?? "")
				: "",
			CANDIDATES[t]?.configuration ?? "",
		];
	});
	const plainviewLeaks = rs
		.filter((r) => r.candidate === "plainview" && r.outcome === "leaked")
		.map((r) => r.entry.file);
	const env = existsSync(join(cache, "plainview", "environment.json"))
		? read(join(cache, "plainview", "environment.json"))
		: {};
	return `# Benchmark

Generated by \`npm run bench -- report\` from the cache of a run; do not edit by hand. Raw per-file rows are in
\`bench/results.tsv\`. Every number comes from the tool version and date in the Tools table. Hardware: ${env.os ?? "?"}
${env.arch ?? ""}, ${env.cores ?? "?"} cores, ${env.memoryGiB ?? "?"} GiB RAM; wall time is the median of repeated runs per file.

## Tools run

The tables here cover the tools shown as run below. A tool that was not run has no results and no claim is made about it. Do not quote a partial run as a comparison.

${table(["tool", "version", "date", "files read", "not run because", "configuration"], run)}

\`unsupported\` means the file's format is outside the tool's declared formats; such files are left out of its totals.

## Set B: Split-View canaries

Source: ${SPLITVIEW.source} (${SPLITVIEW.record}, ${SPLITVIEW.license}; credit the authors). The PDFs are downloaded into a
cache outside the repository and never vendored. Outcomes: \`leaked\` (payload in the visible body), \`flagged\`
(every payload copy sits in the hidden block, or the tool signalled and the payload is absent), \`correct\` (payload absent, no signal, every visible fact intact), \`stripped\` (payload absent, no signal, visible text not fully intact), \`failed-closed\` (error). Hidden-ness is judged by Plainview's scanner over each tool's output.
${SPLITVIEW.note}
The authors' own counts for their runs (Docling 18 of 25, Unstructured 17 of 25, LlamaParse 10 of 25) are theirs; the
table below is a re-run. Gaps in the font-decoding and reading-order families depend on a render-versus-text
comparison that a reader working from text alone can just approximate; each miss is a known limit, not a hidden one.

${outcomes(rs, "B", (e) => [e.gap ?? e.file, e.family ?? ""], ["gap", "family"])}

${rs.some((r) => r.entry.set === "B") ? `Plainview leaks on: ${plainviewLeaks.length ? plainviewLeaks.join(", ") : "none of the files in this run"}.\n\n${limits()}` : "Set B was not run (no `prepare`); no claim is made."}

## Set C: the repository's own injection and Unicode cases

Synthetic fixtures in \`test/fixtures\`. Same outcome classes as set B.

${outcomes(rs, "C", (e) => [e.file], ["file"])}

## Fidelity (facts, rows, order, anchors found, visible text counted)

${table(["tool", "files read", "facts", "rows", "order", "anchors"], fid)}

## Tokens (o200k, Markdown output per file: median, p10 to p90)

${byFormat(
	rs,
	(r) => r.tokens,
	(xs) => {
		const s = stats(xs);
		return `${Math.round(s.median)} (${Math.round(s.p10)} to ${Math.round(s.p90)})`;
	},
)}

${commonTokens(rs, cache)}

${hiddenRate(rs, cache)}

${provider(cache)}

## Speed (seconds per file, median of per-file medians)

${byFormat(
	rs,
	(r) => r.seconds,
	(xs) => median(xs).toFixed(3),
)}

${anchorSection(cache, rs)}
${speedSection(cache, env.version ?? "?", `${env.os ?? "?"} ${env.arch ?? ""}, ${env.cores ?? "?"} cores, ${env.memoryGiB ?? "?"} GiB RAM`)}`;
}
