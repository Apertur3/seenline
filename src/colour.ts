// RRGGBB colour arithmetic the readers share to tell what is behind white text.

/** RRGGBB with each channel passed through `f`. */
export function mix(rgb: string, f: (x: number) => number): string {
	return [0, 2, 4]
		.map((i) => Math.round(Math.min(255, Math.max(0, f(Number.parseInt(rgb.slice(i, i + 2), 16))))))
		.map((x) => x.toString(16).padStart(2, "0"))
		.join("");
}

/** Whether white text on this ground is hard to see: a light RRGGBB colour, or one not given as RRGGBB. */
export function light(rgb = ""): boolean {
	const hex = /^#?[\da-f]{6}$/i.test(rgb) ? rgb.replace("#", "") : "FFFFFF";
	const [r = 255, g = 255, b = 255] = [0, 2, 4].map((i) =>
		Number.parseInt(hex.slice(i, i + 2), 16),
	);
	return 0.299 * r + 0.587 * g + 0.114 * b > 180;
}
