// RRGGBB colour arithmetic the readers share to tell what is behind white text.

/** RRGGBB with each channel passed through `f`. */
export function mix(rgb: string, f: (x: number) => number): string {
	return [0, 2, 4]
		.map((i) => Math.round(Math.min(255, Math.max(0, f(Number.parseInt(rgb.slice(i, i + 2), 16))))))
		.map((x) => x.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Whether white text on this ground is hard to see, or the ground is not given as RRGGBB: white on
 * it has a contrast ratio under 3 (WCAG relative luminance above 0.3), as on cyan, lime or yellow.
 */
export function light(rgb = ""): boolean {
	const hex = /^#?[\da-f]{6}$/i.test(rgb) ? rgb.replace("#", "") : "FFFFFF";
	const [r = 1, g = 1, b = 1] = [0, 2, 4].map((i) => {
		const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.3;
}
