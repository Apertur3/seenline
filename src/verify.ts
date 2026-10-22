// Render and compare (opt-in): the words of a PDF page's text layer against a text recognition reading
// of the rendered page. A text-layer word the page image does not show, at a place where the image shows
// other words, is text an extractor reads and a reader does not (a remapped font, Split-View EG_001 and
// EG_024). Recognition misses alone (a figure label, sideways text) do not count, and neither does order:
// on the benchmark's short pages order differences from recognition were as large as a reordered table.

import { PlainviewError } from "./error.ts";
import type { PdfPage } from "./pdf.ts";
import type { OcrResult } from "./types.ts";

/** Letters of difference allowed per letters of a word, for recognition errors: one in three. */
const PER_ERROR = 3;
/** Shorter words, and text-layer words with digits (formulas, ids), are not compared. */
const MIN_WORD = 4;

// Recognition confuses these; both sides are folded alike.
const fold = (w: string) =>
	w.replace(/0/g, "o").replace(/[1i]/g, "l").replace(/rn/g, "m").replace(/vv/g, "w");

/** Lowercase Latin words and numbers without accents (also a spacing one, as in "M¨uller"); words with other letters are left out. */
function words(text: string): string[] {
	return text
		.replace(/\p{Sk}/gu, "")
		.normalize("NFKD")
		.replace(/[\p{M}\p{Lm}]/gu, "")
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((w) => /^[a-z0-9]+$/.test(w))
		.map(fold);
}

/** Edit distance of a and b, or max + 1 once it is over max. */
function distance(a: string, b: string, max: number): number {
	if (Math.abs(a.length - b.length) > max) return max + 1;
	let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		for (let j = 1; j <= b.length; j++)
			row[j] = Math.min(
				(prev[j] as number) + 1,
				(row[j - 1] as number) + 1,
				(prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		if (Math.min(...row) > max) return max + 1;
		prev = row;
	}
	return prev[b.length] as number;
}

/** Whether a word stands in a stream: as a word, inside the stream with its spaces removed, or near a word. */
function seenIn(stream: string[]) {
	const bag = new Set(stream);
	const flat = stream.join("");
	const list = [...bag];
	return (w: string) => {
		if (bag.has(w) || flat.includes(w)) return true;
		const max = Math.floor(w.length / PER_ERROR);
		return max > 0 && list.some((v) => distance(w, v, max) <= max);
	};
}

/** Word pairs one page may cost (time and a 2-byte table): 9 times the largest page of the benchmark's public PDFs. */
const MAX_PAIRS = 16_000_000;

/** The runs of a longest common subsequence of both streams, in order: [start in a, start in b, length]. */
function matches(a: string[], b: string[]): [number, number, number][] {
	const m = b.length + 1;
	const len = new Uint16Array((a.length + 1) * m);
	const at = (i: number, j: number) => len[i * m + j] as number;
	for (let i = a.length - 1; i >= 0; i--)
		for (let j = b.length - 1; j >= 0; j--)
			len[i * m + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
	const found: [number, number, number][] = [];
	for (let i = 0, j = 0; i < a.length && j < b.length; ) {
		if (a[i] !== b[j]) {
			if (at(i + 1, j) >= at(i, j + 1)) i++;
			else j++;
			continue;
		}
		const last = found.at(-1);
		if (last && last[0] + last[2] === i && last[1] + last[2] === j) last[2]++;
		else found.push([i, j, 1]);
		i++;
		j++;
	}
	return found;
}

/**
 * Words of the text layer the page image shows differently, and the image's words in their place, or null
 * when they agree: counted only where a stretch of the text layer and a stretch of the image sit between
 * the same shared words and each has a word the other side lacks anywhere on the page. A page too long to
 * compare is reported as such, never passed.
 */
export function differs(
	text: string,
	image: string,
): { text: number; image: number } | "too long" | null {
	const a = words(text);
	const b = words(image);
	if ((a.length + 1) * (b.length + 1) > MAX_PAIRS) return "too long";
	const compared = (w: string) => w.length >= MIN_WORD && /^[a-z]+$/.test(w);
	// An image with no word at all where the text layer has some is not a match (no clean page did this).
	if (!b.some((w) => w.length >= MIN_WORD)) {
		const only = a.filter(compared).length;
		return only > 0 ? { text: only, image: 0 } : null;
	}
	const inImage = seenIn(b);
	const inText = seenIn(a);
	let only = 0;
	let shown = 0;
	let ai = 0;
	let bi = 0;
	const end: [number, number, number] = [a.length, b.length, 0];
	for (const [i, j, k] of [...matches(a, b), end]) {
		if (i > ai && j > bi) {
			const missing = a.slice(ai, i).filter((w) => compared(w) && !inImage(w));
			const other = b.slice(bi, j);
			// Letters a reader sees spaced out ("D A B C") count as one word.
			const joined = other.join("");
			const extra = other.filter((w) => w.length >= MIN_WORD && !inText(w)).length;
			const spaced = other.every((w) => w.length === 1) && joined.length >= MIN_WORD;
			const seen = extra || (spaced && !inText(joined) ? 1 : 0);
			if (missing.length > 0 && seen > 0) {
				only += missing.length;
				shown += seen;
			}
		}
		ai = i + k;
		bi = j + k;
	}
	return only > 0 ? { text: only, image: shown } : null;
}

/** Hidden-block lines for the pages whose text layer the rendered page shows differently; one reading per page. */
export async function compare(
	pages: PdfPage[],
	read: (pages: number[]) => Promise<OcrResult>,
): Promise<string[]> {
	if (pages.length === 0) return [];
	const seen = (await read(pages.map((p) => p.number))).pages;
	const n = (k: number) => `${k} word${k === 1 ? "" : "s"}`;
	return pages.flatMap((p) => {
		const image = seen[p.number - 1];
		if (image === undefined)
			throw new PlainviewError("invalid", "could not read this file: text recognition failed");
		const d = differs(p.lines.join("\n"), image);
		if (!d) return [];
		const counts =
			d === "too long"
				? "not compared, too many words"
				: `${n(d.text)} only in the text layer, ${n(d.image)} only in the page image`;
		return [`p. ${p.number}, text differs from page image: ${counts}`];
	});
}
