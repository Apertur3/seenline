import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { fixtureOcr } from "../scripts/ocr-stub.ts";
import { convert } from "./text-mode.ts";

let count = 0;
for (const group of ["documents", "injection", "subtitles"]) {
	const fixtures = new URL(`./fixtures/${group}/`, import.meta.url);
	const goldens = new URL(`./golden/${group}/`, import.meta.url);
	const names = (await readdir(fixtures)).filter((name) => !name.startsWith("a4-")).sort();
	assert.deepEqual((await readdir(goldens)).sort(), names.map((name) => `${name}.md`).sort());
	for (const name of names) {
		count++;
		test(`golden byte parity: ${group}/${name}`, {
			skip: /\.(doc|rtf)$/.test(name) && process.platform !== "darwin" && "requires macOS textutil",
		}, async () => {
			const bytes = await readFile(new URL(name, fixtures));
			const before = Buffer.from(bytes);
			const { markdown } = await convert(bytes, { name, ocr: async () => fixtureOcr(name) });
			// textutil stamps its OS-specific build into docProps; the rest stays byte-identical.
			const same = (text: string) => text.replace(/(CocoaOOXMLWriter\/)[\d.]+/, "$1x");
			const golden = await readFile(new URL(`${name}.md`, goldens), "utf8");
			assert.deepEqual(Buffer.from(same(markdown)), Buffer.from(same(golden)));
			assert.deepEqual(bytes, before, "conversion leaves caller bytes unchanged");
		});
	}
}
test(`golden inventory: ${count} fixtures`, () => assert.ok(count >= 62));
