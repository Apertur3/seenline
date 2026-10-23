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
			// An unclosed comment runs to the end, as in a browser; each pattern scans a character once.
			const raw = n.children.join("").replace(/\/\*[\s\S]*?(?:\*\/|$)/g, "");
			let at = 0;
			for (const m of raw.matchAll(/([^{}]+)\{([^{}]*)\}/gy)) {
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
// A box of (almost) no height or width that clips what overflows it; a computed size (min(), max())
// counts as none when it has a zero among its values.
const collapsed = (css: Css) =>
	["overflow", "overflow-x", "overflow-y"].some((k) => /^(?:hidden|clip)\b/.test(css[k] ?? "")) &&
	["height", "max-height", "width", "max-width", "line-height"].some((k) => {
		const v = k === "line-height" && /^[\d.]+$/.test(css[k] ?? "") ? `${css[k]}em` : css[k];
		if (!v) return false;
		if (v.includes("(")) return /[(,\s]0[a-z%]*\s*[,)]/.test(v);
		if (Number.parseFloat(v) === 0) return true;
		return /^(?:\d*\.)?\d+(?:px|pt|em|rem|%|ex|ch)?$/.test(v) && tiny(v);
	});
const faint = (opacity = "1") =>
	opacity.includes("(") ||
	Number.parseFloat(opacity) / (opacity.trim().endsWith("%") ? 100 : 1) < 0.1;
// A value that changes nothing: a reset keyword, or a zoom or scale of half or more.
const neutral = (k: string, v = "") =>
	/^(?:none|initial|unset|inherit|revert|auto|normal|visible)$/.test(v) ||
	(["zoom", "scale"].includes(k) &&
		/^[\d.]+%?$/.test(v) &&
		Number.parseFloat(v) / (v.endsWith("%") ? 100 : 1) >= 0.5);
export function cssHidden(css: Css): boolean {
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
		collapsed(css) ||
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
