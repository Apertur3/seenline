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
/** A style sheet's rules as [selectors, declarations]; anything else (an unclosed or nested block, a stray brace) throws. */
export function cssRules(sheet: string): [string, string][] {
	// An unclosed comment runs to the end, as in a browser; each pattern scans a character once.
	const raw = sheet.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, "");
	let at = 0;
	const out: [string, string][] = [];
	for (const m of raw.matchAll(/([^{}]+)\{([^{}]*)\}/gy)) {
		out.push([m[1] as string, m[2] as string]);
		at = m.index + m[0].length;
	}
	if (raw.slice(at).trim()) throw new Error("CSS rules");
	return out;
}
export function styleRules(root: HtmlNode): Rule[] {
	// A linked stylesheet is unknown, so every element is flagged and no rule in the page can hide more.
	if (linked(root)) return [{ selector: "*", css: { display: "none" } }];
	const rules: Rule[] = [];
	const walk = (n: HtmlNode) => {
		if (n.tag === "style")
			for (const [selectors, body] of cssRules(n.children.join("")))
				for (const selector of selectors.split(",")) {
					if (/^[\w.*#\s-]+$/.test(selector))
						rules.push({ selector: selector.trim(), css: declarations(body) });
					else if (!inert(body)) throw new Error("unsupported CSS selector");
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
// The size in a `font` shorthand (`bold 16px/1.4 serif`, `0/0 a`); a system font or a keyword shows.
function fontTiny(font: string | undefined): boolean {
	if (
		!font ||
		/^(?:inherit|initial|unset|revert|caption|icon|menu|message-box|small-caption|status-bar)$/.test(
			font,
		)
	)
		return false;
	const size =
		/(?:^|\s)((?:\d*\.)?\d+[a-z%]+|0|(?:xx?-)?(?:small|large)|medium|larger|smaller)(?:\s*\/\s*\S+)?\s+\S/.exec(
			font,
		)?.[1];
	// A unit the size check does not know (vw, cqw, lh) hides only at zero.
	if (size && /^[\d.]+[a-z]+$/.test(size) && !/(?:px|pt|r?em|ex|ch)$/.test(size))
		return Number.parseFloat(size) === 0;
	return !size || tiny(size);
}
// A size of (almost) none: a tiny length, min() with a zero among its values, max() or clamp() whose
// result is zero. Another computed size is not none (never zero without proof); a nested one is refused.
function none(v: string | undefined): boolean {
	if (!v) return false;
	if (v.indexOf("(", v.indexOf("(") + 1) > 0) throw new Error("unsupported CSS");
	const f = /^(min|max|clamp)\(([^()]*)\)$/.exec(v);
	if (f) {
		// Inside a function a negative size is allowed, and comes out as zero.
		const all = (f[2] as string).split(",").map((x) => /^-[\d.]/.test(x.trim()) || none(x.trim()));
		const [a, b, c] = all; // clamp(min, value, max) is max(min, min(value, max))
		if (f[1] === "clamp") return !!a && (!!b || !!c);
		return f[1] === "min" ? all.some(Boolean) : all.every(Boolean);
	}
	if (v.includes("(")) return false;
	if (Number.parseFloat(v) === 0) return true;
	return /^(?:\d*\.)?\d+(?:px|pt|em|rem|%|ex|ch)?$/.test(v) && tiny(v);
}
const some = (v: string | undefined) =>
	!!v && !none(v) && !/^(?:auto|none|initial|unset|inherit|revert)$/.test(v);
// Elements whose box a height or width sizes and overflow clips. An ordinary inline element (a span)
// is not one, nor a table or its cells, which grow to fit their content.
const BOX =
	/^(?:p|div|section|article|header|footer|main|aside|nav|ul|ol|li|blockquote|pre|dl|dt|dd|address|h[1-6]|hgroup|search|menu|dialog|legend|form|fieldset|figure|figcaption|details|summary|center|body|html|input|textarea|select|button|iframe)$/;
const boxed = (css: Css, tag: string) =>
	/^(?:absolute|fixed)$/.test(css.position ?? "") ||
	/^(?:left|right)$/.test(css.float ?? "") ||
	(css.display && !neutral("", css.display)
		? !/^(?:inline|contents|(?:inline-)?table(?:-[a-z-]+)?)$/.test(css.display)
		: BOX.test(tag));
// A box of (almost) no height or width that clips or scrolls what overflows it on that axis, a minimum
// size counted. One axis hidden or scrolling makes the other, if visible, scroll too (clip does not).
const collapsed = (css: Css, tag: string) => {
	if (!boxed(css, tag)) return false;
	const [ox = "", oy = ox] = (css.overflow ?? "").split(/\s+/);
	const [x, y] = [css["overflow-x"] ?? ox, css["overflow-y"] ?? oy];
	const clips = (a: string, b: string) =>
		/^(?:hidden|clip|auto|scroll)$/.test(a) ||
		(/^(?:visible)?$/.test(a) && /^(?:hidden|auto|scroll)$/.test(b));
	const lh = css["line-height"];
	const lines = () => none(lh && /^[\d.]+$/.test(lh) ? `${lh}em` : lh) && !some(css.height);
	const flat = () =>
		(none(css.height) || none(css["max-height"]) || lines()) && !some(css["min-height"]);
	const thin = () => (none(css.width) || none(css["max-width"])) && !some(css["min-width"]);
	return (clips(y, x) && flat()) || (clips(x, y) && thin());
};
const faint = (opacity = "1") =>
	opacity.includes("(") ||
	Number.parseFloat(opacity) / (opacity.trim().endsWith("%") ? 100 : 1) < 0.1;
// A value that changes nothing: a reset keyword, or a zoom or scale of half or more.
const neutral = (k: string, v = "") =>
	/^(?:none|initial|unset|inherit|revert|auto|normal|visible)$/.test(v) ||
	(["zoom", "scale"].includes(k) &&
		/^[\d.]+%?$/.test(v) &&
		Number.parseFloat(v) / (v.endsWith("%") ? 100 : 1) >= 0.5);
export function cssHidden(css: Css, tag = ""): boolean {
	// The letters' fill: -webkit-text-fill-color where it is set, else the colour.
	const fill = css["-webkit-text-fill-color"];
	const ink = fill && fill !== "currentcolor" && !neutral("", fill) ? fill : css.color;
	const foreground = color(ink);
	const colours = [ink, css.background, css["background-color"]].filter((c): c is string => !!c);
	const uncertain = colours.some((c) => !/^(?:#[a-f\d]{6}|[a-z]+)$/.test(color(c)));
	return (
		uncertain ||
		css.display === "none" ||
		["hidden", "collapse"].includes(css.visibility ?? "") ||
		faint(css.opacity) ||
		tiny(css["font-size"]) ||
		fontTiny(css.font) ||
		collapsed(css, tag) ||
		foreground === "#ffffff" ||
		foreground === "transparent" ||
		(!!foreground &&
			[css["background-color"], css.background].some((bg) => !!bg && foreground === color(bg))) ||
		["left", "right", "top", "bottom", "text-indent"].some(
			(k) => /^-/.test(css[k] ?? "") || Number.parseFloat(css[k] ?? "") > 10000,
		) ||
		Object.entries(css).some(([k, v]) => k.startsWith("margin") && /(?:^|\s)-\d{4,}/.test(v)) ||
		// Their effect on the letters is not worked out here, so the text is listed.
		[
			"clip",
			"clip-path",
			"transform",
			"filter",
			"content-visibility",
			"mask",
			"mask-image",
			"-webkit-mask",
			"-webkit-mask-image",
			"zoom",
			"scale",
		].some((k) => Object.hasOwn(css, k) && !neutral(k, css[k]))
	);
}
export function visibility(
	n: HtmlNode,
	path: HtmlNode[],
	inherited: Css,
	rules: Rule[],
): { css: Css; hidden: boolean } {
	const css = { ...inherited };
	// ponytail: aria-hidden only takes text from a screen reader, but the pinned reference goldens list
	// it as hidden (mail-newsletter.html); it stays listed until the golden baseline is re-cut.
	let hidden = Object.hasOwn(n.attrs, "hidden") || n.attrs["aria-hidden"]?.toLowerCase() === "true";
	for (const rule of rules)
		if (selected(path, rule.selector)) {
			Object.assign(css, rule.css);
			hidden ||= cssHidden(css, n.tag);
		}
	// An element a rule already hides stays hidden, whatever its own style says.
	if (!hidden) Object.assign(css, declarations(n.attrs.style ?? ""));
	if (n.attrs.color) css.color = n.attrs.color.toLowerCase();
	if (n.attrs.bgcolor) css["background-color"] = n.attrs.bgcolor.toLowerCase();
	// Cascading conflicts are conservative: an applicable hiding rule always requires review.
	hidden ||= cssHidden(css, n.tag) || (n.tag === "font" && Number(n.attrs.size ?? 3) <= 1);
	const next: Css = {};
	for (const key of ["font-size", "color", "background", "background-color", "visibility"])
		if (css[key]) next[key] = css[key];
	return { css: next, hidden };
}
