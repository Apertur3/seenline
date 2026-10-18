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
	const shade = first(n, "shd");
	if (shade) out.background = attr(shade, "fill") ?? "";
	return out;
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
	return { defaults, resolve, defaultId };
}

function reason(p: Record<string, string>): string[] {
	const why: string[] = [];
	if (["vanish", "webHidden"].some((k) => p[k] && !["0", "false", "off"].includes(p[k] as string)))
		why.push("hidden run");
	if ([p.sz, p.szCs].some((size) => size !== undefined && Number(size) < 4)) why.push("tiny text");
	const color = p.color?.toUpperCase();
	if (color === "FFFFFF" || (color && color !== "AUTO" && color === p.background?.toUpperCase()))
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
				for (const row of children(c, "tr"))
					target.push(
						children(row, "tc")
							.map((cell) =>
								all(cell, "p")
									.map((p) => paragraph(p, attr(first(cell, "shd"), "fill") ?? background))
									.filter(Boolean)
									.join(" "),
							)
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
			const value = nodes(c)
				.map((v) =>
					["t", "delText", "instrText"].includes(local(v) ?? "")
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
