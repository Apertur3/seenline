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
