// Walks a PDF page's drawing operators for the text a reader sees and the text a reader does not:
// white, tiny, invisible, outside the page box, in a layer that is switched off, or painted over later
// by a fill or an image. pdfjs's own text layer drops several of these without a trace, so the
// operators are read here. Pure JavaScript, no rendering.

import { light } from "./colour.ts";
import { type Box, bounds, type Fill, paints, polygons } from "./pdf-paths.ts";

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
	why: string[];
}
interface Glyph {
	unicode: string;
	width: number;
	originalCharCode: number;
	isInFont: boolean;
}
interface Saved {
	ctm: Matrix;
	fontSize: number;
	color: string;
	stroke: string;
	alpha: number;
	mode: number;
	hscale: number;
	clip: Box | null;
	broken: boolean;
}
export interface Ops {
	fnArray: number[];
	argsArray: unknown[][];
}

const TINY_PT = 2;
// A page with more text runs than this is not a document, and covering is quadratic in it.
const MAX_RUNS = 100_000;
const OFF_PAGE_PT = 5;
// Horizontal scaling (Tz) outside this range makes the letters a smear or a line, not text.
const MIN_HSCALE = 0.2;
const MAX_HSCALE = 10;
// A TJ adjustment this far back is a word space (typesetters write spaces as kerning).
const SPACE_KERN = 200;

export const mul = (a: Matrix, b: Matrix): Matrix => [
	a[0] * b[0] + a[1] * b[2],
	a[0] * b[1] + a[1] * b[3],
	a[2] * b[0] + a[3] * b[2],
	a[2] * b[1] + a[3] * b[3],
	a[4] * b[0] + a[5] * b[2] + b[4],
	a[4] * b[1] + a[5] * b[3] + b[5],
];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const intersect = (a: Box, b: Box): Box => [
	Math.max(a[0], b[0]),
	Math.max(a[1], b[1]),
	Math.min(a[2], b[2]),
	Math.min(a[3], b[3]),
];
// A point just outside the box still counts as in: edges are only as exact as the rounding in the file.
const within = ([x0, y0, x1, y1]: Box, x: number, y: number) =>
	x >= x0 - 1 && x <= x1 + 1 && y >= y0 - 1 && y <= y1 + 1;

// White is every channel at 0xf0 or more; an invisible mode is "neither fill nor stroke" (3) or clip only (7).
function hiding(color: string, mode: number, size: number, x: number, y: number, v: Matrix) {
	const why: string[] = [];
	if (/^#(f[0-9a-f]){3}$/i.test(color)) why.push("white");
	if (size < TINY_PT) why.push("tiny");
	if (mode === 3 || mode === 7) why.push("invisible");
	const off = OFF_PAGE_PT;
	if (x < v[0] - off || x > v[2] + off || y < v[1] - off || y > v[3] + off) why.push("off-page");
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
): { items: Item[]; pictured: number } {
	const w = new Walker(OPS, view, visible);
	for (const [i, fn] of list.fnArray.entries()) w.step(fn, list.argsArray[i] as unknown[]);
	const area = (view[2] - view[0]) * (view[3] - view[1]);
	return { items: w.out, pictured: area > 0 ? w.pictured / area : 0 };
}

class Walker {
	out: Item[] = [];
	pictured = 0;
	private saved: Saved[] = [];
	private ctm = IDENTITY;
	private fontSize = 0;
	private color = "#000000";
	private stroke = "#000000";
	private alpha = 1;
	private mode = 0;
	private hscale = 1;
	// The font in force could not be read at all (pdfjs draws nothing for it).
	private broken = false;
	// The bounding box of the clipping paths in force. pdfjs reports `W` before the path it clips to.
	private clip: Box | null = null;
	private clipping = false;
	private groupBox: number[] | null = null;
	// Every fill and picture so far, in paint order: what lies under text drawn next.
	private painted: Fill[] = [];
	private tm = IDENTITY;
	private tlm = IDENTITY;
	private leading = 0;
	// One entry per open marked-content section: true when it is a layer that is switched off.
	private layers: boolean[] = [];
	private OPS: Record<string, number>;
	private view: Matrix;
	private visible: (layer: unknown) => boolean;

	constructor(OPS: Record<string, number>, view: Matrix, visible: (layer: unknown) => boolean) {
		this.OPS = OPS;
		this.view = view;
		this.visible = visible;
	}

	step(fn: number, a: unknown[]): void {
		const { OPS } = this;
		if (fn === OPS.save || fn === OPS.paintFormXObjectBegin) {
			const { ctm, fontSize, color, stroke, alpha, mode, hscale, clip, broken } = this;
			this.saved.push({ ctm, fontSize, color, stroke, alpha, mode, hscale, clip, broken });
			if (fn !== OPS.paintFormXObjectBegin) return;
			if (a?.[0]) this.ctm = mul(a[0] as Matrix, this.ctm);
			// A form draws nothing outside its bounding box (pdfjs hands a group's box to beginGroup).
			const bbox = (a?.[1] as number[] | null) ?? this.groupBox;
			this.groupBox = null;
			if (bbox) this.clipTo(this.corners([...bbox]));
		} else if (fn === OPS.beginGroup) {
			this.groupBox = (a?.[0] as { bbox?: number[] } | undefined)?.bbox ?? null;
		} else if (fn === OPS.restore || fn === OPS.paintFormXObjectEnd) {
			Object.assign(this, this.saved.pop());
		} else if (fn === OPS.transform) this.ctm = mul(a as Matrix, this.ctm);
		else this.paint(fn, a);
	}

	// Fills and images paint over what came before: the text under them is not what a reader sees.
	private paint(fn: number, a: unknown[]): void {
		const { OPS } = this;
		if (fn === OPS.beginMarkedContentProps) {
			this.layers.push(a[0] === "OC" && !this.visible(a[1]));
		} else if (fn === OPS.beginMarkedContent) this.layers.push(false);
		else if (fn === OPS.endMarkedContent) this.layers.pop();
		else if (fn === OPS.clip || fn === OPS.eoClip) this.clipping = true;
		else if (fn === OPS.constructPath) {
			const box = a[2] as ArrayLike<number> | undefined;
			if (box) {
				const b = this.corners([box[0] ?? 0, box[1] ?? 0, box[2] ?? 0, box[3] ?? 0]);
				if (this.clipping) this.clipTo(b);
				const data = (a[1] as ArrayLike<number>[] | undefined)?.[0];
				const polys = data ? polygons(data, (x, y) => this.at(x, y)) : [this.rect(Array.from(box))];
				// A see-through or soft-masked fill is no known ground for white letters ("" counts as light).
				const ground = this.alpha < 1 ? "" : this.color;
				if (FILLS.some((n) => OPS[n] === a[0]))
					this.cover(
						polys,
						ground,
						EO_FILLS.some((n) => OPS[n] === a[0]),
					);
			}
			this.clipping = false;
		} else if (PICTURES.some((n) => OPS[n] === fn)) {
			const [x0, y0, x1, y1] = intersect(this.corners([0, 0, 1, 1]), this.view.slice(0, 4) as Box);
			this.pictured += Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
			// A picture's pixels are not read: under white letters it is unknown, so they stay flagged.
			if (fn !== OPS.paintImageMaskXObject) this.cover([this.rect([0, 0, 1, 1])], "", false);
		} else this.text(fn, a);
	}

	private corners([x0, y0, x1, y1]: number[]): [number, number, number, number] {
		const c = this.ctm;
		const xs: number[] = [];
		const ys: number[] = [];
		for (const [x, y] of [
			[x0, y0],
			[x1, y0],
			[x0, y1],
			[x1, y1],
		] as [number, number][]) {
			xs.push(c[0] * x + c[2] * y + c[4]);
			ys.push(c[1] * x + c[3] * y + c[5]);
		}
		return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
	}

	private clipTo(b: Box): void {
		this.clip = this.clip ? intersect(this.clip, b) : b;
	}

	// A fill paints only inside the clipping paths in force.
	private cover(polys: [number, number][][], color: string, evenOdd: boolean): void {
		if (!polys.length) return;
		const whole = bounds(polys);
		const f: Fill = { box: this.clip ? intersect(this.clip, whole) : whole, polys, evenOdd, color };
		this.painted.push(f);
		const [x0, y0, x1, y1] = f.box;
		for (const it of this.out) {
			// A rule or underline is thin; only a shape as tall as the text can hide it.
			if (y1 - y0 < 0.5 * it.size || x1 - x0 < it.size || it.why.includes("covered")) continue;
			if (paints(f, ...it.mid)) it.why.push("covered");
		}
	}

	private at(x: number, y: number): [number, number] {
		const c = this.ctm;
		return [c[0] * x + c[2] * y + c[4], c[1] * x + c[3] * y + c[5]];
	}

	private rect([x0 = 0, y0 = 0, x1 = 0, y1 = 0]: number[]): [number, number][] {
		return [this.at(x0, y0), this.at(x1, y0), this.at(x1, y1), this.at(x0, y1)];
	}

	// Fill and stroke opacity: text drawn at 0 is not there for a reader.
	private gstate(entries: [string, unknown][]): void {
		for (const [key, value] of entries ?? []) {
			if ((key === "CA" || key === "ca") && typeof value === "number") this.alpha = value;
			// A soft mask may let anything through: a hair under 1, so no fill counts as ground.
			if (key === "SMask" && value) this.alpha = Math.min(this.alpha, 0.99);
		}
	}

	private move(tx: number, ty: number) {
		this.tlm = mul([1, 0, 0, 1, tx, ty], this.tlm);
		this.tm = this.tlm;
	}

	private text(fn: number, a: unknown[]): void {
		const { OPS } = this;
		const parts = (i: number) => a[i] as (Glyph | number)[];
		if (fn === OPS.beginText) this.tm = this.tlm = IDENTITY;
		else if (fn === OPS.setFont) {
			this.broken = a[0] === "g_font_error";
			this.fontSize = a[1] as number;
		} else if (fn === OPS.setFillRGBColor) this.color = String(a[0]);
		else if (fn === OPS.setStrokeRGBColor) this.stroke = String(a[0]);
		else if (fn === OPS.setGState) this.gstate(a[0] as [string, unknown][]);
		else if (fn === OPS.setTextRenderingMode) this.mode = a[0] as number;
		else if (fn === OPS.setHScale) this.hscale = (a[0] as number) / 100;
		else if (fn === OPS.setLeading) this.leading = a[0] as number;
		else if (fn === OPS.setTextMatrix) {
			this.tm = this.tlm = Array.from(
				{ length: 6 },
				(_, k) => (a[0] as number[])[k] ?? 0,
			) as Matrix;
		} else if (fn === OPS.moveText) this.move(a[0] as number, a[1] as number);
		else if (fn === OPS.setLeadingMoveText) {
			this.leading = -(a[1] as number);
			this.move(a[0] as number, a[1] as number);
		} else if (fn === OPS.nextLine) this.move(0, -this.leading);
		else if (fn === OPS.showText || fn === OPS.showSpacedText) this.show(parts(0));
		else if (fn === OPS.nextLineShowText || fn === OPS.nextLineSetSpacingShowText) {
			this.move(0, -this.leading);
			this.show(parts(fn === OPS.nextLineShowText ? 0 : 2));
		}
	}

	// showText hands over glyphs, showSpacedText glyphs mixed with kerning numbers.
	private show(parts: (Glyph | number)[]): void {
		const user = mul(this.tm, this.ctm);
		const size = this.fontSize * Math.hypot(user[2], user[3]);
		let text = this.broken ? UNREAD : "";
		let unmapped = this.broken;
		let advance = 0; // in text space, before horizontal scaling
		for (const part of parts) {
			if (typeof part === "number") {
				if (-part >= SPACE_KERN && !text.endsWith(" ")) text += " ";
				advance -= (part / 1000) * this.fontSize;
			} else {
				text += part.unicode;
				advance += (part.width / 1000) * this.fontSize;
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
		advance *= this.hscale;
		if (text.trim()) {
			// An outline-only mode is painted in the stroke colour.
			const ink = this.mode === 1 || this.mode === 5 ? this.stroke : this.color;
			const why = hiding(ink, this.mode, size, user[4], user[5], this.view);
			if (this.alpha < 0.05) why.push("transparent");
			if (this.out.length >= MAX_RUNS) throw new Error("too much text");
			if (this.layers.includes(true)) why.push("hidden layer");
			if (this.hscale < MIN_HSCALE || this.hscale > MAX_HSCALE) why.push("squeezed");
			if (unmapped) why.push("unreadable font");
			const end = user[4] + advance * Math.hypot(user[0], user[1]);
			// Half the run along its baseline, then 0.3 em up: the middle of the letters, not the baseline.
			const mid: [number, number] = [
				user[4] + (advance * user[0]) / 2 + 0.3 * this.fontSize * user[2],
				user[5] + (advance * user[1]) / 2 + 0.3 * this.fontSize * user[3],
			];
			const [mx, my] = mid;
			if (this.clip && !within(this.clip, mx, my)) why.push("clipped");
			// White letters on a dark fill or a picture drawn before them are what a reader sees.
			const white = why.indexOf("white");
			const ground = white < 0 ? undefined : this.painted.findLast((p) => paints(p, mx, my));
			if (ground && !light(ground.color)) why.splice(white, 1);
			const upright = user[0] > 0 && user[3] > 0 && Math.abs(user[1]) < 1e-3 * user[0];
			this.out.push({ text, x: user[4], y: user[5], size, end, mid, upright, why });
		}
		this.tm = mul([1, 0, 0, 1, advance, 0], this.tm);
	}
}

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
