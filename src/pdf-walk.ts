// Walks a PDF page's drawing operators for the text a reader sees and the text a reader does not:
// white, tiny, invisible, outside the page box, in a layer that is switched off, or painted over later
// by a fill or an image. pdfjs's own text layer drops several of these without a trace, so the
// operators are read here. Pure JavaScript, no rendering.

export type Matrix = [number, number, number, number, number, number];
export interface Item {
	text: string;
	x: number;
	y: number;
	size: number;
	end: number;
	why: string[];
}
interface Glyph {
	unicode: string;
	width: number;
}
interface Saved {
	ctm: Matrix;
	fontSize: number;
	color: string;
	stroke: string;
	alpha: number;
	mode: number;
}
export interface Ops {
	fnArray: number[];
	argsArray: unknown[][];
}

const TINY_PT = 2;
// A page with more text runs than this is not a document, and covering is quadratic in it.
const MAX_RUNS = 100_000;
const OFF_PAGE_PT = 5;
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

/** Everything one page shows, in content-stream order; `visible` says whether a layer is switched on. */
export function walk(
	OPS: Record<string, number>,
	list: Ops,
	view: Matrix,
	visible: (layer: unknown) => boolean,
): Item[] {
	const w = new Walker(OPS, view, visible);
	for (const [i, fn] of list.fnArray.entries()) w.step(fn, list.argsArray[i] as unknown[]);
	return w.out;
}

class Walker {
	out: Item[] = [];
	private saved: Saved[] = [];
	private ctm = IDENTITY;
	private fontSize = 0;
	private color = "#000000";
	private stroke = "#000000";
	private alpha = 1;
	private mode = 0;
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
			const { ctm, fontSize, color, stroke, alpha, mode } = this;
			this.saved.push({ ctm, fontSize, color, stroke, alpha, mode });
			if (fn === OPS.paintFormXObjectBegin && a?.[0]) this.ctm = mul(a[0] as Matrix, this.ctm);
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
		else if (fn === OPS.constructPath && FILLS.some((n) => OPS[n] === a[0])) {
			const box = a[2] as ArrayLike<number> | undefined;
			if (box) this.cover(this.corners([box[0] ?? 0, box[1] ?? 0, box[2] ?? 0, box[3] ?? 0]));
		} else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
			this.cover(this.corners([0, 0, 1, 1]));
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

	private cover([x0, y0, x1, y1]: [number, number, number, number]): void {
		for (const it of this.out) {
			const mx = (it.x + it.end) / 2;
			const my = it.y + 0.3 * it.size; // the middle of the letters, not their baseline
			const inside = mx >= x0 && mx <= x1 && my >= y0 && my <= y1;
			// A rule or underline is thin; only a shape as tall as the text can hide it.
			if (inside && y1 - y0 >= 0.5 * it.size && x1 - x0 >= it.size && !it.why.includes("covered"))
				it.why.push("covered");
		}
	}

	// Fill and stroke opacity: text drawn at 0 is not there for a reader.
	private gstate(entries: [string, unknown][]): void {
		for (const [key, value] of entries ?? []) {
			if ((key === "CA" || key === "ca") && typeof value === "number") this.alpha = value;
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
		else if (fn === OPS.setFont) this.fontSize = a[1] as number;
		else if (fn === OPS.setFillRGBColor) this.color = String(a[0]);
		else if (fn === OPS.setStrokeRGBColor) this.stroke = String(a[0]);
		else if (fn === OPS.setGState) this.gstate(a[0] as [string, unknown][]);
		else if (fn === OPS.setTextRenderingMode) this.mode = a[0] as number;
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
		let text = "";
		let advance = 0; // in text space
		for (const part of parts) {
			if (typeof part === "number") {
				if (-part >= SPACE_KERN && !text.endsWith(" ")) text += " ";
				advance -= (part / 1000) * this.fontSize;
			} else {
				text += part.unicode;
				advance += (part.width / 1000) * this.fontSize;
			}
		}
		if (text.trim()) {
			// An outline-only mode is painted in the stroke colour.
			const ink = this.mode === 1 || this.mode === 5 ? this.stroke : this.color;
			const why = hiding(ink, this.mode, size, user[4], user[5], this.view);
			if (this.alpha < 0.05) why.push("transparent");
			if (this.out.length >= MAX_RUNS) throw new Error("too much text");
			if (this.layers.includes(true)) why.push("hidden layer");
			const end = user[4] + advance * Math.hypot(user[0], user[1]);
			this.out.push({ text, x: user[4], y: user[5], size, end, why });
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
