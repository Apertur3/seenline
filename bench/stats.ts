/** Linear-interpolated percentile of a sorted copy of xs; p in 0..100. */
export function percentile(xs: number[], p: number): number {
	const s = [...xs].sort((a, b) => a - b);
	if (s.length === 0) return Number.NaN;
	const at = ((s.length - 1) * p) / 100;
	const lo = Math.floor(at);
	return (s[lo] ?? 0) + ((s[Math.ceil(at)] ?? 0) - (s[lo] ?? 0)) * (at - lo);
}

export const median = (xs: number[]) => percentile(xs, 50);

export const stats = (xs: number[]) => ({
	median: median(xs),
	p10: percentile(xs, 10),
	p90: percentile(xs, 90),
	n: xs.length,
});
