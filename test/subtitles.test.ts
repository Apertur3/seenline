import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { convert, PlainviewError } from "../src/index.ts";

for (const ext of ["vtt", "srt"]) {
	test(`${ext} preserves speakers, time spans, entities and cue order`, async () => {
		const name = `kestrel-2026-10-14-reorg-review.${ext}`;
		const bytes = await readFile(new URL(`./fixtures/subtitles/${name}`, import.meta.url));
		const result = await convert(bytes, { name });
		const lines = result.markdown.trimEnd().split("\n");
		assert.equal(lines.length, ext === "vtt" ? 4 : 3);
		assert.equal(
			lines[0],
			"[00:00:08.000 --> 00:00:24.500] Mara Lindqvist: Two things today: the role map and the headcount.",
		);
		assert.equal(
			lines[2],
			"[00:02:05.250 --> 00:02:21.000] Joost de Wit: So the new number: the merged Operations unit is budgeted at 44 FTE, not 48.",
		);
		assert.doesNotMatch(result.markdown, /<v|<i|\{\\/);
		assert.deepEqual(result.flags, []);
	});
}
test("subtitles without cues fail closed", async () => {
	await assert.rejects(
		convert(Buffer.from("WEBVTT\n\nNOTE nothing here\n"), { name: "empty.vtt" }),
		(error: unknown) =>
			error instanceof PlainviewError &&
			error.code === "invalid" &&
			error.message === "no subtitle cues found",
	);
});
