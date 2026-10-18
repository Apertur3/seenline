import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { convert } from "plainview";
import { scan } from "plainview/hidden";

for (const name of ["report.pdf", "office-memo.docx", "office-book.xlsx"]) {
	const bytes = await readFile(new URL(`../test/fixtures/documents/${name}`, import.meta.url));
	const result = await convert(bytes, { name });
	assert.ok(result.markdown.trim());
	assert.ok(result.pages > 0);
	assert.deepEqual(result.flags, scan(result.markdown.trimEnd().split("\n")).flags);
	console.log(`Built ESM smoke: ${name} (${result.pages} pages)`);
}
