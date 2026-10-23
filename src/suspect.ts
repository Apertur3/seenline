// A triage signal, not a verdict: whether hidden text reads like an instruction to an AI.
// Deterministic rules from suspect.json; explicit instructions only, so hidden keyword lists and
// fabricated facts (data injection) are never tagged.
import data from "./suspect.json" with { type: "json" };

// A gap of up to n words within one sentence; a dot or ? inside a word (a link, an address) joins it.
const gap = (n: number) => `[^\\w.!?;]+(?:[\\w'’-]+(?:[.?][\\w'’-]+)*[^\\w.!?;]+){0,${n}}`;
const PARTS: Record<string, string> = data.parts;
// A <NAME> stands for a part, which may hold parts itself; an unknown name fails at load.
const expand = (s: string): string =>
	s
		.replace(/<([A-Z]+)>/g, (_, k: string) => expand(PARTS[k] as string))
		.replaceAll(" ~~ ", gap(12))
		.replaceAll(" ~ ", gap(5));
const RULES = data.rules.flatMap(({ reason, patterns }) =>
	patterns.map((s) => [reason, new RegExp(expand(s), "u")] as const),
);
const SQUASHED = data.squashed.map(
	({ reason, patterns }) => [reason, new RegExp(patterns.join("|"), "gu")] as const,
);
// Words run together (glyphs joined without a gap, letters spaced one per space): each run
// without spaces that is mostly letters, read as its letters only.
const runs = (t: string) =>
	t.split(" ").flatMap((r) => {
		const letters = r.replace(/[^\p{L}]/gu, "");
		return letters.length >= 16 && letters.length * 5 >= r.length * 4 ? [letters] : [];
	});
const LOOKALIKE: Record<string, string> = data.lookalikes;
const LEET: Record<string, string> = {
	"0": "o",
	"1": "i",
	"3": "e",
	"4": "a",
	"5": "s",
	"7": "t",
	"8": "b",
	"9": "g",
	"@": "a",
	$: "s",
};

/** Text as a model would read it: tag characters decoded, invisibles, accents, lookalikes, leet and letter spacing undone. */
export function normal(text: string): string {
	return (
		text
			.replace(/[\u{E0020}-\u{E007E}]/gu, (c) =>
				String.fromCodePoint((c.codePointAt(0) ?? 0) - 0xe0000),
			)
			.normalize("NFKD")
			.replace(/[\p{Cf}\p{M}\p{Variation_Selector}]/gu, "")
			.toLowerCase()
			.replace(/[‘’ʼ]/g, "'")
			.replace(/\p{L}/gu, (c) => LOOKALIKE[c] ?? c)
			// @ and $ for letters, at a word start or inside a word, but not the @ of an email address.
			.replace(/(?<![\w@$])[@$]+(?=[a-z])|(?<=[a-z])(?:\$|@(?![a-z\d-]*\.[a-z]))+(?=[a-z])/g, (m) =>
				[...m].map((c) => LEET[c] ?? c).join(""),
			)
			.replace(/\b(?=[a-z]*\d)(?=\d*[a-z])[a-z\d]+\b/g, (w) =>
				w.replace(/[01345789]/g, (d) => LEET[d] ?? d),
			)
			// Single letters with one separator, the same one throughout; the separator doubled before
			// the next spaced word stands for a space.
			.replace(
				/(?<![\p{L}\d])\p{L}([\t .*_·,:/|+~-])\p{L}(?:\1\p{L})*(?![\p{L}\d])(\1+(?=\p{L}\1\p{L}))?/gu,
				(run, _sep, gap) => run.replace(/[^\p{L}]/gu, "") + (gap ? " " : ""),
			)
			.replace(/[\s_*]+/g, " ")
	);
}

/** The reason class when hidden text reads like an instruction to an AI, else null. */
export function suspect(text: string): string | null {
	// A format character inside a word hides it; between words it stands for a space: read both ways.
	const read = (t: string) => [
		normal(t),
		...(/\p{Cf}/u.test(t) ? [normal(t.replace(/\p{Cf}/gu, " "))] : []),
	];
	const forms = read(text);
	const rule = RULES.find(([, pattern]) => forms.some((f) => pattern.test(f)))?.[0];
	if (rule) return rule;
	// Without word boundaries short phrases match by chance: a signature phrase of 16 letters or more.
	// A camelCase word is a code name (printPasswordHash), not words run together.
	const plain = text.split(/\s+/).filter((w) => !/\p{Ll}{2}\p{Lu}\p{Ll}{2}/u.test(w));
	const squashed = read(plain.join(" ")).flatMap(runs);
	return (
		SQUASHED.find(([, re]) =>
			squashed.some((s) => s.matchAll(re).some((m) => m[0].length >= 16)),
		)?.[0] ?? null
	);
}
