import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { convert } from "../src/index.ts";

const run = async (name: string) =>
	convert(await readFile(new URL(`./fixtures/pdf-hiding/${name}`, import.meta.url)), { name });

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
