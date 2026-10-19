import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { NO_TEXT_LAYER } from "../src/documents.ts";
import { convert } from "../src/index.ts";
import type { ConvertOptions } from "../src/types.ts";

const run = async (name: string, opts: Partial<ConvertOptions> = {}) =>
	convert(await readFile(new URL(`./fixtures/pdf-hiding/${name}`, import.meta.url)), {
		name,
		...opts,
	});

for (const [name, canary, reason] of [
	["clipped.pdf", "CANARY-PDF-CLIPPED", "clipped"],
	["squeezed.pdf", "CANARY-PDF-SQUEEZED", "squeezed"],
]) {
	test(`${name}: flagged as hidden, kept out of the body`, async () => {
		const { markdown, hidden } = await run(name as string);
		const [body = "", block = ""] = markdown.split("[Hidden in the original]");
		assert.ok(!body.includes(canary as string), "canary is not in the body");
		assert.ok(block.includes(canary as string), "canary is in the hidden block");
		assert.ok(block.includes(reason as string), "the reason is named");
		assert.ok(hidden.length > 0 && body.includes("Approved budget"));
	});
}

test("clip-holds.pdf: text inside its clip stays in the body", async () => {
	const { markdown, hidden } = await run("clip-holds.pdf");
	assert.ok(markdown.includes("Clipped but inside the box."));
	assert.equal(hidden.length, 0);
});

const before = ["[p. 1]", "Approved budget: EUR 100,000 for 2027.", "[p. 2]"];
const after = ["[p. 3]", "Signed off on 3 March 2027.", ""];
test("weak-page.pdf: without text recognition the near-empty page is marked, not dropped", async () => {
	const { markdown, pages } = await run("weak-page.pdf");
	assert.equal(markdown, [...before, NO_TEXT_LAYER, "2 of 3", ...after].join("\n"));
	assert.equal(pages, 3);
	const ocr = async () => {
		throw new Error("recogniser down");
	};
	assert.equal((await run("weak-page.pdf", { ocr })).markdown, markdown);
});

test("weak-page.pdf: with text recognition the page is read as before, with no marker", async () => {
	const ocr = async () => ({ pages: ["", "Figure 2: costs", ""], extras: [] });
	const { markdown } = await run("weak-page.pdf", { ocr });
	assert.equal(markdown, [...before, "Figure 2: costs", ...after].join("\n"));
});
