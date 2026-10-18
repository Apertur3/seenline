import { HIDDEN_BLOCK } from "./hidden.ts";
import type { HiddenText } from "./types.ts";

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
