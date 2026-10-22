import assert from "node:assert/strict";
import test from "node:test";
import { strToU8, unzipSync, zipSync } from "fflate";
import { officeFixtures } from "../scripts/office-fixtures.ts";
import { officeKey } from "../scripts/office-key.ts";
import { HIDDEN_BLOCK, scan } from "../src/hidden.ts";
import { convert } from "./text-mode.ts";

const convertOffice = async (bytes: Uint8Array, name: string) =>
	(await convert(bytes, { name })).markdown;

const fixtures = officeFixtures();
for (const key of officeKey) {
	test(`office converts ${key.file} with facts, tables, anchors and flagged hidden content`, async () => {
		const output = await convertOffice(
			fixtures[key.file] as Uint8Array,
			key.file.slice(key.file.lastIndexOf(".")),
		);
		for (const fact of key.facts) assert.ok(output.includes(fact), `missing fact: ${fact}`);
		for (const anchor of key.anchors)
			assert.ok(output.includes(anchor), `missing anchor: ${anchor}`);
		for (const row of key.rows)
			assert.ok(
				output.split("\n").some((line) => line.includes(row.join(" | "))),
				`table row missing: ${row}`,
			);
		const lines = output.split("\n");
		const scanned = scan(lines);
		for (const canary of key.hidden) {
			const at = lines.findIndex((line) => line.includes(canary));
			assert.ok(at >= 0, `hidden text was dropped: ${canary}`);
			assert.ok(
				output.indexOf(canary) > output.indexOf(HIDDEN_BLOCK),
				`hidden text in visible body: ${canary}`,
			);
			assert.ok(scanned.hidden.has(at + 1), `hidden text not flagged: ${canary}`);
		}
	});
}

test("office notes stay visible, lists retain structure and notes follow document body", async () => {
	const deck = await convertOffice(fixtures["office-deck.pptx"] as Uint8Array, ".pptx");
	const visible = deck.split(HIDDEN_BLOCK)[0] ?? "";
	assert.match(visible, /Notes[\s\S]*Presenter reminder/);
	const doc = await convertOffice(fixtures["office-memo.docx"] as Uint8Array, ".docx");
	assert.match(doc, /(?:-|\d+\.) First action/);
	assert.ok(doc.indexOf("Footnote detail") > doc.indexOf("Otter | 12"));
	assert.ok(doc.indexOf("Endnote detail") > doc.indexOf("Otter | 12"));
});

test("CSV detects tab and semicolon delimiters, preserves multiline quoted fields and row anchors", async () => {
	for (const delimiter of ["\t", ";"]) {
		const output = await convertOffice(
			strToU8(`Team${delimiter}Note\nOtter${delimiter}"east\nwest"\n`),
			delimiter === "\t" ? ".tsv" : ".csv",
		);
		assert.match(output, /\[row 1\]/);
		assert.match(output, /\[row 2\]/);
		assert.match(output, /Otter \| east\s+west/);
		assert.doesNotMatch(output, /\[row 3\]/);
	}
});

test("CSV visibly truncates after 5000 rows", async () => {
	const output = await convertOffice(
		strToU8(Array.from({ length: 5001 }, (_, i) => `item${i + 1},${i + 1}`).join("\n")),
		".csv",
	);
	assert.match(output, /\[row 5000\]/);
	assert.doesNotMatch(output, /\[row 5001\]/);
	assert.match(output, /truncated/i);
});

test("legacy, damaged, encrypted and malformed office files fail closed", async () => {
	for (const extension of [".doc", ".ppt", ".xls"])
		await assert.rejects(
			() => convertOffice(strToU8("binary"), extension),
			/could not read this file: save it as \.docx, \.pptx or \.xlsx/,
		);
	for (const extension of [".docx", ".pptx", ".xlsx"]) {
		await assert.rejects(
			() => convertOffice(strToU8("not a zip"), extension),
			/could not read this file/,
		);
		await assert.rejects(
			() =>
				convertOffice(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), extension),
			/could not read this file/,
		);
		await assert.rejects(
			() =>
				convertOffice(zipSync({ "word/document.xml": strToU8("<w:document><w:body>") }), extension),
			/could not read this file/,
		);
	}
});

test("XLSX visibly truncates each sheet after 5000 rows", async () => {
	const parts = unzipSync(fixtures["office-book.xlsx"] as Uint8Array);
	const rows = Array.from(
		{ length: 5001 },
		(_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i + 1}</v></c></row>`,
	).join("");
	parts["xl/worksheets/sheet1.xml"] = strToU8(
		'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
			rows +
			"</sheetData></worksheet>",
	);
	const output = await convertOffice(zipSync(parts), ".xlsx");
	assert.match(output, /\[row 5000\]/);
	assert.doesNotMatch(output, /\[row 5001\]/);
	assert.match(output, /truncated/i);
});
