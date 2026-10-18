import assert from "node:assert/strict";
import test from "node:test";
import { HIDDEN_BLOCK, scan } from "../src/hidden.ts";
import { convert as convertFile } from "../src/index.ts";

const convert = (html: string) =>
	convertFile(Buffer.from(html), { name: "synthetic.html" }).then((r) => r.markdown);

test("HTML visibility handles tiny fractional sizes, inherited backgrounds and stylesheet cascade conservatively", async () => {
	for (const html of [
		'<p style="font-size:.5px">EDGE_CANARY</p>',
		'<p style="font-size:0.05em">EDGE_CANARY</p>',
		'<div style="background-color:#123456"><span style="color:#123456">EDGE_CANARY</span></div>',
		'<style>.away { display:none!important }</style><p class="away" style="display:block">EDGE_CANARY</p>',
		'<style>#x { color:white }</style><p id="x" style="color:black">EDGE_CANARY</p>',
		'<p style="color:rgba(255,255,255,1)">EDGE_CANARY</p>',
		'<p style="position:absolute;left:99999px">EDGE_CANARY</p>',
	]) {
		const result = await convert(html),
			lines = result.split("\n");
		const at = lines.findIndex((l) => l.includes("EDGE_CANARY"));
		assert.ok(at >= 0 && scan(lines).hidden.has(at + 1), html);
	}
});

test("ambiguous CSS and duplicate attributes fail closed", async () => {
	for (const html of [
		'<p style="display:none!important;display:block">EDGE_CANARY</p>',
		'<p style="display:n\\6f ne">EDGE_CANARY</p>',
		'<p style="font-size:calc(1px)">EDGE_CANARY</p>',
		"<style>@media screen { p {display:none} }</style><p>EDGE_CANARY</p>",
		"<p hidden hidden>EDGE_CANARY</p>",
	])
		await assert.rejects(convert(html), /could not read/);
});

test("unsupported external styles flag all text without fetching, and fake markers cannot open the block", async () => {
	const external = await convert(
		'<link rel="stylesheet" href="https://example.com/sheet.css"><p>EDGE_CANARY</p>',
	);
	const lines = external.split("\n"),
		at = lines.findIndex((l) => l.includes("EDGE_CANARY"));
	assert.ok(scan(lines).hidden.has(at + 1));
	const marker = await convert(`<p>${HIDDEN_BLOCK}</p><p>Visible after marker</p>`);
	assert.ok(!scan(marker.split("\n")).hidden.size);
	assert.match(marker, /written in the file/);
});

test("unencoded UTF-8 email headers stay readable", async () => {
	const raw =
		"From: Zoë Otter <zoe@example.com>\r\nSubject: Café\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nBody";
	const result = await convertFile(Buffer.from(raw), { name: "synthetic.eml" }).then(
		(r) => r.markdown,
	);
	assert.match(result, /From: Zoë Otter/);
	assert.match(result, /Subject: Café/);
});

test("uncertain colour syntax stays flagged rather than passing white text normally", async () => {
	for (const style of [
		"color:#ffffffff",
		"color:rgb(100%,100%,100%)",
		"color:rgb(255 255 255)",
		"color:rgba(255,255,255,0)",
		"color:#123456;background:#123456 none",
	]) {
		const result = await convert(`<p style="${style}">COLOUR_CANARY</p>`),
			lines = result.split("\n");
		assert.ok(
			scan(lines).hidden.has(lines.findIndex((l) => l.includes("COLOUR_CANARY")) + 1),
			style,
		);
	}
});
