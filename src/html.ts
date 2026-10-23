import { type Css, styleRules, visibility } from "./html-style.ts";
import { type HtmlNode, htmlTree } from "./html-tree.ts";

export interface MailText {
	body: string[];
	hidden: string[];
	/** Entries listed even where the body shows their text. */
	kept?: string[];
}
const flat = (s: string) => s.replace(/\s+/g, " ").trim();
const BLOCK =
	/^(?:p|div|section|article|header|footer|main|aside|nav|ul|ol|table|blockquote|pre|dl|dt|dd|address)$/;

function reader(out: MailText, rules: ReturnType<typeof styleRules>) {
	const visit = (n: HtmlNode, path: HtmlNode[], inherited: Css, hidden: boolean): string => {
		if (n.tag === "script" || n.tag === "style") {
			out.hidden.push(`HTML ${n.tag} present (code omitted)`);
			return "";
		}
		if (n.tag === "meta" || n.tag === "link" || n.tag === "base") {
			// A charset, or a link to an icon, a feed or another address, holds no text. Listed: any meta
			// content and any link title (free text), and a stylesheet, which this reader cannot see into,
			// so it hides the whole page here.
			const link = n.attrs.title !== undefined || /stylesheet/i.test(n.attrs.rel ?? "");
			const listed = n.tag === "base" || (n.tag === "meta" ? n.attrs.content !== undefined : link);
			if (listed)
				out.hidden.push(
					`HTML ${n.tag}: ${flat(
						Object.entries(n.attrs)
							.map(([k, v]) => `${k}=${v}`)
							.join(" "),
					)}`,
				);
			return "";
		}
		const state = visibility(n, path, inherited, rules);
		const unseen =
			hidden ||
			state.hidden ||
			["!comment", "template", "noscript", "head", "title"].includes(n.tag);
		// The value of a hidden input, or of one that hiding styles or a hidden parent take from view.
		const type = /^hidden$/i.test(n.attrs.type ?? "");
		if (n.tag === "input" && (type || unseen) && n.attrs.value?.trim())
			out.hidden.push(`HTML input value: ${flat(n.attrs.value)}`);
		// A closed <details> shows its summary only.
		const shut = n.tag === "details" && !Object.hasOwn(n.attrs, "open");
		let text = n.children
			.map((c) => {
				if (typeof c !== "string")
					return visit(c, [...path, c], state.css, unseen || (shut && c.tag !== "summary"));
				if (unseen || shut) {
					if (flat(c)) out.hidden.push(`HTML ${n.tag || "hidden"} text: ${flat(c)}`);
					return "";
				}
				return c.replace(/[\t\r\n ]+/g, " ");
			})
			.join("");
		for (const key of ["alt", "title"]) {
			const value = n.attrs[key];
			if (value && flat(value) !== flat(text))
				out.hidden.push(`HTML ${n.tag} ${key}: ${flat(value)}`);
		}
		if (unseen) return "";
		if (n.tag === "a" && n.attrs.href)
			text = `${flat(text)} (${n.attrs.href.replace(/\s+/g, " ")})`;
		if (/^h[1-6]$/.test(n.tag)) return `\n${"#".repeat(Number(n.tag[1]))} ${flat(text)}\n`;
		if (n.tag === "li") return `\n- ${text.trim()}\n`;
		if (n.tag === "td" || n.tag === "th") return `${flat(text)} | `;
		if (n.tag === "tr") return `\n${text.trim().replace(/\s*\|$/, "")}\n`;
		if (n.tag === "br" || n.tag === "hr") return "\n";
		if (n.tag === "blockquote")
			return `\n${text
				.trim()
				.split("\n")
				.map((l) => `> ${l}`)
				.join("\n")}\n`;
		return BLOCK.test(n.tag) ? `\n${text.trim()}\n` : text;
	};
	return visit;
}
export function readHtml(raw: string): MailText {
	const root = htmlTree(raw),
		rules = styleRules(root);
	const out: MailText = { body: [], hidden: [] };
	const visit = reader(out, rules);
	out.body = visit(root, [root], {}, false)
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	return out;
}
