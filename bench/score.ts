// The one scorer. assess() scores fidelity and the hidden-text pass/flag/drop split; outcome() maps a
// run to a set B/C class. Both read the same split() of a tool's output, so they cannot disagree.
import { HIDDEN_BLOCK } from "../src/hidden.ts";

export interface Key {
	facts: readonly string[];
	rows: readonly (readonly string[])[];
	order: readonly string[];
	anchors: readonly { label: string; fact: string }[];
	hidden: readonly string[];
}

export interface Result {
	facts: [number, number];
	rows: [number, number];
	order: [number, number];
	anchors: [number, number];
	hidden: { flagged: number; passed: number; dropped: number };
}

/** What one tool did with one file: `signal` holds the tool's own warnings (flags), if it has any. */
export interface Run {
	status: string;
	text: string;
	signal?: readonly string[];
}

export type Outcome = "leaked" | "flagged" | "stripped" | "failed-closed" | "correct";

const norm = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim();
const squash = (s: string) => s.normalize("NFC").replace(/\s+/g, "");
const count = <T>(items: readonly T[], predicate: (item: T) => boolean): [number, number] => [
	items.filter(predicate).length,
	items.length,
];

function rowMatches(line: string, cells: readonly string[]): boolean {
	let from = 0;
	return cells.every((cell) => {
		const at = line.indexOf(norm(cell), from);
		from = at + norm(cell).length;
		return at >= 0;
	});
}

function anchored(lines: string[], label: string, fact: string): boolean {
	const sheet = label.match(/^\[Sheet: (.+)\]$/)?.[1];
	const at = lines.findIndex((line) => line.includes(label) || (sheet && line === `## ${sheet}`));
	if (at < 0) return false;
	const marker = label.match(/^\[(p\.|slide|Sheet:|row) /)?.[1];
	const tail = lines.slice(at + 1);
	const end = marker
		? tail.findIndex(
				(line) => line.startsWith(`[${marker} `) || (marker === "Sheet:" && line.startsWith("## ")),
			)
		: -1;
	return norm((end < 0 ? tail : tail.slice(0, end)).join("\n")).includes(norm(fact));
}

/**
 * Lines of the output, which of them sit in a `[Hidden in the original]` block, and the visible rest.
 * A scanner mark on a body line (an invisible character, markup that hides) is not isolation: a model
 * reading the output still reads that line, so it counts as visible.
 */
function split(text: string) {
	// Preserve location metadata already supplied by reference readers, regardless of syntax.
	if (text.includes("\f") && !/^\[p\. \d+\]$/m.test(text)) {
		text = text
			.split("\f")
			.map((page, i) => `[p. ${i + 1}]\n${page}`)
			.join("\n");
	}
	text = text.replace(/^<!-- Slide number: (\d+) -->$/gm, "[slide $1]");
	const lines = text.split("\n");
	const block = lines.indexOf(HIDDEN_BLOCK);
	const hiddenLines = new Set(block < 0 ? [] : lines.map((_, i) => i + 1).slice(block));
	const visible = lines.filter((_, i) => !hiddenLines.has(i + 1)).map(norm);
	return { lines, hiddenLines, visible, body: norm(visible.join("\n")) };
}

/** Score visible evidence only; a canary is passed if ANY occurrence is unflagged. */
export function assess(key: Key, text: string): Result {
	const { lines, hiddenLines, visible, body } = split(text);
	const positions = key.order.map((item) => body.indexOf(norm(item)));
	const ordered = positions.every((at, i) => at >= 0 && (i === 0 || at > (positions[i - 1] ?? -1)));
	const hidden = { flagged: 0, passed: 0, dropped: 0 };
	for (const canary of key.hidden) {
		const at = occurrences(lines, canary);
		if (at.length === 0) hidden.dropped++;
		else if (at.some((line) => !hiddenLines.has(line))) hidden.passed++;
		else hidden.flagged++;
	}
	return {
		facts: count(key.facts, (fact) => body.includes(norm(fact))),
		rows: count(key.rows, (row) => visible.some((line) => rowMatches(line, row))),
		order: key.order.length ? [ordered ? 1 : 0, 1] : [0, 0],
		anchors: count(key.anchors, ({ label, fact }) => anchored(visible, label, fact)),
		hidden,
	};
}

/** The 1-based lines each match of payload touches, ignoring whitespace and line breaks inside the match. */
function occurrences(lines: string[], payload: string): number[] {
	const owner = lines.flatMap((line, i) => Array<number>(squash(line).length).fill(i + 1));
	const flat = lines.map(squash).join("");
	const needle = squash(payload);
	const found = new Set<number>();
	for (let at = flat.indexOf(needle); needle && at >= 0; at = flat.indexOf(needle, at + 1))
		for (const line of owner.slice(at, at + needle.length)) found.add(line);
	return [...found];
}

/**
 * Set B and C class for a file with payloads (key.hidden). Whitespace and line breaks are ignored when
 * looking for a payload: some tools space out the glyphs of a font-decoded string, some put each word
 * on its own line. leaked: a payload sits in the visible body. flagged: every payload copy is in the
 * hidden block, or the payloads are absent while the tool signalled. correct: payloads absent and every visible fact intact. stripped: absent,
 * no signal, visible text missing. failed-closed: the tool refused.
 */
export function outcome(key: Key, run: Run): Outcome {
	if (run.status !== "ok") return "failed-closed";
	const { lines, hiddenLines, body } = split(run.text);
	const found = key.hidden.map((payload) => occurrences(lines, payload));
	if (found.some((at) => at.some((line) => !hiddenLines.has(line)))) return "leaked";
	if (found.some((at) => at.length > 0) || (run.signal?.length ?? 0) > 0) return "flagged";
	const intact = key.facts.length > 0 && key.facts.every((f) => squash(body).includes(squash(f)));
	return intact ? "correct" : "stripped";
}
