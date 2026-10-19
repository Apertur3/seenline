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
	["form-covers.pdf", "CANARY-PDF-FORM-COVER", "covered"],
	["rotated-clipped.pdf", "CANARY-PDF-ROTATED-CLIP", "clipped"],
	["properties.pdf", "CANARY-PDF-META", "metadata Subject"],
	["frame-covers.pdf", "CANARY-PDF-FRAME-COVER", "covered"],
	["ring-filled.pdf", "CANARY-PDF-RING-COVER", "covered"],
	["white-on-light.pdf", "CANARY-PDF-WHITE-LIGHT", "white"],
	["white-on-picture.pdf", "CANARY-PDF-WHITE-PICTURE", "white"],
	["shuffled-line.pdf", "Please do approve this payment. not", "reading order"],
	["grid-down.pdf", "Alder Cedar Elm Birch Daisy Fern", "reading order"],
]) {
	test(`${name}: flagged as hidden, kept out of the body`, async () => {
		const { markdown, hidden } = await run(name as string);
		const [body = "", block = ""] = markdown.split("[Hidden in the original]");
		assert.ok(!body.includes(canary as string), "canary is not in the body");
		assert.ok(block.includes(canary as string), "canary is in the hidden block");
		assert.ok(block.includes(reason as string), "the reason is named");
		assert.ok(hidden.length > 0 && body.includes("Approved budget"));
		assert.doesNotMatch(block, /untitled|anonymous/, "placeholder properties are not listed");
	});
}

// Each is the visible twin of a hidden case above: the same drawing, but a reader sees the text.
for (const [name, text] of [
	["clip-holds.pdf", "Clipped but inside the box."],
	["form-beside.pdf", "Shown to every reader."],
	["rotated-holds.pdf", "Shown to every reader."],
	["frame-around.pdf", "Shown to every reader."],
	["ring-hole.pdf", "Shown to every reader."],
	["white-on-dark.pdf", "Shown to every reader."],
	["in-order-line.pdf", "Please do not approve this payment."],
	[
		"two-columns.pdf",
		"The left column opens\nthe page and runs on\nto its end.\nThe right column comes",
	],
]) {
	test(`${name}: visible text stays in the body`, async () => {
		const { markdown, hidden } = await run(name as string);
		assert.ok(markdown.includes(text as string));
		assert.equal(hidden.length, 0);
	});
}

// The body of a page stored out of reading order reads as the page does.
for (const [name, text] of [
	["shuffled-line.pdf", "Please do not approve this payment."],
	["grid-down.pdf", "Alder | Birch\nCedar | Daisy\nElm | Fern"],
]) {
	test(`${name}: the body is in reading order`, async () => {
		const [body = ""] = (await run(name as string)).markdown.split("[Hidden in the original]");
		assert.ok(body.includes(text as string));
	});
}

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
