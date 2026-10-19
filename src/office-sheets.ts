import { light, mix } from "./colour.ts";
import type { OfficeText } from "./office-word.ts";
import {
	all,
	attr,
	children,
	first,
	flat,
	part,
	related,
	text,
	themeColours,
	type Xml,
} from "./office-xml.ts";

export const MAX_ROWS = 5000;
const yes = (s: string | undefined) => s === "1" || s === "true";
const col = (ref: string) =>
	[...ref.replace(/\d/g, "")].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);

// White text is hidden on a light fill (or none); on a dark fill a reader sees it.
function fontHidden(font: Xml | undefined, ground?: string): string[] {
	if (!font) return [];
	const why: string[] = [];
	if (Number(attr(first(font, "sz"), "val") ?? 11) < 2) why.push("tiny text");
	const color = first(font, "color");
	if (
		(/^(FF)?FFFFFF$/i.test(attr(color, "rgb") ?? "") ||
			attr(color, "indexed") === "9" ||
			attr(color, "theme") === "0") &&
		light(ground)
	)
		why.push("white text");
	return why;
}

// Theme colour indices as Excel numbers them: the light and dark pairs are swapped.
const THEME = "lt1 dk1 lt2 dk2 accent1 accent2 accent3 accent4 accent5 accent6 hlink folHlink";
const INDEXED: Record<string, string> = { "8": "000000", "9": "FFFFFF", "64": "000000" };

/** A cell format's solid fill as RRGGBB ("" when its colour is unknown), or undefined for none. */
function filler(parts: Map<string, Xml>, styles: Xml | undefined) {
	const theme = [...related(parts, "xl/workbook.xml").values()].find((p) => p.includes("/theme/"));
	const named = themeColours(theme ? parts.get(theme) : undefined);
	const fills = styles ? children(first(styles, "fills") ?? styles, "fill") : [];
	return (format: Xml | undefined): string | undefined => {
		const fill = fills[Number(format?.attrs.fillId ?? 0)];
		if (fill && first(fill, "gradientFill")) return "";
		const pattern = fill && first(fill, "patternFill");
		if (!pattern || ["none", undefined].includes(pattern.attrs.patternType)) return undefined;
		const c = first(pattern, "fgColor");
		const hex =
			c?.attrs.rgb?.slice(-6) ??
			named.get(THEME.split(" ")[Number(c?.attrs.theme ?? -1)] ?? "") ??
			INDEXED[c?.attrs.indexed ?? ""];
		const t = Number(c?.attrs.tint ?? 0);
		if (!hex || !/^[\da-f]{6}$/i.test(hex)) return "";
		return mix(hex, (x) => (t < 0 ? x * (1 + t) : x + (255 - x) * t));
	};
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
	[fonts, formats, fill]: [Xml[], Xml[], ReturnType<typeof filler>],
	out: OfficeText,
	maxRows: number,
): void {
	const columns = all(sheet, "col").filter((c) => yes(c.attrs.hidden));
	const dynamic = all(sheet, "conditionalFormatting").length > 0;
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
			// Conditional formats can repaint any cell; on such a sheet no fill counts as ground.
			const ground = dynamic ? undefined : fill(format);
			const reasons = [...rowWhy, ...fontHidden(font, ground)];
			const rich = c.attrs.t === "s" ? shared[Number(text(first(c, "v") ?? c))] : c;
			if (rich) for (const r of all(rich, "rPr")) reasons.push(...fontHidden(r, ground));
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
		const style: [Xml[], Xml[], ReturnType<typeof filler>] = [
			fonts,
			formats,
			filler(parts, styles),
		];
		sheetRows(part(parts, path), label, why, shared, style, out, maxRows);
	}
	return out;
}
