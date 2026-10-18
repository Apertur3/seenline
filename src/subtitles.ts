// WebVTT and SubRip files to the timed lines of the timed-line format: one line per cue.

import { clock, formatCue } from "./cues.ts";
import { PlainviewError } from "./error.ts";

const TIMING =
	/^\s*(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})\s+-->\s+(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})/;
const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};

// `<v Name>` is a speaker: it becomes "Name: ". Every other tag (italics, karaoke times, {\an8}) goes.
function plain(text: string): string {
	return text
		.replace(/<v(?:\.[^\s>]*)?\s+([^>]*)>/g, " $1: ")
		.replace(/<[^>]*>|\{\\[^}]*\}/g, "")
		.replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name: string) => ENTITIES[name] ?? "")
		.replace(/\s+/g, " ")
		.trim();
}

export function subtitlesToText(raw: string): string {
	const lines: string[] = [];
	const blocks = raw
		.replace(/^﻿/, "")
		.replace(/\r\n?/g, "\n")
		.split(/\n\s*\n/);
	for (const block of blocks) {
		const rows = block.split("\n");
		const at = rows.findIndex((row) => TIMING.test(row));
		const t = TIMING.exec(rows[at] ?? "");
		// Headers, NOTE, STYLE and REGION blocks have no timing line.
		if (!t) continue;
		const text = plain(rows.slice(at + 1).join(" "));
		if (text === "") continue;
		lines.push(formatCue(clock(t.slice(1, 5)), clock(t.slice(5, 9)), text));
	}
	if (lines.length === 0) throw new PlainviewError("invalid", "no subtitle cues found");
	return `${lines.join("\n")}\n`;
}
