// Harness smoke run on the repo's own fixtures: no network, no Python, no downloads.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { corpus } from "./corpus.ts";
import { ours } from "./ours.ts";
import { HEAD, markdown, rows, tsv } from "./report.ts";

const cache = await mkdtemp(join(tmpdir(), "plainview-bench-"));
after(() => rm(cache, { recursive: true, force: true }));
const entries = corpus(cache);

test("the corpus holds the fixtures once each, with the Unicode and PDF-hiding controls", () => {
	const files = entries.map((e) => e.file);
	assert.equal(new Set(files).size, files.length);
	for (const f of [
		"unicode-tag-chars.html",
		"unicode-bidi.html",
		"unicode-variation-bmp.html",
		"unicode-variation-supp.html",
		"inj-pdf-unicode.pdf",
		"clipped.pdf",
	])
		assert.ok(files.includes(f), f);
	assert.ok(
		entries.every((e) => e.set === "C"),
		"nothing from the cache before prepare",
	);
});

test("Plainview leaks no hidden payload of the control set, and the report is complete", async () => {
	await ours(cache, entries, 1);
	const rs = rows(cache);
	const mine = rs.filter((r) => r.candidate === "plainview");
	assert.equal(mine.length, entries.length);
	const leaks = mine.filter((r) => r.outcome === "leaked").map((r) => r.entry.file);
	assert.deepEqual(leaks, []);
	assert.ok(mine.filter((r) => r.outcome === "flagged").length > 10);
	// competitors were not run: said so, per file, with a reason
	const other = rs.find((r) => r.candidate === "markitdown" && r.entry.file === "report.pdf");
	assert.equal(other?.status, "not-run");
	const table = tsv(rs).split("\n");
	assert.deepEqual(table[0]?.split("\t"), HEAD);
	assert.ok(table.slice(1, -1).every((line) => line.split("\t").length === HEAD.length));
	const doc = markdown(rs, cache);
	for (const heading of [
		"## Tools run",
		"## Set B",
		"## Set C",
		"## Tokens",
		"## Speed",
		"## Anchors",
		"## Speed and size",
	])
		assert.ok(doc.includes(heading), heading);
	assert.doesNotMatch(doc, /\b(first|only)\b/i);
});
