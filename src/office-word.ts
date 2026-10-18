import { light } from "./colour.ts";
import {
	all,
	attr,
	children,
	first,
	flat,
	local,
	nodes,
	part,
	text,
	type Xml,
} from "./office-xml.ts";

export interface OfficeText {
	pages?: number;
	body: string[];
	hidden: string[];
}
const on = (n: Xml | undefined) => !!n && !["0", "false", "off"].includes(attr(n, "val") ?? "");

function properties(n: Xml | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (!n) return out;
	for (const c of nodes(n)) out[local(c) as string] = attr(c, "val") ?? "true";
	const shade = shading(n);
	if (shade !== undefined) out.background = shade;
	return out;
}

// A shading's colour: a solid pattern shows its pattern colour, any other pattern its fill.
function shading(n: Xml | undefined): string | undefined {
	const s = n && first(n, "shd");
	return s && (attr(s, "val") === "solid" ? attr(s, "color") : attr(s, "fill"));
}

function styles(parts: Map<string, Xml>) {
	const source = parts.get("word/styles.xml");
	const defs = new Map((source ? all(source, "style") : []).map((s) => [attr(s, "styleId"), s]));
	const runDefault = source && first(source, "rPrDefault");
	const defaults = properties(runDefault ? first(runDefault, "rPr") : undefined);
	const defaultId = [...defs].find(
		([, n]) => attr(n, "type") === "paragraph" && ["1", "true"].includes(attr(n, "default") ?? ""),
	)?.[0];
	const resolve = (id: string | undefined, seen = new Set<string>()): Record<string, string> => {
		if (!id) return {};
		if (seen.has(id) || seen.size > 30) throw new Error("style cycle");
		seen.add(id);
		const s = defs.get(id);
		if (!s) return {};
		return {
			...resolve(attr(first(s, "basedOn"), "val"), seen),
			...properties(first(s, "rPr")),
			...properties(first(s, "pPr")),
		};
	};
	// A table style's cell shading, for the whole table or for one of its conditional parts.
	const tableFill = (id: string | undefined, kind?: string) => {
		const s = defs.get(id);
		const at = kind ? s && children(s, "tblStylePr").find((t) => attr(t, "type") === kind) : s;
		return shading(at && children(at, "tcPr")[0]);
	};
	return { defaults, resolve, defaultId, tableFill };
}

function reason(p: Record<string, string>): string[] {
	const why: string[] = [];
	// webHidden hides a run in Web Layout only; the page a reader prints or reads shows it.
	if (p.vanish && !["0", "false", "off"].includes(p.vanish)) why.push("hidden run");
	if ([p.sz, p.szCs].some((size) => size !== undefined && Number(size) < 4)) why.push("tiny text");
	// What is behind the letters: the shading, else a white page.
	const ground = (p.background ?? "").replace(/^auto$/i, "").toUpperCase() || "FFFFFF";
	const color = p.color?.toUpperCase();
	if (color && color !== "AUTO" && (color === ground || (color === "FFFFFF" && light(ground))))
		why.push("white or same-background text");
	return why;
}

function makeParagraph(style: ReturnType<typeof styles>, hidden: string[], background: string) {
	return (p: Xml, inherited = background): string => {
		const pp = children(p, "pPr")[0];
		const id = attr(pp ? first(pp, "pStyle") : undefined, "val") ?? style.defaultId;
		const base: Record<string, string> = {
			background: inherited,
			...style.defaults,
			...style.resolve(id),
			...properties(pp),
		};
		const visible: string[] = [];
		readRuns(p, base, style.resolve, hidden, visible);
		const value = flat(visible.join(""));
		if (!value) return "";
		const level = attr(pp ? first(pp, "outlineLvl") : undefined, "val") ?? base.outlineLvl;
		const heading =
			level !== undefined
				? Number(level) + 1
				: Number(/heading\s*([1-6])/i.exec(id ?? "")?.[1] ?? 0);
		if (heading > 0 && heading <= 6) return `${"#".repeat(heading)} ${value}`;
		return `${pp && first(pp, "numPr") ? "- " : ""}${value}`;
	};
}

export function word(parts: Map<string, Xml>): OfficeText {
	const out: OfficeText = { body: [], hidden: [] };
	const style = styles(parts);
	const document = part(parts, "word/document.xml");
	const background = attr(first(document, "background"), "color") ?? "";
	const paragraph = makeParagraph(style, out.hidden, background);
	const blocks = (n: Xml, target: string[]) => {
		for (const c of nodes(n)) {
			if (local(c) === "p") target.push(paragraph(c));
			else if (local(c) === "tbl") {
				// A cell's ground: its shading, else its style's header-row shading (where the table turns
				// the header row on), else the table's, else its style's, else the page's.
				const pr = children(c, "tblPr")[0];
				const id = attr(pr && first(pr, "tblStyle"), "val");
				const look = pr && first(pr, "tblLook");
				const bits = Number.parseInt(attr(look, "val") ?? "0", 16) & 0x20;
				const header = (attr(look, "firstRow") ?? (bits ? "1" : "0")) === "1";
				const ground = shading(pr) ?? style.tableFill(id) ?? background;
				for (const [i, row] of children(c, "tr").entries())
					target.push(
						children(row, "tc")
							.map((cell) => {
								const top = i === 0 && header ? style.tableFill(id, "firstRow") : undefined;
								const fill = shading(children(cell, "tcPr")[0]) ?? top ?? ground;
								return all(cell, "p")
									.map((p) => paragraph(p, fill))
									.filter(Boolean)
									.join(" ");
							})
							.join(" | "),
					);
			} else blocks(c, target);
		}
	};
	blocks(document, out.body);
	for (const kind of ["footnotes", "endnotes"]) {
		const notes = parts.get(`word/${kind}.xml`);
		if (!notes) continue;
		out.body.push(kind === "footnotes" ? "Footnotes" : "Endnotes");
		for (const note of nodes(notes)) {
			if (Number(attr(note, "id")) < 0) continue;
			blocks(note, out.body);
		}
	}
	return out;
}

function readRuns(
	n: Xml,
	base: Record<string, string>,
	resolve: (id: string | undefined) => Record<string, string>,
	hidden: string[],
	visible: string[],
	deleted = false,
): void {
	for (const c of nodes(n)) {
		const kind = local(c);
		if (kind === "pPr" || kind === "rPr") continue;
		if (kind === "r") {
			const rp = children(c, "rPr")[0];
			const props = {
				...base,
				...resolve(attr(rp ? first(rp, "rStyle") : undefined, "val")),
				...properties(rp),
			};
			const why = reason(props);
			if (deleted) why.push("tracked deletion");
			// A field instruction (instrText) is code Word runs, never text it shows: it is left out.
			const value = nodes(c)
				.map((v) =>
					["t", "delText"].includes(local(v) ?? "")
						? text(v)
						: local(v) === "tab"
							? "\t"
							: local(v) === "br"
								? " "
								: "",
				)
				.join("");
			if (value && why.length) hidden.push(`${why.join(" and ")}: ${flat(value)}`);
			else visible.push(value);
		} else if (kind === "del" || kind === "moveFrom")
			readRuns(c, base, resolve, hidden, visible, true);
		else if (kind === "vanish" && on(c)) continue;
		else readRuns(c, base, resolve, hidden, visible, deleted);
	}
}
