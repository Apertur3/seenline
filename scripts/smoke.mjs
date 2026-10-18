import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
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

const markdown = execFileSync(
	process.execPath,
	[
		fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
		fileURLToPath(new URL("../test/fixtures/documents/report.pdf", import.meta.url)),
	],
	{ encoding: "utf8" },
);
assert.equal(
	markdown,
	await readFile(new URL("../test/golden/documents/report.pdf.md", import.meta.url), "utf8"),
);
console.log("Built CLI smoke: report.pdf (golden match)");
