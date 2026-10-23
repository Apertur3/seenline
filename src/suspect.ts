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
			.replace(/\b(?:\p{L}[\t .*_·,:/|+~-](?=\p{L}\b))+\p{L}\b/gu, (run) =>
				run.replace(/[^\p{L}]/gu, ""),
			)
			.replace(/[\s_*]+/g, " ")
	);
}

/** The reason class when hidden text reads like an instruction to an AI, else null. */
export function suspect(text: string): string | null {
	// A format character inside a word hides it; between words it stands for a space: read both ways.
	const forms = [
		normal(text),
		...(/\p{Cf}/u.test(text) ? [normal(text.replace(/\p{Cf}/gu, " "))] : []),
	];
	return RULES.find(([, pattern]) => forms.some((t) => pattern.test(t)))?.[0] ?? null;
}
