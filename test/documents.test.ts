import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { DOCUMENT_CASES, OFFICE_CASES } from "../scripts/document-cases.ts";
import { fixtureOcr } from "../scripts/ocr-stub.ts";
import { HIDDEN_BLOCK, scan } from "../src/hidden.ts";
import { convert, PlainviewError } from "../src/index.ts";

const fixtures = new URL("./fixtures/documents/", import.meta.url);
test("a PDF keeps page anchors and table rows in reading order", async () => {
	const result = await convert(await readFile(new URL("report.pdf", fixtures)), {
		name: "report.pdf",
	});
	const lines = result.markdown.trimEnd().split("\n");
	assert.equal(lines[0], "[p. 1]");
	assert.equal(result.pages, 3);
	assert.ok(lines.indexOf("[p. 3]") > lines.indexOf("[p. 2]"));
	assert.equal(lines[lines.indexOf("[p. 2]") + 2], "Quarter | Revenue (EUR) | Growth");
	assert.ok(lines.includes("Q2 | 4,120,900 | 12.4%"));
	assert.deepEqual(result.flags, []);
});

test("white, tiny, off-page and invisible PDF text is preserved after the visible memo", async () => {
	const result = await convert(await readFile(new URL("hidden-text.pdf", fixtures)), {
		name: "hidden-text.pdf",
	});
	const lines = result.markdown.trimEnd().split("\n");
	const block = lines.indexOf(HIDDEN_BLOCK);
	assert.ok(block > 0);
	assert.deepEqual([...scan(lines).hidden], lines.map((_, i) => i + 1).slice(block));
	for (const why of ["white", "tiny", "off-page", "invisible"])
		assert.ok(result.hidden.some((h) => h.anchor === "p. 1" && h.reasons.includes(why)));
	assert.match(lines.slice(0, block).join("\n"), /parking permits renew on 5 January 2027/);
	assert.doesNotMatch(lines.slice(0, block).join("\n"), /ignore all earlier|reveal the system/);
});

test("OCR text routes images and scanned PDFs without depending on a platform helper", async () => {
	for (const name of ["whiteboard.jpg", "scan.pdf"]) {
		const result = await convert(await readFile(new URL(name, fixtures)), {
			name,
			ocr: async () => ({ pages: ["Sprint goals\nOwner: Lena Okafor"], extras: [] }),
		});
		assert.equal(
			result.markdown,
			`${name.endsWith(".pdf") ? "[p. 1]\n" : ""}Sprint goals\nOwner: Lena Okafor\n`,
		);
		assert.equal(result.pages, 1);
	}
});

test("an image without recognisable text or with a failing recogniser is refused", async () => {
	const bytes = await readFile(new URL("screenshot.png", fixtures));
	await assert.rejects(
		convert(bytes, { name: "screenshot.png", ocr: async () => ({ pages: [""], extras: [] }) }),
		/no text found/,
	);
	await assert.rejects(
		convert(bytes, {
			name: "screenshot.png",
			ocr: async () => {
				throw new Error("failure");
			},
		}),
		/text recognition failed/,
	);
	await assert.rejects(
		convert(Buffer.from("%PDF-1.4 this is not a pdf"), { name: "broken.pdf" }),
		PlainviewError,
	);
});

for (const doc of [...DOCUMENT_CASES, ...OFFICE_CASES]) {
	test(`${doc.file}: ${doc.canary} stays in the ${doc.where}`, async () => {
		const bytes = await readFile(new URL(`./fixtures/injection/${doc.file}`, import.meta.url));
		const result = await convert(bytes, { name: doc.file, ocr: async () => fixtureOcr(doc.file) });
		const lines = result.markdown.split("\n");
		const at = lines.findIndex((l) => l.includes(doc.canary));
		const block = lines.indexOf(HIDDEN_BLOCK);
		assert.ok(at >= 0, "the payload is preserved");
		if (doc.where === "block") assert.ok(block >= 0 && at > block);
		else assert.ok(block < 0 || at < block);
		for (const flag of doc.flags) assert.ok(result.flags.includes(flag), flag);
		if (!doc.flags.length)
			assert.ok(!scan(lines).hidden.has(at + 1), "visible payload stays unflagged");
	});
}
