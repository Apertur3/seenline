const pad = (n: number, width = 2) => String(n).padStart(width, "0");

function stamp(seconds: number): string {
	const ms = Math.round(seconds * 1000);
	const hms = [
		Math.floor(ms / 3_600_000),
		Math.floor(ms / 60_000) % 60,
		Math.floor(ms / 1000) % 60,
	];
	return `${hms.map((n) => pad(n)).join(":")}.${pad(ms % 1000, 3)}`;
}

export function formatCue(start: number, end: number, text: string): string {
	return `[${stamp(start)} --> ${stamp(end)}] ${text}`;
}

/** Seconds from the [hours, minutes, seconds, milliseconds] groups of a clock reading. */
export function clock(groups: (string | undefined)[]): number {
	return [3600, 60, 1, 0.001].reduce((sum, unit, i) => sum + unit * Number(groups[i] ?? 0), 0);
}
