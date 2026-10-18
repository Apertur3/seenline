import assert from "node:assert/strict";
import { test } from "node:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { officeFixtures } from "../scripts/office-fixtures.ts";
import { HIDDEN_BLOCK } from "../src/hidden.ts";
import { convert } from "../src/index.ts";

const convertOffice = async (bytes: Uint8Array, name: string) =>
	(await convert(bytes, { name })).markdown;

function changeDoc(edit: (s: string) => string): Uint8Array {
	const files = unzipSync(officeFixtures()["office-memo.docx"] as Uint8Array);
	files["word/document.xml"] = strToU8(edit(strFromU8(files["word/document.xml"] as Uint8Array)));
	return zipSync(files);
}

test("DOCX same-background text inherits document and table-cell backgrounds", async () => {
	const run = '<w:r><w:rPr><w:color w:val="112233"/></w:rPr><w:t>BACKGROUND_INHERITED</w:t></w:r>';
	for (const inject of [
		(s: string) =>
			s.replace("<w:body>", `<w:background w:color="112233"/><w:body><w:p>${run}</w:p>`),
		(s: string) =>
			s.replace(
				"<w:body>",
				'<w:body><w:tbl><w:tr><w:tc><w:tcPr><w:shd w:fill="112233"/></w:tcPr><w:p>' +
					run +
					"</w:p></w:tc></w:tr></w:tbl>",
			),
	]) {
		const output = await convertOffice(changeDoc(inject), ".docx");
		assert.ok(output.indexOf("BACKGROUND_INHERITED") > output.indexOf(HIDDEN_BLOCK));
		assert.ok(output.includes(HIDDEN_BLOCK));
	}
});

test("malformed XML and ZIP integrity failures leave no partial source", async () => {
	for (const xml of [
		"junk<w:document/>",
		"<w:document>&missing;</w:document>",
		'<!DOCTYPE x [<!ENTITY x "bad">]><w:document/>',
	]) {
		await assert.rejects(
			() =>
				convertOffice(
					changeDoc(() => xml),
					".docx",
				),
			/could not read/,
		);
	}
	const files = unzipSync(officeFixtures()["office-memo.docx"] as Uint8Array);
	const bytes = zipSync(files, { level: 0 });
	const at = Buffer.from(bytes).indexOf(Buffer.from("Harbor report"));
	assert.ok(at > 0);
	bytes[at] = 88;
	await assert.rejects(() => convertOffice(bytes, ".docx"), /could not read/);
});

test("PPTX run attributes do not erase inherited tiny or white paragraph text", async () => {
	const files = unzipSync(officeFixtures()["office-deck.pptx"] as Uint8Array);
	files["ppt/slides/slide1.xml"] = strToU8(
		strFromU8(files["ppt/slides/slide1.xml"] as Uint8Array).replace(
			"</p:spTree>",
			'<p:sp><p:txBody><a:p><a:pPr><a:defRPr sz="100"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:defRPr></a:pPr><a:r><a:rPr lang="en-US"/><a:t>PPT_INHERITED</a:t></a:r></a:p></p:txBody></p:sp></p:spTree>',
		),
	);
	const output = await convertOffice(zipSync(files), ".pptx");
	assert.ok(output.indexOf("PPT_INHERITED") > output.indexOf(HIDDEN_BLOCK));
});

test("DOCX default paragraph style preserves hidden runs even without explicit pStyle", async () => {
	const files = unzipSync(officeFixtures()["office-memo.docx"] as Uint8Array);
	files["word/document.xml"] = strToU8(
		'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DEFAULT_HIDDEN</w:t></w:r></w:p></w:body></w:document>',
	);
	files["word/styles.xml"] = strToU8(
		'<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:rPr><w:vanish/></w:rPr></w:style></w:styles>',
	);
	const output = await convertOffice(zipSync(files), ".docx");
	assert.ok(output.indexOf("DEFAULT_HIDDEN") > output.indexOf(HIDDEN_BLOCK));
});

test("DOCX unused character styles do not hide ordinary paragraphs", async () => {
	const files = unzipSync(officeFixtures()["office-memo.docx"] as Uint8Array);
	files["word/styles.xml"] = strToU8(
		'<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="character" w:styleId="Unused"><w:rPr><w:vanish/></w:rPr></w:style><w:style w:type="paragraph" w:default="1" w:styleId="Normal"/></w:styles>',
	);
	const output = await convertOffice(zipSync(files), ".docx");
	assert.ok((output.split(HIDDEN_BLOCK)[0] ?? "").includes("Budget is 42000 EUR"));
});

test("custom XML attribute values are preserved as hidden content", async () => {
	const files = unzipSync(officeFixtures()["office-memo.docx"] as Uint8Array);
	files["customXml/item1.xml"] = strToU8('<record instruction="ATTRIBUTE_PAYLOAD"/>');
	const output = await convertOffice(zipSync(files), ".docx");
	assert.ok(output.indexOf("ATTRIBUTE_PAYLOAD") > output.indexOf(HIDDEN_BLOCK));
	assert.ok(output.includes("ATTRIBUTE_PAYLOAD"));
});
