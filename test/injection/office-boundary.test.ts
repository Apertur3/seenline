import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { officeFixtures } from "../../scripts/office-fixtures.ts";
import { officeKey } from "../../scripts/office-key.ts";
import { HIDDEN_BLOCK, scan } from "../../src/hidden.ts";
import { convert } from "../../src/index.ts";

const fixtures = officeFixtures();
const cases: { file: string; hidden: readonly string[] }[] = officeKey.filter(
	(d) => d.hidden.length > 0,
);

if (process.platform === "darwin") {
	for (const ext of ["doc", "rtf"]) {
		const file = `office-legacy.${ext}`;
		fixtures[file] = await readFile(new URL(`../fixtures/documents/${file}`, import.meta.url));
		cases.push({ file, hidden: ["LEGACY_VANISH", "LEGACY_WHITE", "LEGACY_TINY"] });
	}
}

for (const doc of cases) {
	test(`office boundary: ${doc.file} preserves and flags every hidden payload`, async () => {
		const bytes = fixtures[doc.file];
		assert.ok(bytes);
		const source = await convert(bytes, { name: doc.file });
		assert.ok(source.flags?.includes("markup-hidden"));
		const lines = source.markdown.trimEnd().split("\n");
		const marked = scan(lines);
		const header = lines.indexOf(HIDDEN_BLOCK);
		for (const canary of doc.hidden) {
			const at = lines.findIndex((line) => line.includes(canary));
			assert.ok(at > header && header >= 0, `${canary} belongs after the hidden header`);
			assert.ok(marked.hidden.has(at + 1), `${canary} reaches the reader flagged`);
			assert.equal(lines.filter((line) => line.includes(canary)).length, 1);
			assert.ok(
				source.hidden.some((h) => h.text.includes(canary)),
				`${canary} has parsed hidden metadata`,
			);
		}
	});
}
