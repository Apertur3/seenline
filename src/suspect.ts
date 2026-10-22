// A triage signal, not a verdict: whether hidden text reads like an instruction to an AI.
// Deterministic rules from suspect.json; explicit instructions only, so hidden keyword lists and
// fabricated facts (data injection) are never tagged.
import data from "./suspect.json" with { type: "json" };

const GAP = "[^\\w.!?;]+(?:[\\w'’-]+[^\\w.!?;]+){0,5}";
const RULES = Object.entries(data.rules).flatMap(([reason, sources]) =>
	sources.map((s) => [reason, new RegExp(s.replaceAll(" ~ ", GAP), "u")] as const),
);
const LOOKALIKE: Record<string, string> = data.lookalikes;
const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t" };

/** Text as a model would read it: tag characters decoded, invisibles, accents, lookalikes, leet and letter spacing undone. */
export function normal(text: string): string {
	return text
		.replace(/[\u{E0020}-\u{E007E}]/gu, (c) =>
			String.fromCodePoint((c.codePointAt(0) ?? 0) - 0xe0000),
		)
		.normalize("NFKD")
		.replace(/[\p{Cf}\p{M}\p{Variation_Selector}]/gu, "")
		.toLowerCase()
		.replace(/\p{L}/gu, (c) => LOOKALIKE[c] ?? c)
		.replace(/\b(?=[a-z]*\d)(?=\d*[a-z])[a-z\d]+\b/g, (w) =>
			w.replace(/[013457]/g, (d) => LEET[d] ?? d),
		)
		.replace(/\b(?:\p{L}[ .*_·-](?=\p{L}\b)){2,}\p{L}\b/gu, (run) => run.replace(/[^\p{L}]/gu, ""))
		.replace(/[\s_*]+/g, " ");
}

/** The reason class when hidden text reads like an instruction to an AI, else null. */
export function suspect(text: string): string | null {
	const t = normal(text);
	return RULES.find(([, pattern]) => pattern.test(t))?.[0] ?? null;
}
