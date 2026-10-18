import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { convert } from "../src/index.ts";

const run = async (name: string) =>
	convert(await readFile(new URL(`./fixtures/pdf-hiding/${name}`, import.meta.url)), { name });

for (const [name, canary, reason] of [
	["clipped.pdf", "CANARY-PDF-CLIPPED", "clipped"],
	["squeezed.pdf", "CANARY-PDF-SQUEEZED", "squeezed"],
	["form-covers.pdf", "CANARY-PDF-FORM-COVER", "covered"],
	["rotated-clipped.pdf", "CANARY-PDF-ROTATED-CLIP", "clipped"],
	["properties.pdf", "CANARY-PDF-META", "metadata Subject"],
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
]) {
	test(`${name}: visible text stays in the body`, async () => {
		const { markdown, hidden } = await run(name as string);
		assert.ok(markdown.includes(text as string));
		assert.equal(hidden.length, 0);
	});
}
