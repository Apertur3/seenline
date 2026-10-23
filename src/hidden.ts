// Flags hidden content and renders invisible characters as readable text without changing the input.

const TAG = "[\\u{E0000}-\\u{E007F}]";
const BIDI = "[\\u202A-\\u202E\\u2066-\\u2069\\u200E\\u200F\\u061C]";
// A joiner between two emoji is how emoji are written, so only a joiner outside one is flagged.
const ZERO_WIDTH =
	"[\\u200B\\u200C\\u2060\\uFEFF\\u00AD]|(?<!\\p{Extended_Pictographic}[\\uFE0F\\u{1F3FB}-\\u{1F3FF}]?)\\u200D|\\u200D(?!\\p{Extended_Pictographic})";
// A selector after an emoji (or a keycap digit) is emoji too; any other selector, private use, or a
// format character of no other class renders as nothing.
const INVISIBLE =
	"(?<!\\p{Emoji})\\p{Variation_Selector}|\\p{Co}|(?![\\u{E0000}-\\u{E007F}\\u202A-\\u202E\\u2066-\\u2069\\u200B-\\u200F\\u061C\\u2060\\uFEFF\\u00AD])\\p{Cf}";
// A word that mixes Latin letters with Cyrillic or Greek ones: a lookalike that passes for the Latin
// word. The Greek letters science writes next to Latin ones (micro, omega, delta, pi) are not counted.
const HOMOGLYPH =
	"(?<![\\p{L}\\p{M}])(?=[\\p{L}\\p{M}]*\\p{Script=Latin})(?=[\\p{L}\\p{M}]*(?![μΩΔπ])[\\p{Script=Cyrillic}\\p{Script=Greek}])[\\p{L}\\p{M}]+";
const CLASSES: [flag: string, pattern: RegExp][] = [
	["tag-chars", new RegExp(TAG, "u")],
	["zero-width", new RegExp(ZERO_WIDTH, "u")],
	["bidi", new RegExp(BIDI, "u")],
	["invisible", new RegExp(INVISIBLE, "u")],
	["homoglyph", new RegExp(HOMOGLYPH, "u")],
];
const STYLE_HIDING =
	/display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*(0(px|em|rem|%)?|1px)(?![\d.])|opacity\s*:\s*0(\.0+)?(?![\d.])|(?<![\w-])color\s*:\s*(white|#fff(fff)?\b|rgb\(\s*255\s*,\s*255\s*,\s*255\s*\))|<[^>]*\shidden[\s>=]/i;
/** The line that opens the block a converted document keeps its hidden text in. */
export const HIDDEN_BLOCK = "[Hidden in the original]";
const ORDER = [...CLASSES.map(([flag]) => flag), "markup-hidden"];

export interface Scan {
	/** The source's flags, in a fixed order; empty for a clean source. */
	flags: string[];
	/** 1-based lines holding hidden content. */
	hidden: Set<number>;
}

/** Scans a source's lines for content a human reader would not see. */
export function scan(lines: string[]): Scan {
	const found = new Set<string>();
	const result: Scan = { flags: [], hidden: new Set() };
	let comment = false;
	// From the converted-document marker to the end, every line is text a reader of the original did not see.
	let block = false;
	// The element a hiding style opened and did not close on its line: it hides what follows too.
	let element: string | null = null;
	for (const [i, raw] of lines.entries()) {
		// A byte order mark that starts the text is an encoding mark, not hidden text.
		const line = i === 0 ? raw.replace(/^﻿/, "") : raw;
		const flags = CLASSES.filter(([, pattern]) => pattern.test(line)).map(([flag]) => flag);
		// An HTML comment hides every line from its opening to its close.
		const open = line.lastIndexOf("<!--");
		const styled = STYLE_HIDING.test(line);
		block ||= line === HIDDEN_BLOCK;
		if (comment || element || block || open !== -1 || styled) flags.push("markup-hidden");
		// ponytail: nesting of the same tag is not counted; the block ends at its first close tag.
		if (element && line.includes(`</${element}`)) element = null;
		const tag = styled ? /<([a-z][\w-]*)/i.exec(line)?.[1]?.toLowerCase() : undefined;
		if (tag && !line.toLowerCase().includes(`</${tag}`)) element = tag;
		comment = open === -1 ? comment && !line.includes("-->") : !line.includes("-->", open);
		for (const flag of flags) found.add(flag);
		if (flags.length > 0) result.hidden.add(i + 1);
	}
	result.flags = ORDER.filter((flag) => found.has(flag));
	return result;
}

const TAG_RUN = new RegExp(`${TAG}+`, "gu");
const UNSEEN = new RegExp(`${BIDI}|${ZERO_WIDTH}|${INVISIBLE}`, "gu");
const code = (c: string) => (c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");

/** A line as a model sees it: tag runs counted, every other invisible character named. */
export function visible(line: string): string {
	return line
		.replace(TAG_RUN, (run) => `[hidden: ${[...run].length} tag characters]`)
		.replace(UNSEEN, (c) => `[U+${code(c)}]`);
}

// Invisible characters that can spell text, as runs: tag characters, variation selectors, zero-width.
const CARRIER = /(?:[\u{E0000}-\u{E007F}]|\p{Variation_Selector}|[​-‍⁠﻿­⁡-⁤᠎])+/gu;
const SCRIPT_LATIN = /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}]/u;
const LETTER = /[\p{L}\p{M}]/u;
const cp = (c: string) => c.codePointAt(0) ?? 0;

// A run that is part of ordinary text: an emoji's selector or joiner, a subdivision flag's tag letters,
// a soft hyphen, one selector on a symbol or an ideograph, one joiner or space between the letters of a
// script that shapes or breaks with it, or one break hint at a hyphen, dash or slash.
function ordinary(run: string, before: string, after: string): boolean {
	if (/^️?‍?$/u.test(run) && /\p{Emoji}/u.test(before))
		return !run.endsWith("‍") || /\p{Extended_Pictographic}/u.test(after);
	if (
		before === "\u{1F3F4}" &&
		/^[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{1,6}\u{E007F}$/u.test(run)
	)
		return true;
	if ([...run].length !== 1) return false;
	if (run === "­") return true;
	if (/\p{Variation_Selector}/u.test(run)) return !SCRIPT_LATIN.test(before);
	if (/[​-‍]/.test(run) && LETTER.test(before) && LETTER.test(after))
		return !SCRIPT_LATIN.test(before) || !SCRIPT_LATIN.test(after);
	return /[​⁠]/.test(run) && /[-‐-―/]/.test(before);
}

// Variation selectors as bytes: U+FE00-FE0F are 0-15, U+E0100-E01EF 16-255 (or 0-239), or U+FE00-FE0F
// as nibble pairs (after a leading emoji selector or not); the reading with most letters, digits and
// spaces is the text.
function selectors(run: string): string {
	const v = [...run].map((c) => (cp(c) >= 0xe0100 ? cp(c) - 0xe0100 + 16 : cp(c) - 0xfe00));
	const nibbles = (n: number[]) =>
		n.some((x) => x > 15)
			? []
			: n.slice(0, n.length & ~1).flatMap((x, i) => (i % 2 ? [] : [x * 16 + (n[i + 1] ?? 0)]));
	const readings = [v, v.map((x) => (x > 15 ? x - 16 : x)), nibbles(v), nibbles(v.slice(1))];
	const texts = readings.map((bytes) => {
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
		} catch {
			return "";
		}
	});
	const score = (t: string) => t.replace(/[^A-Za-z\d ]/g, "").length;
	return texts.reduce((a, b) => (score(b) > score(a) ? b : a));
}

/**
 * The body without the invisible characters that can carry text, and one hidden entry per line and
 * kind: tag characters and variation selectors as the text they spell, zero-width characters as the
 * words they sit in with each named. Ordinary uses (see `ordinary`) stay. Each entry takes the location
 * of the last page, slide or sheet anchor above it.
 */
export function carriers(body: string[]): { body: string[]; entries: string[] } {
	const entries: string[] = [];
	let at = "";
	const lines = body.map((line, i) => {
		const anchor = /^\[(p\. \d+|slide \d+)\]$|^\[Sheet: [^\]]*\]$/.exec(line);
		if (anchor) at = `${anchor[1] ?? anchor[0]}, `;
		// A byte order mark that starts the text is an encoding mark.
		const bom = i === 0 && line.startsWith("﻿") ? "﻿" : "";
		const found = new Map<string, string[]>();
		const add = (kind: string, text: string) => found.set(kind, [...(found.get(kind) ?? []), text]);
		const words = line.slice(bom.length).split(/(\s+)/);
		const cleaned = words.map((word) => {
			let hit = false;
			const out = word.replace(CARRIER, (run, offset: number) => {
				const lead = word.slice(Math.max(0, offset - 2), offset);
				const before = /^[\uD800-\uDBFF][\uDC00-\uDFFF]$/.test(lead) ? lead : lead.slice(-1);
				const after = String.fromCodePoint(word.codePointAt(offset + run.length) ?? 0);
				if (ordinary(run, before, after)) return run;
				if (/[\u{E0000}-\u{E007F}]/u.test(run))
					add(
						"tag characters",
						[...run]
							.map((c) => (cp(c) > 0xe001f ? String.fromCodePoint(cp(c) - 0xe0000) : ""))
							.join(""),
					);
				else if (/\p{Variation_Selector}/u.test(run)) add("variation selectors", selectors(run));
				else hit = true;
				return "";
			});
			if (hit) add("zero-width characters", visible(word));
			return out;
		});
		for (const [kind, texts] of found) {
			const text = texts
				.join(" ")
				.replace(/[\p{Cc}\s]+/gu, " ")
				.trim();
			entries.push(`${at}${kind}: ${text || visible(line).trim()}`);
		}
		const result = bom + cleaned.join("");
		return result !== line && result === HIDDEN_BLOCK ? `${result} (written in the file)` : result;
	});
	return { body: lines, entries };
}
