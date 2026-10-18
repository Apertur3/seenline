import { HIDDEN_BLOCK } from "./hidden.ts";
import type { HiddenText } from "./types.ts";

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
// Values a program writes, not a person: numbers, dates, ids, booleans, placeholders, base64.
const MACHINE =
	/^(?:[\d\s.,:;/#|+-]*|true|false|nil|null|untitled|anonymous|unknown|unspecified|\{?[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\}?|0x[\da-f]+|\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-][\d:]+)?)$/i;
const BASE64 = /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z])(?:[A-Za-z\d+/=]{20,}\s*)+$/;
const NAME_FIELD = /^(?:Author|dc:creator|creator|lastModifiedBy|Company|Manager)$/;

/**
 * Whether a metadata value (a document property, a custom XML value) is worth listing: free text a
 * model could read. Machine values are not; a name field only when it is longer than a list of names.
 */
export function listedValue(field: string, value: string): boolean {
	const v = norm(value);
	if (MACHINE.test(v) || BASE64.test(v)) return false;
	return !NAME_FIELD.test(field) || v.split(" ").length > 8;
}

/**
 * The hidden entries worth listing under a body. An entry is left out when it holds no text, or when
 * its text is already in the visible body or in an earlier entry: a reader sees it there.
 */
export function unseen(body: string[], hidden: string[]): string[] {
	const seen = norm(body.join(" "));
	const listed = new Set<string>();
	return hidden.filter((line) => {
		const text = norm(parseHidden([line])[0]?.text ?? "");
		if (!text || listed.has(text) || seen.includes(text)) return false;
		listed.add(text);
		return true;
	});
}

/** Preserve every hidden line, including opaque OCR extras and legacy conversion warnings. */
export function parseHidden(lines: string[]): HiddenText[] {
	return lines
		.filter((line) => line && line !== HIDDEN_BLOCK)
		.map((line) => {
			const location =
				/^(p\. \d+|slide \d+(?:, notes)?|\[Sheet: [^\]]*\](?:, \[row \d+\], [A-Z]+\d+)?), /;
			const at = location.exec(line);
			const rest = at ? line.slice(at[0].length) : line;
			// A reason delimiter is a colon followed by a space; colons in metadata names stay intact.
			const colon = rest.indexOf(": ");
			let reason = colon < 0 ? rest : rest.slice(0, colon);
			if (at?.[1]?.startsWith("p. ")) reason = reason.replace(/ text$/, "");
			const labelled =
				at ||
				/^(?:hidden run|tiny text|white or same-background text|tracked deletion|HTML\b|Mail\b|metadata\b|image\b|attachment\b|javascript\b|docProps\/|customXml\/|.*comments?\d*\.xml\b|Legacy conversion\b)/.test(
					reason,
				);
			return {
				anchor: at?.[1] ?? "",
				reasons: labelled ? reason.split(" and ") : ["hidden content"],
				text: labelled && colon >= 0 ? rest.slice(colon + 2) : rest,
			};
		});
}
