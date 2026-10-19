// Reading order of a PDF page: the order a reader sees, which the body follows, against the order the
// file stores its text in, which an extractor follows. Most pages store text as it reads or in an order
// layout explains (a column at a time, a label drawn after its value). Two shapes have no such reason;
// only they are put in reading order (and flagged), so ordinary output stays as stored:
// - a shuffled phrase: words on one baseline, no further apart than a word space, stored out of
//   left-to-right order;
// - a grid read down: separate items (rows more than 2 em apart, three or more down a column) stored a
//   column at a time, on a page with no tight text in columns. A reader takes it row by row, as a table.
// Measured on the benchmark's public PDFs (40 files, 1,410 pages): neither shape occurs there.
import type { Item } from "./pdf-walk.ts";

// A baseline within half an em is the same row; letters closer than 0.15 em are one word.
const ROW = 0.5;
const SPACE = 0.15;
// A gap wider than this (in em) ends a phrase: wider than a word space, narrower than the gutter between
// columns or the space between a figure's labels.
const PHRASE = 0.6;
// Rows of one column further apart than this (in em) are separate items, not lines of a paragraph.
const LOOSE = 2;
const RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/u;
const WORDY = /[\p{L}\p{N}]/u;

/** Whether `it`, stored right after `prev`, continues its line: the same baseline, not jumping back. */
const continues = (prev: Item | undefined, it: Item) =>
	prev !== undefined &&
	Math.abs(it.y - prev.y) < ROW * Math.max(it.size, prev.size) &&
	it.x > prev.end - it.size;

/** Runs grouped into lines, in the order given. */
export function lines(runs: Item[]): Item[][] {
	const out: Item[][] = [];
	for (const [i, it] of runs.entries()) {
		if (continues(runs[i - 1], it)) out[out.length - 1]?.push(it);
		else out.push([it]);
	}
	return out;
}

/** The visible runs in reading order, and the ones stored in another order (in stored order; none on most pages). */
export function readingOrder(runs: Item[]): { order: Item[]; moved: Item[] } {
	// Only runs with a usable size are measured; the rest keep their stored place in the body.
	const upright = runs.filter((r) => r.upright && Number.isFinite(r.size) && r.size > 0);
	if (readDown(upright)) return { order: rows(runs).flatMap(byX), moved: runs };
	const at = new Map(runs.map((r, i) => [r, i]));
	const pos = (r: Item) => at.get(r) ?? 0;
	const bad = rows(upright)
		.flatMap((row) => phrases(byX(row)))
		.filter((p) => shuffled(p, pos));
	if (bad.length === 0) return { order: runs, moved: [] };
	// A shuffled phrase takes the place of its first stored run, left to right.
	const lead = new Map(bad.map((p) => [p.reduce((a, b) => (pos(a) <= pos(b) ? a : b)), p]));
	const inBad = new Set(bad.flat());
	return {
		order: runs.flatMap((r) => lead.get(r) ?? (inBad.has(r) ? [] : [r])),
		moved: runs.filter((r) => inBad.has(r)),
	};
}

const byX = (row: Item[]) => [...row].sort((a, b) => a.x - b.x);

// Top to bottom; a row holds what lies within half an em of the baseline of its top item.
function rows<T extends { y: number; size: number }>(items: T[]): T[][] {
	const out: T[][] = [];
	let top: T | undefined;
	for (const it of [...items].sort((a, b) => b.y - a.y)) {
		if (top && Math.abs(it.y - top.y) < ROW * Math.max(top.size, it.size))
			out[out.length - 1]?.push(it);
		else {
			out.push([it]);
			top = it;
		}
	}
	return out;
}

// A row, left to right, cut where a gap is wider than a word space.
function phrases(row: Item[]): Item[][] {
	const out: Item[][] = [];
	let end = Number.NEGATIVE_INFINITY;
	for (const r of row) {
		if (r.x - end > PHRASE * r.size) out.push([r]);
		else out[out.length - 1]?.push(r);
		end = Math.max(end, r.end);
	}
	return out;
}

// Whether a phrase's words, left to right, are out of stored order. Overlapping runs (an overprint, wrong
// glyph widths) and right-to-left script make left to right no reading order, so they never count; nor do
// words without a letter or digit (accents, emoji, a root sign are often drawn after their text).
function shuffled(p: Item[], pos: (r: Item) => number): boolean {
	const words: Item[][] = [];
	let end = Number.NEGATIVE_INFINITY;
	for (const [i, r] of p.entries()) {
		const prev = p[i - 1];
		if (r.x < end - 0.1 * r.size || RTL.test(r.text)) return false;
		const space =
			!prev || r.x - end >= SPACE * r.size || /\s$/.test(prev.text) || /^\s/.test(r.text);
		if (space) words.push([r]);
		else words[words.length - 1]?.push(r);
		end = Math.max(end, r.end);
	}
	const keys = words
		.filter((w) => w.some((r) => WORDY.test(r.text)))
		.map((w) => w.reduce((k, r) => Math.min(k, pos(r)), Number.POSITIVE_INFINITY));
	return keys.some((k, j) => j > 0 && k < (keys[j - 1] ?? k));
}

// Whether the page stores a grid of separate items a column at a time: two steps in a row down a column,
// each by more than 2 em, skip the rest of their row (stored later, to the right), and each row they land
// on goes on to the right as well. A step of 2 em or less from a row with other lines on it is text in columns, which a
// reader also takes a column at a time, so such a page is left as stored.
function readDown(upright: Item[]): boolean {
	const ls = lines(upright).map((l, i) => ({
		i,
		y: l[0]?.y ?? 0,
		x0: l.reduce((v, r) => Math.min(v, r.x), Number.POSITIVE_INFINITY),
		x1: l.reduce((v, r) => Math.max(v, r.end), Number.NEGATIVE_INFINITY),
		size: l.reduce((v, r) => Math.max(v, r.size), 0),
	}));
	// Per line: how many lines its row has, and the last stored of those that start right of its end.
	const mates: number[] = [];
	const right: number[] = [];
	for (const r of rows(ls)) {
		const byStart = [...r].sort((a, b) => a.x0 - b.x0);
		const last = byStart.map((l) => l.i);
		for (let j = last.length - 2; j >= 0; j--) last[j] = Math.max(last[j] ?? 0, last[j + 1] ?? 0);
		for (const l of r) {
			let lo = 0;
			let hi = byStart.length;
			while (lo < hi) {
				const m = (lo + hi) >> 1;
				if ((byStart[m]?.x0 ?? 0) < l.x1) lo = m + 1;
				else hi = m;
			}
			mates[l.i] = r.length;
			right[l.i] = last[lo] ?? -1;
		}
	}
	let grid = false;
	let down = false;
	for (const [k, a] of ls.entries()) {
		const b = ls[k + 1];
		if (!b) break;
		const drop = (a.y - b.y) / Math.max(a.size, b.size);
		if (drop > ROW && drop <= LOOSE && (mates[a.i] ?? 0) > 1) return false;
		const goesOn = (l: number) => (right[l] ?? -1) > b.i;
		const step = drop > LOOSE && a.x0 < b.x1 && b.x0 < a.x1 && goesOn(a.i) && goesOn(b.i);
		// Two such steps in a row: three items read down one column. Two items per column (a resume's
		// headings beside their entries) are as often read across as down, so they are left as stored.
		grid ||= step && down;
		down = step;
	}
	return grid;
}
