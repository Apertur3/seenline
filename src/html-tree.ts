// Bounded, inert HTML tokens: never instantiate a browser or load a resource.
export interface HtmlNode {
	tag: string;
	attrs: Record<string, string>;
	children: (HtmlNode | string)[];
}
const VOID = new Set(
	"area base br col embed hr img input link meta param source track wbr".split(" "),
);
const NAMED: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	euro: "€",
	eacute: "é",
	Eacute: "É",
	euml: "ë",
	Euml: "Ë",
	iuml: "ï",
	ouml: "ö",
	auml: "ä",
	uuml: "ü",
	ndash: "–",
	mdash: "—",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
	hellip: "…",
	copy: "©",
	reg: "®",
	bull: "•",
};
export function htmlEntities(s: string): string {
	return s.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole, key: string) => {
		if (!key.startsWith("#")) return NAMED[key] ?? whole;
		const n =
			key[1]?.toLowerCase() === "x" ? Number.parseInt(key.slice(2), 16) : Number(key.slice(1));
		if (n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) throw new Error("HTML entity");
		return String.fromCodePoint(n);
	});
}
function attributes(s: string): Record<string, string> {
	const out: Record<string, string> = Object.create(null);
	let at = 0,
		count = 0;
	const re = /\s+([^\s=/>"'<]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gy;
	while (at < s.length && s.slice(at).trim()) {
		re.lastIndex = at;
		const a = re.exec(s);
		if (!a || ++count > 128)
			throw new Error(a ? "HTML attribute count" : "malformed HTML attribute");
		const key = (a[1] as string).toLowerCase();
		if (Object.hasOwn(out, key)) throw new Error("duplicate HTML attribute");
		out[key] = htmlEntities(a[2] ?? a[3] ?? a[4] ?? "");
		at = re.lastIndex;
	}
	return out;
}
function openTag(s: string, stack: HtmlNode[]): HtmlNode {
	if (s.length > 16_384) throw new Error("HTML tag size");
	let parent = stack.at(-1) as HtmlNode;
	const tag = /^<([\w:-]+)/.exec(s)?.[1]?.toLowerCase() as string;
	// The common omitted end tags must not swallow later paragraphs or table cells.
	if (["li", "p", "tr", "td", "th"].includes(tag) && parent.tag === tag) {
		stack.pop();
		parent = stack.at(-1) as HtmlNode;
	}
	const node: HtmlNode = {
		tag,
		attrs: attributes(s.slice(tag.length + 1, -1).replace(/(?<=^|[\s"'])\/$/, "")),
		children: [],
	};
	return node;
}
export function htmlTree(raw: string): HtmlNode {
	if (Buffer.byteLength(raw) > 5 * 1024 * 1024) throw new Error("HTML size");
	const root: HtmlNode = { tag: "", attrs: {}, children: [] },
		stack = [root];
	const token =
		/<!--[\s\S]*?(?:-->|$)|<\?[^>]*>?|<!doctype\s+html[^>]*>|<\/?[a-z][^<>"']*(?:(?:"[^"]*"|'[^']*')[^<>"']*)*>|[^<]+|</giy;
	let at = 0,
		count = 0;
	while (at < raw.length) {
		token.lastIndex = at;
		const m = token.exec(raw);
		if (!m || ++count > 100_000) throw new Error("HTML tokens");
		const s = m[0];
		at = token.lastIndex;
		let parent = stack.at(-1) as HtmlNode;
		// An XML declaration or processing instruction is a comment to an HTML reader: never shown.
		if (s.startsWith("<!--") || s.startsWith("<?")) {
			parent.children.push({
				tag: "!comment",
				attrs: {},
				children: [
					s.startsWith("<?") ? s.slice(2).replace(/>$/, "") : s.slice(4).replace(/-->$/, ""),
				],
			});
			continue;
		}
		if (/^<!doctype/i.test(s)) continue;
		if (s.startsWith("</")) {
			const tag = s.slice(2, -1).trim().toLowerCase();
			const i = stack.findLastIndex((n) => n.tag === tag);
			if (i > 0) stack.length = i;
			continue;
		}
		if (!/^<[a-z]/i.test(s)) {
			if (s === "<" && /^<[!/?a-z]/i.test(raw.slice(at - 1))) throw new Error("malformed HTML tag");
			parent.children.push(htmlEntities(s));
			continue;
		}
		const node = openTag(s, stack);
		parent = stack.at(-1) as HtmlNode;
		const tag = node.tag;
		parent.children.push(node);
		if (tag === "script" || tag === "style") {
			const end = new RegExp(`</${tag}\\s*>`, "gi");
			end.lastIndex = at;
			const close = end.exec(raw);
			node.children.push(raw.slice(at, close?.index ?? raw.length));
			at = close ? end.lastIndex : raw.length;
		} else if (!VOID.has(tag)) stack.push(node);
		if (stack.length > 100) throw new Error("HTML depth");
	}
	return root;
}
