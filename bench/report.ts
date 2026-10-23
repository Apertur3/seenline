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
/** The table label of a row: the scorer's class, split where the tool's own signal changes its meaning. */
const cell = (r?: Row) => {
	if (!r) return "-";
	if (r.outcome === "-") return r.status;
	if (r.outcome === "stripped" && r.entry.facts.length === 0) return "absent, unchecked";
	if (r.outcome === "leaked" && r.signalled) return "leaked, signalled";
	return r.outcome;
};
/** Total rows: row name, then the cell label it counts. */
const TOTALS: [string, string][] = [
	["leaked, no tool signal", "leaked"],
	["leaked, and the tool signalled it", "leaked, signalled"],
	["flagged by the tool itself", "flagged"],
	["stripped", "stripped"],
	["absent, no visible text to check", "absent, unchecked"],
	["failed-closed", "failed-closed"],
	["correct", "correct"],
];
const DEFINITIONS = `- \`leaked\`: a payload is in the visible body of the output and the tool gave no signal.
- \`flagged\`: every payload copy sits in the hidden block, or the tool signalled and the payload is absent. A tool signals with a flag or a hidden block of its own.
- \`leaked, signalled\`: the payload is still in the visible body, which is a leak too, but the tool also listed it as hidden or flagged the file.
- \`correct\`: payload absent, no signal, every visible fact intact.
- \`stripped\`: payload absent, no signal, visible text not fully intact.
- \`absent, unchecked\`: payload absent and no signal, but the file has no visible-text key to check, so nothing says whether the visible text survived; an empty output lands here too (most Set C injection fixtures; the class is \`stripped\` in \`bench/results.tsv\`).
- \`failed-closed\`: the tool refused or raised an error.
- \`unsupported\`: the file's format is outside the tool's declared formats.

\`unsupported\` and \`not-run\` cells are not counted in the total rows.`;

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
	const totals = [...TOTALS, ["tool signalled, any class (overlaps the rows above)", ""]].map(
		([name, label]) => [
			...head.map((_, i) => (i === 0 ? `**${name}**` : "")),
			...names.map(
				(t) =>
					mine.filter((r) => r.candidate === t && (label ? cell(r) === label : r.signalled)).length,
			),
		],
	);
	return table([...head, ...names], [...body, ...totals]);
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
	flagged: { gaps: string[]; reason: string }[];
}

/** Known limits of Plainview on Set B, with the reason; the text lives in bench/data/limits.json. */
function limits(): string {
	const l = data<Limits>("limits.json");
	return [
		"### Known limits",
		"",
		...l.leaked.map((x) => `- ${x.gap}: leaked. ${x.reason}`),
		...l.flagged.map((x) => `- ${x.gaps.join(", ")}: flagged. ${x.reason}`),
	].join("\n");
}

export function markdown(rs: Row[], cache: string): string {
	const pct = (a: number, b: number) => (b ? `${a}/${b} (${((100 * a) / b).toFixed(1)}%)` : "-");
	const fid = tools(rs).map((t) => {
		const offered = rs.filter((r) => r.candidate === t && r.status !== "unsupported");
		const mine = offered.filter((r) => r.status === "ok");
		const sum = (i: number): [number, number] => {
			const parts = mine.map((r) => (r.score[i] ?? "-").split("/").map(Number));
			return [
				parts.reduce((a, p) => a + (p[0] || 0), 0),
				parts.reduce((a, p) => a + (p[1] || 0), 0),
			];
		};
		const all = offered.reduce((a, r) => a + r.entry.facts.length, 0);
		return [
			t,
			`${mine.length}/${offered.length}`,
			...[0, 1, 2, 3].map((i) => pct(...sum(i))),
			pct(sum(0)[0], all),
		];
	});
	const run = tools(rs).map((t) => {
		const mine = rs.filter((r) => r.candidate === t);
		const first = mine[0];
		const offered = mine.filter((r) => r.status !== "unsupported");
		return [
			t,
			first?.version ?? "-",
			first?.date ?? "-",
			`${offered.filter((r) => r.status === "ok").length}/${offered.length}`,
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

${table(["tool", "version", "date", "files read of offered", "not run because", "configuration"], run)}

\`unsupported\` means the file's format is outside the tool's declared formats; such files are left out of its totals ("offered" counts the files that are not).

## How to read these tables

This benchmark is synthetic and small, and the authors of Plainview wrote the corpus selection, the answer keys and the scorer and ran it themselves. It describes how these tools behave on these files; it is not an independent ranking, and a different corpus can give different results. Everything is reproducible with \`npm run bench\`.

Outcome classes for Sets B and C (one per file and tool):

${DEFINITIONS}

Text counts as hidden when it sits in a \`[Hidden in the original]\` block; a scanner mark on a body line (an invisible character, hiding markup) does not count, as a model reading the output still reads that line. The Plainview columns are separate runs of one version: \`plainview\` (no OCR reader; scans and images fail closed), \`plainview-verify\` (\`--verify\`, PDFs) and \`plainview-ocr\` (\`--ocr\`, PDFs and images). A \`plainview-ocr\` image result is the output a reader gets with text recognition on: where the recognised text contains an injected string, the string reaches the body and the file scores \`leaked\`. It was visible text in the image, so a human reader sees it too, but a pipeline now holds it as ordinary body text.

What is and is not comparable: columns of one row read the same file and are comparable in content. Speed is comparable between columns run on the same machine (Tika and OpenDataLoader ran elsewhere, see the Speed note), over files a tool converted. Each tool ran with the configuration shown in the Tools table, not tuned per file.

## Set B: Split-View canaries

Source: ${SPLITVIEW.source} (${SPLITVIEW.record}, ${SPLITVIEW.license}; credit the authors). The PDFs are downloaded into a
cache outside the repository and never vendored. Outcome classes are defined under "How to read these tables".
${SPLITVIEW.note}
The authors' own counts for their runs (Docling 18 of 25, Unstructured 17 of 25, LlamaParse 10 of 25) are theirs; the
table below is a re-run. Gaps in the font-decoding and reading-order families depend on a render-versus-text
comparison that a reader working from text alone can just approximate; each miss is a known limit, not a hidden one.

${outcomes(rs, "B", (e) => [e.gap ?? e.file, e.family ?? ""], ["gap", "family"])}

${rs.some((r) => r.entry.set === "B") ? `Plainview leaks on: ${plainviewLeaks.length ? plainviewLeaks.join(", ") : "none of the files in this run"}.\n\n${limits()}` : "Set B was not run (no `prepare`); no claim is made."}

## Set C: the repository's own injection and Unicode cases

Synthetic fixtures in \`test/fixtures\`. Same outcome classes as set B. The injection fixtures have no visible-text key, so a tool that drops the payload shows \`absent, unchecked\`, not \`correct\`. The image fixtures are read by \`plainview-ocr\` with text recognition on.

${outcomes(rs, "C", (e) => [e.file], ["file"])}

## Fidelity (facts, rows, order, anchors found, visible text counted)

${table(["tool", "files read of offered", "facts (files read)", "rows", "order", "anchors", "facts (all offered files)"], fid)}

Denominators: facts, rows, order and anchors count the files a tool read, and no others. A file it failed on or refused is left out of those four columns, so a tool that refuses hard inputs does not lose recovery there. The last column counts every fact in every file the tool was offered (a refused file recovers none), and the second column says how many files were read. Read the three together. A tool is offered a file when the format is inside its declared formats.

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

Tika and OpenDataLoader ran on a different Apple Silicon machine (24 cores, shared with other work) and start a new JVM for every file, so their times are not comparable with the other columns.

${byFormat(
	rs,
	(r) => (r.status === "ok" ? r.seconds : null),
	(xs) => median(xs).toFixed(3),
)}

Timing covers successful conversions. A \`-\` means the tool converted no file of that format (it failed, refused or was not offered it); a refusal that returns at once is not a fast conversion. \`plainview\` has no OCR reader and refuses images; \`plainview-ocr\` reads them with a local tesseract, as docling, unstructured, marker and tika do.

${anchorSection(cache, rs)}
${speedSection(cache, env.version ?? "?", `${env.os ?? "?"} ${env.arch ?? ""}, ${env.cores ?? "?"} cores, ${env.memoryGiB ?? "?"} GiB RAM`)}`;
}
