import type { OfficeText } from "./office-word.ts";
import { all, attr, children, first, flat, part, related, text, type Xml } from "./office-xml.ts";

export const MAX_ROWS = 5000;
const yes = (s: string | undefined) => s === "1" || s === "true";
const col = (ref: string) =>
	[...ref.replace(/\d/g, "")].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);

function fontHidden(font: Xml | undefined): string[] {
	if (!font) return [];
	const why: string[] = [];
	if (Number(attr(first(font, "sz"), "val") ?? 11) < 2) why.push("tiny text");
	const color = first(font, "color");
	if (
		/^(FF)?FFFFFF$/i.test(attr(color, "rgb") ?? "") ||
		attr(color, "indexed") === "9" ||
		attr(color, "theme") === "0"
	)
		why.push("white text");
	return why;
}

function cellValue(c: Xml, shared: Xml[]): string {
	const value = first(c, "v");
	if (c.attrs.t === "s") {
		const s = shared[Number(value ? text(value) : -1)];
		if (!s) throw new Error("shared string missing");
		return all(s, "t").map(text).join("");
	}
	if (c.attrs.t === "inlineStr") return all(c, "t").map(text).join("");
	if (first(c, "f") && !value) throw new Error("formula has no cached value");
	return value ? text(value) : "";
}

function sheetRows(
	sheet: Xml,
	label: string,
	why: string[],
	shared: Xml[],
	fonts: Xml[],
	formats: Xml[],
	out: OfficeText,
	maxRows: number,
): void {
	const columns = all(sheet, "col").filter((c) => yes(c.attrs.hidden));
	const rows = all(sheet, "row");
	for (const [i, row] of rows.slice(0, maxRows).entries()) {
		const number = row.attrs.r ?? String(i + 1);
		const rowWhy = [...why, ...(yes(row.attrs.hidden) ? ["hidden row"] : [])];
		const values: string[] = [];
		const cells = children(row, "c");
		for (const [j, c] of cells.entries()) {
			const ref = c.attrs.r ?? `A${number}`;
			const column = c.attrs.r ? col(ref) : j + 1;
			if (column < 1 || column > 16384) throw new Error("cell column");
			const format = formats[Number(c.attrs.s ?? row.attrs.s ?? 0)];
			const font = fonts[Number(format?.attrs.fontId ?? 0)];
			const reasons = [...rowWhy, ...fontHidden(font)];
			const rich = c.attrs.t === "s" ? shared[Number(text(first(c, "v") ?? c))] : c;
			if (rich) for (const r of all(rich, "rPr")) reasons.push(...fontHidden(r));
			if (columns.some((v) => column >= Number(v.attrs.min) && column <= Number(v.attrs.max)))
				reasons.push("hidden column");
			const value = flat(cellValue(c, shared));
			while (values.length < column) values.push("");
			if (value && reasons.length)
				out.hidden.push(
					`${label}, [row ${number}], ${ref}, ${[...new Set(reasons)].join(" and ")}: ${value}`,
				);
			else values[column - 1] = value;
		}
		if (!rowWhy.length) out.body.push(`[row ${number}]`, values.join(" | "));
	}
	if (rows.length > maxRows) out.body.push(`[truncated: first ${maxRows} rows only]`);
}

export function sheets(parts: Map<string, Xml>, maxRows = MAX_ROWS): OfficeText {
	const out: OfficeText = { body: [], hidden: [] };
	const book = part(parts, "xl/workbook.xml");
	const rels = related(parts, "xl/workbook.xml");
	const ss = parts.get("xl/sharedStrings.xml"),
		styles = parts.get("xl/styles.xml");
	const shared = ss ? children(ss, "si") : [];
	const fonts = styles ? children(first(styles, "fonts") ?? styles, "font") : [];
	const formats = styles ? children(first(styles, "cellXfs") ?? styles, "xf") : [];
	const list = all(book, "sheet");
	if (!list.length || list.length > 300) throw new Error("sheet count");
	out.pages = list.length;
	for (const s of list) {
		const path = rels.get(s.attrs["r:id"] ?? "");
		if (!path) throw new Error("sheet relationship");
		const label = `[Sheet: ${flat(s.attrs.name ?? "")}]`;
		const why = s.attrs.state && s.attrs.state !== "visible" ? ["hidden sheet"] : [];
		out.body.push(label);
		sheetRows(part(parts, path), label, why, shared, fonts, formats, out, maxRows);
	}
	return out;
}
