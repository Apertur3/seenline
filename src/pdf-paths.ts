// What a fill paints, for the PDF walker: its subpaths as polygons, tested by winding number, so a
// dashed frame, a grid or a connector arrow does not count as a box over everything it surrounds.

import { mix } from "./colour.ts";

export type Box = [number, number, number, number];
type Point = [number, number];
export interface Fill {
	/** The polygons' bounding box, cut to the clipping paths in force. */
	box: Box;
	polys: Point[][];
	evenOdd: boolean;
	color: string;
	/** The clipping paths in force when it was painted: it paints only inside all of them. */
	clips?: Fill[];
	/** A clip to glyph outlines, held as the runs' boxes: proof neither that a fill paints nor that it does not. */
	approx?: boolean;
}

/** pdfjs path data (moveTo 0, lineTo 1, curveTo 2, quadraticCurveTo 3, closePath 4) as polygons, a curve by points along it. */
export function polygons(data: ArrayLike<number>, at: (x: number, y: number) => Point): Point[][] {
	const out: Point[][] = [];
	for (let i = 0; i < data.length; ) {
		const op = data[i++] ?? 4;
		const n = [2, 2, 6, 4][op] ?? 0;
		if (op === 0 || !out.length) out.push([]);
		const poly = out.at(-1) as Point[];
		const ends: Point[] = [];
		for (let k = i; k < i + n; k += 2) ends.push(at(data[k] ?? 0, data[k + 1] ?? 0));
		i += n;
		const from = poly.at(-1);
		poly.push(...(op >= 2 && op <= 3 && from ? curve([from, ...ends]) : ends));
	}
	return out.filter((p) => p.length > 0);
}

// A Bézier curve (its start, control points and end) as points along it, by de Casteljau: no chord
// more than about a quarter point off the curve (Wang's bound), 16 at most, so a path grows 16 times at most.
function curve(p: Point[]): Point[] {
	const off = (a: Point, b: Point, c: Point) =>
		Math.hypot(a[0] - 2 * b[0] + c[0], a[1] - 2 * b[1] + c[1]);
	const [a, b, c, d] = p as [Point, Point, Point, Point?];
	const bend = d ? 0.75 * Math.max(off(a, b, c), off(b, c, d)) : 0.25 * off(a, b, c);
	const n = Math.min(16, Math.ceil(Math.sqrt(bend / 0.25))) || 1; // a straight or unmeasurable one: its end
	const along = (q: Point[], t: number): Point =>
		q.length === 1
			? (q[0] as Point)
			: along(
					q
						.slice(1)
						.map((r, i) => [
							(1 - t) * (q[i] as Point)[0] + t * r[0],
							(1 - t) * (q[i] as Point)[1] + t * r[1],
						]),
					t,
				);
	return Array.from({ length: n }, (_, k) => along(p, (k + 1) / n));
}

export function bounds(polys: Point[][]): Box {
	const b: Box = [Infinity, Infinity, -Infinity, -Infinity];
	for (const [x, y] of polys.flat())
		b.splice(0, 4, Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y));
	return b;
}

/** Whether the fill paints the point: its winding number, by the nonzero or the even-odd rule. */
export function paints(f: Fill, x: number, y: number): boolean {
	const [x0, y0, x1, y1] = f.box;
	if (x < x0 || x > x1 || y < y0 || y > y1) return false;
	let winding = 0;
	for (const poly of f.polys)
		for (const [i, [ax, ay]] of poly.entries()) {
			const [bx, by] = poly[(i + 1) % poly.length] as Point;
			const left = (bx - ax) * (y - ay) - (x - ax) * (by - ay);
			if (ay <= y && by > y && left > 0) winding++;
			else if (ay > y && by <= y && left < 0) winding--;
		}
	const inside = f.evenOdd ? winding % 2 !== 0 : winding !== 0;
	return inside && (f.clips ?? []).every((c) => paints(c, x, y));
}

export const RGB = /^#[0-9a-f]{6}$/i;
// Every channel within 15 of `v` (0 black, 255 white).
const near = (hex: string, v: number) =>
	RGB.test(hex) &&
	[1, 3, 5].every((i) => Math.abs(Number.parseInt(hex.slice(i, i + 2), 16) - v) <= 15);
// What ink in this blend mode looks like on a white page (PDF 32000 11.3.5): most modes leave white white.
export function onWhite(blend: string, hex: string): string {
	if (!RGB.test(hex) || ["source-over", "multiply", "darken", "luminosity"].includes(blend))
		return hex;
	if (blend === "difference" || blend === "exclusion")
		return `#${mix(hex.slice(1), (c) => 255 - c)}`;
	if (blend === "hard-light") return `#${mix(hex.slice(1), (c) => (c <= 127.5 ? 2 * c : 255))}`;
	return "#ffffff";
}
// Whether a fill in this blend mode hides what is under it: in Normal always; black in Multiply or
// Darken and white in Screen, Lighten or ColorDodge too (the same colour over any text and over the page).
export const hides = (blend: string, color: string) =>
	blend === "source-over" ||
	(["multiply", "darken"].includes(blend) && near(color, 0)) ||
	(["screen", "lighten", "color-dodge"].includes(blend) && near(color, 255));
// PDF luminosity (11.6.5.3) of an RRGGBB colour, 0 to 1.
export const lum = (hex: string) =>
	[0.3, 0.59, 0.11].reduce(
		(n, w, i) => n + (w * Number.parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16)) / 255,
		0,
	);
