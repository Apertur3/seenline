import type { OfficeText } from "./office-word.ts";
import {
	all,
	attr,
	children,
	first,
	flat,
	local,
	nodes,
	part,
	related,
	text,
	type Xml,
} from "./office-xml.ts";

function runReason(run: Xml, shape: Xml): string[] {
	const props = first(run, "rPr");
	const defaults = first(shape, "defRPr");
	const why: string[] = [];
	if (Number(attr(props, "sz") ?? attr(defaults, "sz") ?? 1200) < 200) why.push("tiny text");
	const fill = (props && first(props, "solidFill")) ?? (defaults && first(defaults, "solidFill"));
	const color = fill && first(fill, "srgbClr");
	const scheme = fill && first(fill, "schemeClr");
	if (
		attr(color, "val")?.toUpperCase() === "FFFFFF" ||
		["lt1", "bg1"].includes(attr(scheme, "val") ?? "")
	)
		why.push("white text");
	return why;
}

function shapeReasons(shape: Xml, width: number, height: number): string[] {
	const why: string[] = [];
	const nv = first(shape, "cNvPr");
	if (["1", "true"].includes(attr(nv, "hidden") ?? "")) why.push("hidden shape");
	const off = first(shape, "off");
	const ext = first(shape, "ext");
	const x = Number(attr(off, "x") ?? 0),
		y = Number(attr(off, "y") ?? 0);
	if (
		x < 0 ||
		y < 0 ||
		x >= width ||
		y >= height ||
		x + Number(attr(ext, "cx") ?? 0) > width ||
		y + Number(attr(ext, "cy") ?? 0) > height
	)
		why.push("off-slide shape");
	return why;
}

function shapeText(shape: Xml, why: string[], hidden: string[], label: string): string[] {
	const para = (p: Xml) => {
		let value = "";
		for (const r of nodes(p)) {
			if (!["r", "fld"].includes(local(r) ?? "")) continue;
			const s = all(r, "t").map(text).join("");
			const reasons = [...why, ...runReason(r, shape)];
			if (s && reasons.length) hidden.push(`${label}, ${reasons.join(" and ")}: ${flat(s)}`);
			else value += s;
		}
		return flat(value);
	};
	const table = first(shape, "tbl");
	if (table)
		return children(table, "tr").map((row) =>
			children(row, "tc")
				.map((cell) => all(cell, "p").map(para).filter(Boolean).join(" "))
				.join(" | "),
		);
	return all(shape, "p").map(para).filter(Boolean);
}

function readSlide(
	slide: Xml,
	label: string,
	why: string[],
	size: number[],
	out: OfficeText,
): void {
	const tree = first(slide, "spTree");
	if (!tree) throw new Error("slide tree missing");
	const shapes = nodes(tree).filter((s) =>
		["sp", "graphicFrame", "grpSp", "cxnSp"].includes(local(s) ?? ""),
	);
	shapes.sort(
		(a, b) =>
			Number(["title", "ctrTitle"].includes(attr(first(b, "ph"), "type") ?? "")) -
			Number(["title", "ctrTitle"].includes(attr(first(a, "ph"), "type") ?? "")),
	);
	for (const shape of shapes)
		out.body.push(
			...shapeText(
				shape,
				[...why, ...shapeReasons(shape, size[0] as number, size[1] as number)],
				out.hidden,
				label,
			),
		);
}

export function slides(parts: Map<string, Xml>): OfficeText {
	const out: OfficeText = { body: [], hidden: [] };
	const presentation = part(parts, "ppt/presentation.xml");
	const size = first(presentation, "sldSz");
	const bounds = [Number(attr(size, "cx") ?? 9144000), Number(attr(size, "cy") ?? 6858000)];
	const rels = related(parts, "ppt/presentation.xml");
	const ids = all(presentation, "sldId");
	if (!ids.length || ids.length > 300) throw new Error("slide count");
	out.pages = ids.length;
	for (const [i, id] of ids.entries()) {
		const path = rels.get(id.attrs["r:id"] ?? "");
		if (!path) throw new Error("slide relationship");
		const slide = part(parts, path);
		const label = `slide ${i + 1}`;
		out.body.push(`[${label}]`);
		const why = ["0", "false"].includes(attr(slide, "show") ?? "") ? ["hidden slide"] : [];
		readSlide(slide, label, why, bounds, out);
		for (const note of related(parts, path).values()) {
			if (!/\/notesSlides\//.test(note)) continue;
			out.body.push("Notes");
			const notes = part(parts, note);
			for (const shape of all(notes, "sp")) {
				if (
					["sldImg", "sldNum", "hdr", "ftr", "dt"].includes(attr(first(shape, "ph"), "type") ?? "")
				)
					continue;
				out.body.push(...shapeText(shape, why, out.hidden, `${label}, notes`));
			}
		}
	}
	return out;
}
