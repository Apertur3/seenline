// Bounded OOXML reader: no DTDs, external entities, executable content or network.

import { posix } from "node:path";
import { officeZip } from "./office-zip.ts";

export interface Xml {
	name: string;
	attrs: Record<string, string>;
	children: (Xml | string)[];
}
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export function entities(s: string): string {
	if (/&(?!amp;|lt;|gt;|apos;|quot;|#(?:[0-9]+|x[\da-f]+);)/i.test(s))
		throw new Error("XML entity");
	return s.replace(/&([^;\s]+);/g, (_, code: string) => {
		const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", apos: "'", quot: '"' };
		if (Object.hasOwn(named, code)) return named[code] as string;
		if (!/^#(?:[0-9]+|x[\da-f]+)$/i.test(code)) throw new Error("XML entity");
		return String.fromCodePoint(
			Number.parseInt(code.slice(code[1] === "x" ? 2 : 1), code[1] === "x" ? 16 : 10),
		);
	});
}

export function xml(raw: string): Xml {
	if (/<!DOCTYPE|<!ENTITY/i.test(raw)) throw new Error("DTD");
	const root: Xml = { name: "", attrs: {}, children: [] };
	const stack = [root];
	let at = 0;
	let count = 0;
	for (const token of raw.matchAll(
		/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>|[^<]+/g,
	)) {
		if (token.index !== at || ++count > 500_000) throw new Error("XML size");
		const s = token[0];
		at += s.length;
		const parent = stack.at(-1) as Xml;
		if (s.startsWith("<!--") || s.startsWith("<?")) continue;
		if (s.startsWith("<![CDATA[")) {
			parent.children.push(s.slice(9, -3));
			continue;
		}
		if (!s.startsWith("<")) {
			parent.children.push(entities(s));
			continue;
		}
		if (s.startsWith("</")) {
			if (stack.length < 2 || parent.name !== s.slice(2, -1).trim()) throw new Error("XML close");
			stack.pop();
			continue;
		}
		const tag = /^<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*\/?>$/.exec(s);
		if (!tag) throw new Error("XML tag");
		const attrs: Record<string, string> = {};
		for (const a of (tag[2] ?? "").matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
			if (Object.hasOwn(attrs, a[1] as string)) throw new Error("duplicate attribute");
			attrs[a[1] as string] = entities(a[2] ?? a[3] ?? "");
		}
		const node: Xml = { name: tag[1] as string, attrs, children: [] };
		parent.children.push(node);
		if (!s.endsWith("/>")) stack.push(node);
		if (stack.length > 100) throw new Error("XML depth");
	}
	if (
		at !== raw.length ||
		stack.length !== 1 ||
		nodes(root).length !== 1 ||
		root.children.some((c) => typeof c === "string" && c.trim() !== "")
	)
		throw new Error("XML document");
	return nodes(root)[0] as Xml;
}

export const local = (n: Xml) => n.name.split(":").at(-1);
export const nodes = (n: Xml): Xml[] => n.children.filter((c): c is Xml => typeof c !== "string");
export const children = (n: Xml, name: string) => nodes(n).filter((c) => local(c) === name);
export function all(n: Xml, name: string): Xml[] {
	return nodes(n).flatMap((c) => [...(local(c) === name ? [c] : []), ...all(c, name)]);
}
export const first = (n: Xml, name: string) => all(n, name)[0];
export const attr = (n: Xml | undefined, key: string) => n?.attrs[key] ?? n?.attrs[`w:${key}`];
export const text = (n: Xml): string =>
	n.children.map((c) => (typeof c === "string" ? c : text(c))).join("");
export const flat = (s: string) => s.replace(/\s+/g, " ").trim();
/** A theme part's colours by scheme name (dk1, lt1, accent1, ...), as RRGGBB. */
export function themeColours(theme: Xml | undefined): Map<string, string | undefined> {
	const scheme = theme && first(theme, "clrScheme");
	return new Map(
		(scheme ? nodes(scheme) : []).map((c) => [
			local(c) ?? "",
			attr(first(c, "srgbClr"), "val") ?? first(c, "sysClr")?.attrs.lastClr,
		]),
	);
}

export function packageXml(bytes: Uint8Array): Map<string, Xml> {
	const files = officeZip(bytes);
	const out = new Map<string, Xml>();
	for (const [name, data] of Object.entries(files)) out.set(name, xml(UTF8.decode(data)));
	if (!out.has("[Content_Types].xml")) throw new Error("not OOXML");
	return out;
}

export function part(parts: Map<string, Xml>, name: string): Xml {
	const found = parts.get(name);
	if (!found) throw new Error(`missing ${name}`);
	return found;
}

export function related(parts: Map<string, Xml>, from: string): Map<string, string> {
	const rel = parts.get(posix.join(posix.dirname(from), "_rels", `${posix.basename(from)}.rels`));
	const out = new Map<string, string>();
	if (!rel) return out;
	for (const r of children(rel, "Relationship")) {
		if (r.attrs.TargetMode === "External") continue;
		const target = r.attrs.Target ?? "";
		const resolved = target.startsWith("/")
			? target.slice(1)
			: posix.join(posix.dirname(from), target);
		if (resolved.startsWith("..")) throw new Error("relationship path");
		out.set(r.attrs.Id ?? "", resolved);
	}
	return out;
}
