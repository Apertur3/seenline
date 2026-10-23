import { light } from "./colour.ts";
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
	themeColours,
	type Xml,
} from "./office-xml.ts";

type Box = [number, number, number, number];
/** Something drawn on a slide: where, and the RRGGBB colour it fills with (undefined: no fill). */
interface Layer {
	box: Box;
	fill: string | undefined;
}
type Paint = (fill: Xml | undefined) => string | undefined;
const NONE: Xml = { name: "", attrs: {}, children: [] };

function box(shape: Xml): Box {
	const xf = first(shape, "xfrm");
	const off = xf && first(xf, "off");
	const ext = xf && first(xf, "ext");
	const x = Number(attr(off, "x") ?? 0);
	const y = Number(attr(off, "y") ?? 0);
	return [x, y, x + Number(attr(ext, "cx") ?? 0), y + Number(attr(ext, "cy") ?? 0)];
}

// A shape's own fill, else the fill its style refers to; a picture is its image.
function fillOf(shape: Xml): Xml | undefined {
	// A picture, a group or a table or chart: what it paints is not worked out, so it is unknown.
	if (["pic", "grpSp", "graphicFrame"].includes(local(shape) ?? "")) return NONE;
	const own = ownFill(children(shape, "spPr")[0]);
	if (own !== null) return own;
	const ref = first(children(shape, "style")[0] ?? NONE, "fillRef");
	return Number(attr(ref, "idx") ?? 0) > 0 ? ref : undefined;
}
// null when the properties say nothing about a fill.
function ownFill(pr: Xml | undefined): Xml | undefined | null {
	const f = pr && nodes(pr).find((c) => /Fill$/.test(local(c) ?? ""));
	return f ? (local(f) === "noFill" ? undefined : f) : null;
}

// Scheme colours through the master's colour map and theme. A colour changed by a modifier (lighter,
// darker, see-through) is unknown here: "", which counts as light, so white text on it stays flagged.
function painter(parts: Map<string, Xml>, master?: string, theme?: string): Paint {
	const m = master ? parts.get(master) : undefined;
	const map = (m && first(m, "clrMap")?.attrs) ?? {};
	const named = themeColours(theme ? parts.get(theme) : undefined);
	const colour = (c: Xml): string => {
		const v = attr(c, "val") ?? "";
		if (nodes(c).length) return "";
		if (local(c) === "schemeClr") return named.get(map[v] ?? v) ?? "";
		return (local(c) === "srgbClr" ? v : c.attrs.lastClr) ?? "";
	};
	const paint: Paint = (fill) => {
		const kind = local(fill ?? NONE);
		if (!fill || kind === "noFill") return undefined;
		if (kind === "bgPr") return paint(ownFill(fill) ?? undefined);
		// A picture, a gradient or a pattern is unknown too: its colour under the letters is not read.
		const c = nodes(fill).find((x) => /Clr$/.test(local(x) ?? ""));
		return c && ["solidFill", "fillRef", "bgRef"].includes(kind ?? "") ? colour(c) : "";
	};
	return paint;
}

// What is painted under the slide's own shapes: the first background of slide, layout, master,
// then the master's and the layout's drawings (their placeholders are not drawn on the slide).
function under(
	[slide, layout, master]: (Xml | undefined)[],
	size: number[],
	paint: Paint,
): Layer[] {
	const bg = [slide, layout, master].map((x) => x && first(x, "bg")).find(Boolean);
	const ground = bg && (children(bg, "bgPr")[0] ?? children(bg, "bgRef")[0]);
	const drawn = [master, layout]
		.flatMap((x) => nodes((x && first(x, "spTree")) ?? NONE))
		.filter((s) => !first(s, "ph"))
		.map((s) => ({ box: box(s), fill: paint(fillOf(s)) }));
	return [{ box: [0, 0, size[0] ?? 0, size[1] ?? 0], fill: paint(ground) ?? "FFFFFF" }, ...drawn];
}

// White text is hidden on a light ground (or none); on a dark fill or a picture a reader sees it.
function runReason(run: Xml, shape: Xml, ground: string | undefined): string[] {
	const props = first(run, "rPr");
	const defaults = first(shape, "defRPr");
	const why: string[] = [];
	// Shrink on overflow scales every run of the shape (fontScale in thousandths of a percent).
	const scale = Number(attr(first(shape, "normAutofit"), "fontScale") ?? 100000) / 100000;
	if (Number(attr(props, "sz") ?? attr(defaults, "sz") ?? 1200) * scale < 200)
		why.push("tiny text");
	const fill = (props && first(props, "solidFill")) ?? (defaults && first(defaults, "solidFill"));
	const color = fill && first(fill, "srgbClr");
	const scheme = fill && first(fill, "schemeClr");
	// A colour under 10% opaque, or no fill and no outline: the letters are not drawn.
	const alpha = attr(fill && first(fill, "alpha"), "val") ?? "100000";
	const opaque = alpha.endsWith("%") ? Number.parseFloat(alpha) * 1000 : Number(alpha);
	const bare = props && children(props, "noFill").length > 0 && !first(props, "ln");
	if (opaque < 10000 || bare) why.push("transparent text");
	if (
		(attr(color, "val")?.toUpperCase() === "FFFFFF" ||
			["lt1", "bg1"].includes(attr(scheme, "val") ?? "")) &&
		light(ground)
	)
		why.push("white text");
	return why;
}

function shapeReasons(shape: Xml, width: number, height: number): string[] {
	const why: string[] = [];
	const nv = first(shape, "cNvPr");
	if (["1", "true"].includes(attr(nv, "hidden") ?? "")) why.push("hidden shape");
	const [x0, y0, x1, y1] = box(shape);
	const on = (lo: number, hi: number, max: number) =>
		Math.max(0, Math.min(hi, max) - Math.max(lo, 0));
	// Off the slide: it starts well outside it, or less than half of it is on it.
	if (
		x0 < -width / 10 ||
		y0 < -height / 10 ||
		x0 >= width ||
		y0 >= height ||
		on(x0, x1, width) * on(y0, y1, height) < ((x1 - x0) * (y1 - y0)) / 2
	)
		why.push("off-slide shape");
	return why;
}

function shapeText(
	shape: Xml,
	why: string[],
	hidden: string[],
	label: string,
	ground?: string,
	paint?: Paint,
): string[] {
	const para = (p: Xml, behind = ground) => {
		let value = "";
		for (const r of nodes(p)) {
			if (!["r", "fld"].includes(local(r) ?? "")) continue;
			const s = all(r, "t").map(text).join("");
			const reasons = [...why, ...runReason(r, shape, behind)];
			if (s && reasons.length) hidden.push(`${label}, ${reasons.join(" and ")}: ${flat(s)}`);
			else value += s;
		}
		return flat(value);
	};
	const table = first(shape, "tbl");
	if (table)
		return children(table, "tr").map((row) =>
			children(row, "tc")
				.map((cell) => {
					const fill = paint?.(ownFill(children(cell, "tcPr")[0]) ?? undefined) ?? ground;
					return all(cell, "p")
						.map((p) => para(p, fill))
						.filter(Boolean)
						.join(" ");
				})
				.join(" | "),
		);
	return all(shape, "p")
		.map((p) => para(p))
		.filter(Boolean);
}

function readSlide(
	slide: Xml,
	label: string,
	why: string[],
	[size, base, paint]: [number[], Layer[], Paint],
	out: OfficeText,
): void {
	const tree = first(slide, "spTree");
	if (!tree) throw new Error("slide tree missing");
	// The ground of each shape: the last fill drawn, up to and including the shape, under its middle.
	const layers = [...base];
	const ground = new Map<Xml, string | undefined>();
	for (const s of nodes(tree)) {
		layers.push({ box: box(s), fill: paint(fillOf(s)) });
		const [x0, y0, x1, y1] = box(s);
		const [x, y] = [(x0 + x1) / 2, (y0 + y1) / 2];
		const hit = layers.findLast(
			(l) =>
				l.fill !== undefined && x >= l.box[0] && x <= l.box[2] && y >= l.box[1] && y <= l.box[3],
		);
		ground.set(s, hit?.fill);
	}
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
				ground.get(shape),
				paint,
			),
		);
}

export function slides(parts: Map<string, Xml>): OfficeText {
	const out: OfficeText = { body: [], hidden: [] };
	const presentation = part(parts, "ppt/presentation.xml");
	const size = first(presentation, "sldSz");
	const bounds = [Number(attr(size, "cx") ?? 9144000), Number(attr(size, "cy") ?? 6858000)];
	const rels = related(parts, "ppt/presentation.xml");
	// Only the slide list: PowerPoint sections (p14:sectionLst) list the same slides again.
	const ids = children(presentation, "sldIdLst").flatMap((l) => children(l, "sldId"));
	if (!ids.length || ids.length > 300) throw new Error("slide count");
	out.pages = ids.length;
	for (const [i, id] of ids.entries()) {
		const path = rels.get(id.attrs["r:id"] ?? "");
		if (!path) throw new Error("slide relationship");
		const slide = part(parts, path);
		const label = `slide ${i + 1}`;
		out.body.push(`[${label}]`);
		const why = ["0", "false"].includes(attr(slide, "show") ?? "") ? ["hidden slide"] : [];
		const linked = (from: string | undefined, kind: string) =>
			from ? [...related(parts, from).values()].find((p) => p.includes(kind)) : undefined;
		const layout = linked(path, "/slideLayouts/");
		const master = linked(layout, "/slideMasters/");
		const paint = painter(parts, master, linked(master, "/theme/"));
		const base = under(
			[slide, ...[layout, master].map((p) => (p ? parts.get(p) : undefined))],
			bounds,
			paint,
		);
		readSlide(slide, label, why, [bounds, base, paint], out);
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
