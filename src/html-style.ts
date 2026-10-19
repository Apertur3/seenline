import type { HtmlNode } from "./html-tree.ts";
export type Css = Record<string, string>;
interface Rule {
	selector: string;
	css: Css;
}
export function declarations(raw: string): Css {
	// Escapes, variables and computed values need a real CSS engine; refuse ambiguity.
	if (/\\|\/\*|\b(?:var|calc|url)\s*\(/i.test(raw)) throw new Error("unsupported CSS");
	const out: Css = {};
	for (const item of raw.split(";")) {
		if (!item.trim()) continue;
		const at = item.indexOf(":");
		if (at < 1) throw new Error("CSS declaration");
		const key = item.slice(0, at).trim().toLowerCase();
		if (Object.hasOwn(out, key)) throw new Error("duplicate CSS declaration");
		out[key] = item
			.slice(at + 1)
			.replace(/!important/gi, "")
			.trim()
			.toLowerCase();
	}
	return out;
}
// Properties that cannot change what a reader sees: no box, position, colour, visibility or generated text.
const INERT =
	/^(?:font-(?:weight|style|variant)|text-(?:decoration(?:-[a-z]+)?|align|transform|underline-offset)|list-style(?:-type|-position)?|counter-(?:increment|reset)|cursor|background-(?:size|repeat|position))$/;
const inert = (raw: string) =>
	raw
		.split(";")
		.every((d) => !d.trim() || INERT.test(/^\s*([a-z-]+)\s*:/i.exec(d)?.[1]?.toLowerCase() ?? ""));
const linked = (n: HtmlNode): boolean =>
	(n.tag === "link" && /(?:^|\s)stylesheet(?:$|\s)/i.test(n.attrs.rel ?? "")) ||
	n.children.some((c) => typeof c !== "string" && linked(c));
export function styleRules(root: HtmlNode): Rule[] {
	// A linked stylesheet is unknown, so every element is flagged and no rule in the page can hide more.
	if (linked(root)) return [{ selector: "*", css: { display: "none" } }];
	const rules: Rule[] = [];
	const walk = (n: HtmlNode) => {
		if (n.tag === "style") {
			const raw = n.children.join("").replace(/\/\*[\s\S]*?\*\//g, "");
			let at = 0;
			for (const m of raw.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
				if (raw.slice(at, m.index).trim()) throw new Error("CSS rules");
				for (const selector of (m[1] as string).split(",")) {
					if (/^[\w.*#\s-]+$/.test(selector))
						rules.push({ selector: selector.trim(), css: declarations(m[2] as string) });
					else if (!inert(m[2] as string)) throw new Error("unsupported CSS selector");
				}
				at = m.index + m[0].length;
			}
			if (raw.slice(at).trim()) throw new Error("CSS rules");
		}
		for (const c of n.children) if (typeof c !== "string") walk(c);
	};
	walk(root);
	if (rules.length > 1000) throw new Error("CSS rule budget");
	return rules;
}
function matches(n: HtmlNode, selector: string): boolean {
	return (selector.match(/[#.]?[\w-]+|\*/g) ?? []).every(
		(s) =>
			s === "*" ||
			(s[0] === "#"
				? n.attrs.id === s.slice(1)
				: s[0] === "."
					? (n.attrs.class ?? "").split(/\s+/).includes(s.slice(1))
					: n.tag === s),
	);
}
function selected(path: HtmlNode[], selector: string): boolean {
	const parts = selector.split(/\s+/);
	let i = path.length - 1;
	const last = parts.pop();
	if (!last || !matches(path[i] as HtmlNode, last)) return false;
	for (const part of parts.reverse()) {
		do {
			i--;
		} while (i >= 0 && !matches(path[i] as HtmlNode, part));
		if (i < 0) return false;
	}
	return true;
}
const color = (s = "") =>
	s
		.replace(/\s/g, "")
		.replace(/^white$/, "#ffffff")
		.replace(/^black$/, "#000000")
		.replace(/^#([\da-f])([\da-f])([\da-f])$/, "#$1$1$2$2$3$3")
		.replace(/^rgba?\(255,255,255(?:,1)?\)$/, "#ffffff")
		.replace(/^rgba?\(0,0,0(?:,1)?\)$/, "#000000");
function tiny(size: string | undefined): boolean {
	if (!size) return false;
	const m = /^([+-]?(?:\d*\.)?\d+)(px|pt|em|rem|%|ex|ch)?$/.exec(size);
	if (!m)
		return ![
			"medium",
			"large",
			"x-large",
			"xx-large",
			"larger",
			"smaller",
			"small",
			"inherit",
			"initial",
		].includes(size);
	const n = Number(m[1]),
		unit = m[2] ?? "px";
	return (
		n <= (unit === "pt" ? 2 : unit === "em" || unit === "rem" ? 0.15 : unit === "%" ? 15 : 2.5)
	);
}
function cssHidden(css: Css): boolean {
	const foreground = color(css.color);
	const colours = [css.color, css.background, css["background-color"]].filter(
		(c): c is string => !!c,
	);
	const uncertain = colours.some((c) => !/^(?:#[a-f\d]{6}|[a-z]+)$/.test(color(c)));
	return (
		uncertain ||
		css.display === "none" ||
		["hidden", "collapse"].includes(css.visibility ?? "") ||
		Number(css.opacity ?? 1) === 0 ||
		tiny(css["font-size"]) ||
		!!css.font ||
		foreground === "#ffffff" ||
		foreground === "transparent" ||
		(!!foreground &&
			[css["background-color"], css.background].some((bg) => !!bg && foreground === color(bg))) ||
		["left", "right", "top", "bottom", "text-indent"].some(
			(k) => /^-/.test(css[k] ?? "") || Number.parseFloat(css[k] ?? "") > 10000,
		) ||
		["clip", "clip-path", "transform", "filter", "content-visibility"].some((k) =>
			Object.hasOwn(css, k),
		)
	);
}
export function visibility(
	n: HtmlNode,
	path: HtmlNode[],
	inherited: Css,
	rules: Rule[],
): { css: Css; hidden: boolean } {
	const css = { ...inherited };
	let hidden = Object.hasOwn(n.attrs, "hidden") || n.attrs["aria-hidden"]?.toLowerCase() === "true";
	for (const rule of rules)
		if (selected(path, rule.selector)) {
			Object.assign(css, rule.css);
			hidden ||= cssHidden(css);
		}
	// An element a rule already hides stays hidden, whatever its own style says.
	if (!hidden) Object.assign(css, declarations(n.attrs.style ?? ""));
	if (n.attrs.color) css.color = n.attrs.color.toLowerCase();
	if (n.attrs.bgcolor) css["background-color"] = n.attrs.bgcolor.toLowerCase();
	// Cascading conflicts are conservative: an applicable hiding rule always requires review.
	hidden ||= cssHidden(css) || (n.tag === "font" && Number(n.attrs.size ?? 3) <= 1);
	const next: Css = {};
	for (const key of ["font-size", "color", "background", "background-color", "visibility"])
		if (css[key]) next[key] = css[key];
	return { css: next, hidden };
}
