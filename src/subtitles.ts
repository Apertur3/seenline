// WebVTT and SubRip files to the timed lines of the timed-line format: one line per cue.

import { clock, formatCue } from "./cues.ts";
import { PlainviewError } from "./error.ts";
import { HIDDEN_BLOCK } from "./hidden.ts";
import { cssHidden, declarations } from "./html-style.ts";

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

// Whether a STYLE block has a rule that can hide cue text. White is the usual cue colour, and a cue's
// background is the player's, so only a ground the rule names counts.
function hides(block: string): boolean {
	const raw = block.replace(/\/\*[\s\S]*?\*\//g, "");
	try {
		return [...raw.matchAll(/\{([^{}]*)\}/g)].some(([, body = ""]) => {
			const { background, "background-color": ground = background, ...css } = declarations(body);
			if (/^(?:white|#fff(?:fff)?)$/.test(css.color ?? "")) delete css.color;
			return cssHidden(css) || (!!css.color && css.color === (ground ?? "black"));
		});
	} catch {
		throw new PlainviewError(
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
			if (/^STYLE\s*$/.test(rows[0] ?? "")) styled ||= hides(rows.slice(1).join("\n"));
			continue;
		}
		const text = plain(rows.slice(at + 1).join(" "));
		if (text === "") continue;
		lines.push(formatCue(clock(t.slice(1, 5)), clock(t.slice(5, 9)), text));
	}
	if (lines.length === 0) throw new PlainviewError("invalid", "no subtitle cues found");
	// A style that can hide a cue hides an unknown set of them: every cue is listed, none is shown.
	const out = styled ? [HIDDEN_BLOCK, ...lines.map((l) => `hidden cue style: ${l}`)] : lines;
	return `${out.join("\n")}\n`;
}
