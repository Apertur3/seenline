// What a fill paints, for the PDF walker: its subpaths as polygons, tested by winding number, so a
// dashed frame, a grid or a connector arrow does not count as a box over everything it surrounds.

export type Box = [number, number, number, number];
type Point = [number, number];
export interface Fill {
	/** The polygons' bounding box, cut to the clipping paths in force. */
	box: Box;
	polys: Point[][];
	evenOdd: boolean;
	color: string;
}

/** pdfjs path data (moveTo 0, lineTo 1, curveTo 2, quadraticCurveTo 3, closePath 4) as polygons; a curve by its control points. */
export function polygons(data: ArrayLike<number>, at: (x: number, y: number) => Point): Point[][] {
	const out: Point[][] = [];
	for (let i = 0; i < data.length; ) {
		const op = data[i++] ?? 4;
		const n = [2, 2, 6, 4][op] ?? 0;
		if (op === 0 || !out.length) out.push([]);
		for (let k = i; k < i + n; k += 2) out.at(-1)?.push(at(data[k] ?? 0, data[k + 1] ?? 0));
		i += n;
	}
	return out.filter((p) => p.length > 0);
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
	return f.evenOdd ? winding % 2 !== 0 : winding !== 0;
}
