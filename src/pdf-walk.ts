// Walks a PDF page's drawing operators for the text a reader sees and the text a reader does not:
// white, tiny, invisible, outside the page box, in a layer that is switched off, or painted over later
// by a fill or an image. pdfjs's own text layer drops several of these without a trace, so the
// operators are read here. Pure JavaScript, no rendering.

import { light } from "./colour.ts";
import { SeenlineError } from "./error.ts";
import {
	type Box,
	bounds,
	type Fill,
	hides,
	lum,
	onWhite,
	paints,
	polygons,
	RGB,
} from "./pdf-paths.ts";

export type Matrix = [number, number, number, number, number, number];
export interface Item {
	text: string;
	x: number;
	y: number;
	size: number;
	end: number;
	/** The middle of the letters, along the run's own direction (a rotated label runs up the page). */
	mid: [number, number];
	/** Set when the run reads left to right on a level baseline: not rotated, mirrored or upside down. */
	upright: boolean;
	axis: Matrix; // text-to-page matrix, turned to the displayed page rotation in pdf.ts
	why: string[];
}
interface Glyph {
	unicode: string;
	width: number;
	originalCharCode: number;
	isInFont: boolean;
	isSpace?: boolean;
}
// A soft mask's content: each solid fill with what it lets through (0 to 1), and what it lets through
// elsewhere. "unknown" when it draws anything else (text, pictures, shadings, see-through fills).
type Mask = { fills: [Fill, number][]; rest: number } | "unknown";
// The graphics state: what q saves and Q restores, text state included.
interface State {
	ctm: Matrix;
	fontSize: number;
	// The font's glyph width unit in text space (its FontMatrix; 1/1000 for most, 1/2048 for some).
	em: number;
	// The font in force could not be read at all (pdfjs draws nothing for it).
	broken: boolean;
	color: string;
	stroke: string;
	fillAlpha: number;
	strokeAlpha: number;
	blend: string;
	soft: Mask | null;
	mode: number;
	hscale: number;
	rise: number;
	charSpacing: number;
	wordSpacing: number;
	leading: number;
	// The clipping paths in force. pdfjs reports `W` before the path it clips to.
	clips: Fill[];
}
export interface Ops {
	fnArray: number[];
	argsArray: unknown[][];
}

// Text under this size is tiny. Hidden text is often drawn at exactly 2 pt (CrackedPDFs' tiny payloads
// are); the smallest text a reader sees in the benchmark's public PDFs is a figure's 2.48 pt axis labels.
const TINY_PT = 2.25;
// A page with more text runs than this is not a document, and covering is quadratic in it.
const MAX_RUNS = 100_000;
const MAX_CLIPS = 32;
const OFF_PAGE_PT = 5;
// Letters wider or narrower than this against their height (horizontal scaling Tz, a text matrix,
// character spacing that stacks them) are a smear or a line, not text.
const MIN_HSCALE = 0.2;
const MAX_HSCALE = 10;
// A TJ adjustment this far back is a word space (typesetters write spaces as kerning).
const SPACE_KERN = 200;
// Text drawn at under this opacity is not there; a fill or picture at this or more hides what is under
// it (a white fill at 0.94 over black text leaves it #f0f0f0, which counts as white).
const SEEN_ALPHA = 0.05;
const COVER_ALPHA = 0.94;

export const mul = (a: Matrix, b: Matrix): Matrix => [
	a[0] * b[0] + a[1] * b[2],
	a[0] * b[1] + a[1] * b[3],
	a[2] * b[0] + a[3] * b[2],
	a[2] * b[1] + a[3] * b[3],
	a[4] * b[0] + a[5] * b[2] + b[4],
	a[4] * b[1] + a[5] * b[3] + b[5],
];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const START: State = {
	ctm: IDENTITY,
	fontSize: 0,
	em: 0.001,
	broken: false,
	color: "#000000",
	stroke: "#000000",
	fillAlpha: 1,
	strokeAlpha: 1,
	blend: "source-over",
	soft: null,
	mode: 0,
	hscale: 1,
	rise: 0,
	charSpacing: 0,
	wordSpacing: 0,
	leading: 0,
	clips: [],
};
// A point just outside a clip still counts as in: edges are only as exact as the rounding in the file.
const NUDGE = [
	[0, 0],
	[1, 0],
	[-1, 0],
	[0, 1],
	[0, -1],
];
const inside = (clips: Fill[], x: number, y: number) =>
	clips.every((c) => NUDGE.some(([dx = 0, dy = 0]) => paints(c, x + dx, y + dy)));

// White is every channel at 0xf0 or more; an invisible mode is "neither fill nor stroke" (3) or clip only (7).
// Off the page is the run's start or the middle of its letters (a long line may run past the edge).
function hiding(color: string, mode: number, size: number, points: number[][], v: Matrix) {
	const why: string[] = [];
	if (/^#(f[0-9a-f]){3}$/i.test(color)) why.push("white");
	if (size < TINY_PT) why.push("tiny");
	if (mode === 3 || mode === 7) why.push("invisible");
	const off = OFF_PAGE_PT;
	if (
		points.some(
			([x = 0, y = 0]) => x < v[0] - off || x > v[2] + off || y < v[1] - off || y > v[3] + off,
		)
	)
		why.push("off-page");
	return why;
}

/**
 * Everything one page shows, in content-stream order; `visible` says whether a layer is switched on.
 * `pictured` is the share of the page that pictures cover (overlaps count twice, so it can pass 1).
 */
export function walk(
	OPS: Record<string, number>,
	list: Ops,
	view: Matrix,
	visible: (layer: unknown) => boolean,
	fonts: (id: string) => number[] | undefined = () => undefined,
): { items: Item[]; pictured: number } {
	const w = new Walker(OPS, view, visible, fonts);
	for (const [i, fn] of list.fnArray.entries()) w.step(fn, list.argsArray[i] as unknown[]);
	const area = (view[2] - view[0]) * (view[3] - view[1]);
	return { items: w.out, pictured: area > 0 ? w.pictured / area : 0 };
}

class Walker {
	out: Item[] = [];
	pictured = 0;
	private saved: State[] = [];
	private s: State = { ...START };
	private clipping: "" | "nonzero" | "evenodd" = "";
	private groupBox: number[] | null = null;
	// Inside a soft mask's own content (pdfjs inlines it before the gs that sets it): nothing there is
	// painted on the page. `mask` collects it; `made` is the last one finished, for the gs that follows.
	private masks: { mask: Mask; luminosity: boolean }[] = [];
	private made: Mask | null = null;
	// Every fill and picture so far, in paint order: what lies under text drawn next.
	private painted: Fill[] = [];
	private tm = IDENTITY;
	private tlm = IDENTITY;
	// The outlines of text drawn in a clipping mode (Tr 4 to 7) in this text object: the clip after ET.
	private textClip: [number, number][][] | null = null;
	// One entry per open marked-content section: true when it is a layer that is switched off.
	private layers: boolean[] = [];
	private OPS: Record<string, number>;
	private view: Matrix;
	private visible: (layer: unknown) => boolean;
	private fonts: (id: string) => number[] | undefined;

	constructor(
		OPS: Record<string, number>,
		view: Matrix,
		visible: (layer: unknown) => boolean,
		fonts: (id: string) => number[] | undefined,
	) {
		this.OPS = OPS;
		this.view = view;
		this.visible = visible;
		this.fonts = fonts;
	}

	step(fn: number, a: unknown[]): void {
		const { OPS } = this;
		if (fn === OPS.save || fn === OPS.paintFormXObjectBegin || fn === OPS.beginAnnotation) {
			this.saved.push({ ...this.s });
			if (fn === OPS.beginAnnotation) {
				// An annotation's appearance is drawn from a fresh state, mapped onto its rectangle.
				const [, rect, transform, matrix] = a as [unknown, number[] | null, Matrix, Matrix];
				this.s = { ...START, ctm: mul(matrix ?? IDENTITY, transform ?? IDENTITY) };
				if (rect) this.s.clips = [this.region(this.corners(rect, IDENTITY), "nonzero")];
				return;
			}
			if (fn !== OPS.paintFormXObjectBegin) return;
			if (a?.[0]) this.s.ctm = mul(a[0] as Matrix, this.s.ctm);
			// A form draws nothing outside its bounding box (pdfjs hands a group's box to beginGroup).
			const bbox = (a?.[1] as number[] | null) ?? this.groupBox;
			this.groupBox = null;
			if (bbox) this.clipTo(this.corners([...bbox]), "nonzero");
		} else if (fn === OPS.beginGroup) {
			const g = a?.[0] as { bbox?: number[]; smask?: { subtype?: string; backdrop?: string } };
			this.groupBox = g?.bbox ?? null;
			if (g?.smask) {
				const luminosity = g.smask.subtype !== "Alpha";
				const rest =
					luminosity && RGB.test(g.smask.backdrop ?? "") ? lum(g.smask.backdrop ?? "") : 0;
				this.masks.push({ mask: { fills: [], rest }, luminosity });
			}
		} else if (fn === OPS.endGroup) {
			if ((a?.[0] as { smask?: unknown })?.smask) this.made = this.masks.pop()?.mask ?? "unknown";
		} else if (fn === OPS.restore || fn === OPS.paintFormXObjectEnd || fn === OPS.endAnnotation) {
			this.s = this.saved.pop() ?? this.s;
		} else if (fn === OPS.transform) this.s.ctm = mul(a as Matrix, this.s.ctm);
		else this.paint(fn, a);
	}

	// Fills and images paint over what came before: the text under them is not what a reader sees.
	private paint(fn: number, a: unknown[]): void {
		const { OPS } = this;
		if (fn === OPS.beginMarkedContentProps) {
			this.layers.push(a[0] === "OC" && !this.visible(a[1]));
		} else if (fn === OPS.beginMarkedContent) this.layers.push(false);
		else if (fn === OPS.endMarkedContent) this.layers.pop();
		else if (fn === OPS.clip) this.clipping = "nonzero";
		else if (fn === OPS.eoClip) this.clipping = "evenodd";
		else if (fn === OPS.constructPath) {
			const box = a[2] as ArrayLike<number> | undefined;
			if (box) {
				const data = (a[1] as ArrayLike<number>[] | undefined)?.[0];
				const polys = data
					? polygons(data, (x, y) => this.at(x, y))
					: [this.corners([box[0] ?? 0, box[1] ?? 0, box[2] ?? 0, box[3] ?? 0])];
				if (this.clipping) this.clipTo(polys, this.clipping);
				if (FILLS.some((n) => OPS[n] === a[0]))
					this.cover(
						polys,
						this.s.color,
						EO_FILLS.some((n) => OPS[n] === a[0]),
					);
			}
			this.clipping = "";
		} else if (PICTURES.some((n) => OPS[n] === fn)) {
			const corners = this.corners([0, 0, 1, 1]);
			const [x0, y0, x1, y1] = intersect(bounds([corners]), this.view.slice(0, 4) as Box);
			if (!this.masks.length) this.pictured += Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
			// A picture's pixels are not read: under white letters it is unknown, so they stay flagged.
			// A stencil (image mask) does not count as cover; in a soft mask it makes the mask unknown.
			if (fn !== OPS.paintImageMaskXObject || this.masks.length) this.cover([corners], "", false);
		} else if (fn === OPS.shadingFill) {
			// A shading paints everywhere the clip lets it; its colours are not read, like a picture's.
			const [x0, y0, x1, y1] = this.view;
			this.cover([this.corners([x0, y0, x1, y1], IDENTITY)], "", false);
		} else this.text(fn, a);
	}

	// A rectangle's corners through the matrix in force, as a polygon.
	private corners([x0 = 0, y0 = 0, x1 = 0, y1 = 0]: number[], c = this.s.ctm) {
		const at = (x: number, y: number): [number, number] => [
			c[0] * x + c[2] * y + c[4],
			c[1] * x + c[3] * y + c[5],
		];
		return [at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1)];
	}

	private region(polys: [number, number][][] | [number, number][], rule: string): Fill {
		const p = (Array.isArray(polys[0]?.[0]) ? polys : [polys]) as [number, number][][];
		return { box: bounds(p), polys: p, evenOdd: rule === "evenodd", color: "" };
	}

	private clipTo(
		polys: [number, number][][] | [number, number][],
		rule: string,
		approx = false,
	): void {
		this.s.clips = [...this.s.clips, { ...this.region(polys, rule), approx }];
		// Every run is tested against every clip in force; real pages nest a handful.
		if (this.s.clips.length > MAX_CLIPS)
			throw new SeenlineError(
				"invalid",
				"could not read this file: too many nested PDF clipping paths",
			);
	}

	// A fill paints only inside the clipping paths in force, and hides what is under it only when it is
	// near opaque, in a blend mode that does. Inside a soft mask it is the mask, not paint.
	private cover(polys: [number, number][][], color: string, evenOdd: boolean): void {
		// A fill in a layer that is switched off paints nothing.
		if (!polys.length || this.layers.includes(true)) return;
		const m = this.masks.at(-1);
		const { clips, blend, soft } = this.s;
		// Under a clip to glyph outlines (text modes 4 to 7) where the fill paints is not known exactly.
		const approx = clips.some((c) => c.approx);
		const alpha = color === "transparent" ? 0 : this.s.fillAlpha;
		// A fill a reader cannot see changes nothing, on the page or in a mask: not the ground, not what it is over.
		if (alpha < SEEN_ALPHA) return;
		if (m) {
			const solid = color && this.s.fillAlpha === 1 && !soft && m.mask !== "unknown" && !approx;
			if (!solid || m.mask === "unknown") m.mask = "unknown";
			else {
				const f = { ...this.region(polys, evenOdd ? "evenodd" : ""), clips };
				m.mask.fills.push([f, m.luminosity ? lum(color) : 1]);
			}
			return;
		}
		const whole = bounds(polys);
		const box = clips.reduce((b, c) => intersect(b, c.box), whole);
		// A see-through, soft-masked or blended fill is no known ground for white letters ("" counts as light).
		const ground = alpha < 1 || soft || blend !== "source-over" || approx ? "" : color;
		const f: Fill = { box, polys, evenOdd, color: ground, clips };
		this.painted.push(f);
		if (approx) return;
		const [x0, y0, x1, y1] = box;
		for (const it of this.out) {
			// A rule or underline is thin; only a shape as tall as the text can hide it.
			if (y1 - y0 < 0.5 * it.size || x1 - x0 < it.size || it.why.includes("covered")) continue;
			const [mx, my] = it.mid;
			if (alpha * this.let(mx, my) >= COVER_ALPHA && hides(blend, color) && paints(f, mx, my))
				it.why.push("covered");
		}
	}

	// What the soft mask in force lets through at a point: 1 with none, and when it cannot be told.
	private let(x: number, y: number): number {
		const { soft } = this.s;
		if (!soft || soft === "unknown") return 1;
		return soft.fills.findLast(([f]) => paints(f, x, y))?.[1] ?? soft.rest;
	}

	private at(x: number, y: number): [number, number] {
		const c = this.s.ctm;
		return [c[0] * x + c[2] * y + c[4], c[1] * x + c[3] * y + c[5]];
	}

	// Fill and stroke opacity, blend mode, soft mask and font; text drawn at 0 is not there for a reader.
	private gstate(entries: [string, unknown][]): void {
		const s = this.s;
		for (const [key, value] of entries ?? []) {
			if (key === "ca" && typeof value === "number") s.fillAlpha = value;
			if (key === "CA" && typeof value === "number") s.strokeAlpha = value;
			if (key === "BM" && typeof value === "string") s.blend = value;
			if (key === "SMask") {
				s.soft = value ? (this.made ?? "unknown") : null;
				this.made = null;
			}
			if (key === "Font" && Array.isArray(value)) {
				this.font(value[0], value[1] as number);
			}
		}
	}

	private font(id: unknown, size: number): void {
		const em = this.fonts(String(id))?.[0];
		this.s.broken = id === "g_font_error";
		this.s.em = typeof em === "number" && Number.isFinite(em) && em !== 0 ? em : 0.001;
		this.s.fontSize = size;
	}

	private move(tx: number, ty: number) {
		this.tlm = mul([1, 0, 0, 1, tx, ty], this.tlm);
		this.tm = this.tlm;
	}

	private text(fn: number, a: unknown[]): void {
		const { OPS, s } = this;
		const num = a?.[0] as number;
		if (fn === OPS.beginText) {
			this.tm = this.tlm = IDENTITY;
			this.textClip = null;
		} else if (fn === OPS.endText) {
			if (this.textClip) this.clipTo(this.textClip, "nonzero", true);
			this.textClip = null;
		} else if (fn === OPS.setFont) {
			this.font(a[0], a[1] as number);
		} else if (fn === OPS.setFillRGBColor) s.color = String(a[0]);
		else if (fn === OPS.setStrokeRGBColor) s.stroke = String(a[0]);
		// A pattern's colours are not read; an unusable colour paints nothing (pdfjs: transparent).
		else if (fn === OPS.setFillColorN) s.color = "";
		else if (fn === OPS.setStrokeColorN) s.stroke = "";
		else if (fn === OPS.setFillTransparent) s.color = "transparent";
		else if (fn === OPS.setStrokeTransparent) s.stroke = "transparent";
		else if (fn === OPS.setGState) this.gstate(a[0] as [string, unknown][]);
		else if (fn === OPS.setTextRenderingMode) s.mode = num;
		else if (fn === OPS.setHScale) s.hscale = num / 100;
		else if (fn === OPS.setTextRise) s.rise = num;
		else if (fn === OPS.setCharSpacing) s.charSpacing = num;
		else if (fn === OPS.setWordSpacing) s.wordSpacing = num;
		else if (fn === OPS.setLeading) s.leading = num;
		else if (fn === OPS.setTextMatrix) {
			this.tm = this.tlm = Array.from(
				{ length: 6 },
				(_, k) => (a[0] as number[])[k] ?? 0,
			) as Matrix;
		} else if (fn === OPS.moveText) this.move(a[0] as number, a[1] as number);
		else if (fn === OPS.setLeadingMoveText) {
			s.leading = -(a[1] as number);
			this.move(a[0] as number, a[1] as number);
		} else if (fn === OPS.nextLine) this.move(0, -s.leading);
		// pdfjs hands ' and " over as nextLine, the spacing they set and showText.
		else if (fn === OPS.showText || fn === OPS.showSpacedText)
			this.show(a[0] as (Glyph | number)[]);
	}

	// showText hands over glyphs, showSpacedText glyphs mixed with kerning numbers.
	private show(parts: (Glyph | number)[]): void {
		const { s } = this;
		// Text rise (Ts) moves the letters off their baseline, up or down.
		const user = mul(mul([1, 0, 0, 1, 0, s.rise], this.tm), s.ctm);
		const size = s.fontSize * Math.hypot(user[2], user[3]);
		let text = s.broken ? UNREAD : "";
		let unmapped = s.broken;
		let advance = 0; // in text space, before horizontal scaling
		let natural = 0; // the glyphs' own widths
		let spacing = 0; // character and word spacing (Tc, Tw)
		for (const part of parts) {
			if (typeof part === "number") {
				if (-part >= SPACE_KERN && !text.endsWith(" ")) text += " ";
				advance -= (part / 1000) * s.fontSize;
			} else {
				text += part.unicode;
				natural += part.width * s.em * s.fontSize;
				spacing += s.charSpacing + (part.isSpace ? s.wordSpacing : 0);
				// A multi-byte code with no Unicode mapping and no glyph in the font: pdfjs passes the
				// code itself on as text, which says nothing about the letter drawn. A space draws nothing.
				const code = part.originalCharCode;
				unmapped ||=
					!part.isInFont &&
					code > 0xff &&
					part.unicode === String.fromCharCode(code) &&
					!!part.unicode.trim();
			}
		}
		const net = advance + natural + spacing; // kerning, widths and spacing together
		advance = net * s.hscale;
		const point = (x: number, y: number): [number, number] => [
			user[4] + x * user[0] + y * user[2],
			user[5] + x * user[1] + y * user[3],
		];
		if (text.trim()) {
			const shown = inks(s);
			const ink = shown.find((c) => !/^#(f[0-9a-f]){3}$/i.test(c)) ?? shown[0] ?? s.color;
			// Half the run along its baseline, then 0.3 em up: the middle of the letters, not the baseline.
			const mid = point(advance / 2, 0.3 * s.fontSize);
			const [mx, my] = mid;
			const why = hiding(ink, s.mode, size, [[user[4], user[5]], mid], this.view);
			// Text in a soft mask's content is never painted; it only shapes the mask.
			const m = this.masks.at(-1);
			if (m) m.mask = "unknown";
			if (m && !why.includes("invisible")) why.push("invisible");
			else if ((s.mode % 4 !== 3 && !shown.length) || this.let(mx, my) < SEEN_ALPHA)
				why.push("transparent");
			if (this.out.length >= MAX_RUNS) throw new Error("too much text");
			if (this.layers.includes(true)) why.push("hidden layer");
			// Spacing or kerning that steps each letter back onto the one before stacks them (a step back of
			// more than a letter only reverses them).
			const spread = natural ? Math.min(1, Math.abs(net / natural)) : 1;
			const shape = squeeze(user, s.hscale * spread, size);
			if (!(shape >= MIN_HSCALE && shape <= MAX_HSCALE)) why.push("squeezed");
			if (unmapped) why.push("unreadable font");
			const end = user[4] + advance * Math.hypot(user[0], user[1]);
			if (!inside(s.clips, mx, my)) why.push("clipped");
			// White letters on a dark fill or a picture drawn before them are what a reader sees.
			const white = why.indexOf("white");
			const ground = white < 0 ? undefined : this.painted.findLast((p) => paints(p, mx, my));
			if (ground && !light(ground.color) && s.blend === "source-over") why.splice(white, 1);
			const upright = user[0] > 0 && user[3] > 0 && Math.abs(user[1]) < 1e-3 * user[0];
			this.out.push({ text, x: user[4], y: user[5], size, end, mid, upright, why, axis: user });
			if (s.mode >= 4) {
				const [lo, hi] = [-0.25 * s.fontSize, 0.9 * s.fontSize];
				const outline = [point(0, lo), point(advance, lo), point(advance, hi), point(0, hi)];
				this.textClip = [...(this.textClip ?? []), outline];
			}
		}
		this.tm = mul([1, 0, 0, 1, advance, 0], this.tm);
	}
}

// Fill modes (0, 2, 4, 6) paint in the fill colour and opacity, stroke modes (1, 2, 5, 6) in the
// stroke's: the inks a run shows in, those that are not see-through, as they look on a white page.
function inks(s: State): string[] {
	const on = [s.mode % 4 === 0 || s.mode % 4 === 2, s.mode % 4 === 1 || s.mode % 4 === 2];
	return (
		[
			[s.color, s.fillAlpha],
			[s.stroke, s.strokeAlpha],
		] as const
	)
		.filter(([c, alpha], i) => on[i] && c !== "transparent" && alpha >= SEEN_ALPHA)
		.map(([c]) => onWhite(s.blend, c));
}

// The letters' width against their height (1 for ordinary text, rotated or slanted), times `scale`.
function squeeze(user: Matrix, scale: number, size: number): number {
	const det = Math.abs(user[0] * user[3] - user[1] * user[2]);
	return size > 0 ? (scale * (user[0] ** 2 + user[1] ** 2)) / det : scale;
}

const intersect = (a: Box, b: Box): Box => [
	Math.max(a[0], b[0]),
	Math.max(a[1], b[1]),
	Math.min(a[2], b[2]),
	Math.min(a[3], b[3]),
];
const FILLS = [
	"fill",
	"eoFill",
	"fillStroke",
	"eoFillStroke",
	"closeFillStroke",
	"closeEOFillStroke",
];
const PICTURES = ["paintImageXObject", "paintInlineImageXObject", "paintImageMaskXObject"];
// What a run drawn in a font pdfjs could not load says instead of its letters.
const UNREAD = "(letters not decodable)";
const EO_FILLS = ["eoFill", "eoFillStroke", "closeEOFillStroke"];
