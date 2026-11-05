// WebVTT and SubRip files to the timed lines of the timed-line format: one line per cue.

import { clock, formatCue } from "./cues.ts";
import { SeenlineError } from "./error.ts";
import { HIDDEN_BLOCK } from "./hidden.ts";
import { cssHidden, cssRules, declarations } from "./html-style.ts";

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
		.replace(/<v(?:\.[^\s<>]*)?\s+([^<>]*)>/g, " $1: ") // `<` ends a try: one scan per character
		.replace(/<[^<>]*>|\{\\[^{}]*\}/g, "")
		.replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name: string) => ENTITIES[name] ?? "")
		.replace(/\s+/g, " ")
		.trim();
}

// A colour as #rrggbb where it is plain (a name, #rgb, rgb() or rgba() without its alpha), else as written.
const hex = (c: string) =>
	c
		.replace(/\s/g, "")
		.replace(/^white$/, "#ffffff")
		.replace(/^black$/, "#000000")
		.replace(/^#([\da-f])([\da-f])([\da-f])$/, "#$1$1$2$2$3$3")
		.replace(
			/^rgba?\((\d+),(\d+),(\d+)(?:,[\d.]+%?)?\)$/,
			(_, ...v: string[]) =>
				`#${v
					.slice(0, 3)
					.map((n) => Number(n).toString(16).padStart(2, "0"))
					.join("")}`,
		);
// A cue colour hides its text when it is (almost) see-through or the ground's, black when the rule
// names none (the player's cue box). Any other colour shows, white, the usual one, included.
function unseen(color: string, ground = "black"): boolean {
	// The fourth component of rgb(a) or hsl(a), after commas or a slash.
	const alpha =
		/^(?:rgb|hsl)a?\((?:[^,/)]*,){3}([\d.]+)(%?)\)$|^(?:rgb|hsl)a?\([^,/)]*\/([\d.]+)(%?)\)$/.exec(
			color.replace(/\s/g, ""),
		);
	const faint = alpha && Number(alpha[1] ?? alpha[3]) / (alpha[2] || alpha[4] ? 100 : 1) < 0.1;
	return (
		color === "transparent" ||
		!!faint ||
		/^#[\da-f]{6}(?:0|1)[\da-f]$/.test(hex(color)) ||
		hex(color) === hex(ground)
	);
}

// Whether a STYLE block has a rule that can hide cue text; a block that is not whole rules is refused.
function hides(block: string): boolean {
	try {
		return cssRules(block).some(([, body]) => {
			const {
				background,
				"background-color": ground = background,
				color,
				...css
			} = declarations(body);
			return cssHidden(css) || (!!color && unseen(color, ground));
		});
	} catch {
		throw new SeenlineError(
			"invalid",
			"could not read this file: a subtitle style that cannot be read safely",
		);
	}
}

export function subtitlesToText(raw: string): string {
	const lines: string[] = [];
	let styled = false;
	const blocks = raw
		.replace(/^﻿/, "")
		.replace(/\r\n?/g, "\n")
		.split(/\n\s*\n/);
	for (const block of blocks) {
		const rows = block.split("\n");
		const at = rows.findIndex((row) => TIMING.test(row));
		const t = TIMING.exec(rows[at] ?? "");
		// Headers, NOTE, STYLE and REGION blocks have no timing line.
		if (!t) {
			if (/^STYLE\b/.test(rows[0] ?? "")) styled ||= hides(rows.slice(1).join("\n"));
			continue;
		}
		const text = plain(rows.slice(at + 1).join(" "));
		if (text === "") continue;
		lines.push(formatCue(clock(t.slice(1, 5)), clock(t.slice(5, 9)), text));
	}
	if (lines.length === 0) throw new SeenlineError("invalid", "no subtitle cues found");
	// A style that can hide a cue hides an unknown set of them: every cue is listed, none is shown.
	const out = styled ? [HIDDEN_BLOCK, ...lines.map((l) => `hidden cue style: ${l}`)] : lines;
	return `${out.join("\n")}\n`;
}
