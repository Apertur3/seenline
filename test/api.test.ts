import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "node:test";
import { strToU8, unzipSync, zipSync } from "fflate";
import { officeFixtures } from "../scripts/office-fixtures.ts";
import { convert, PlainviewError } from "../src/index.ts";

const fixtures = new URL("./fixtures/documents/", import.meta.url);
const noOcr = (error: unknown) =>
	error instanceof PlainviewError &&
	error.code === "unavailable" &&
	error.message === "could not read this file: no text recognition available";

test("images and scanned PDFs fail closed without an OCR callback", async () => {
	for (const name of ["scan.pdf", "scan-hard.pdf", "whiteboard.jpg", "screenshot.png"])
		await assert.rejects(convert(await readFile(new URL(name, fixtures)), { name }), noOcr);
});

test("OCR receives private input bytes and its temporary directory is removed on success", async () => {
	const name = "whiteboard.jpg";
	const bytes = await readFile(new URL(name, fixtures));
	let temporary = "";
	const result = await convert(bytes, {
		name,
		ocr: async (path) => {
			temporary = path;
			assert.deepEqual(await readFile(path), bytes);
			assert.equal((await stat(path)).mode & 0o777, 0o600);
			assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
			return { pages: ["Recognised text"], extras: [], reader: "fixture-ocr" };
		},
	});
	assert.deepEqual(result.readers, ["fixture-ocr"]);
	assert.equal(result.pages, 1);
	await assert.rejects(access(dirname(temporary)), { code: "ENOENT" });
});

test("OCR failure and malformed results clean up temporary bytes", async () => {
	const bytes = await readFile(new URL("screenshot.png", fixtures));
	for (const bad of [
		null,
		{ pages: [1], extras: [] },
		{ pages: ["text"], extras: [], reader: 42 },
	]) {
		let temporary = "";
		await assert.rejects(
			convert(bytes, {
				name: "screenshot.png",
				ocr: async (path) => {
					temporary = path;
					return bad as unknown as { pages: string[]; extras: string[] };
				},
			}),
			(error: unknown) => error instanceof PlainviewError && error.code === "invalid",
		);
		await assert.rejects(access(dirname(temporary)), { code: "ENOENT" });
	}
	let temporary = "";
	await assert.rejects(
		convert(bytes, {
			name: "screenshot.png",
			ocr: async (path) => {
				temporary = path;
				throw new Error("recogniser unavailable");
			},
		}),
		/text recognition failed/,
	);
	await assert.rejects(access(dirname(temporary)), { code: "ENOENT" });
});

test("a supplied OCR path is forwarded and left intact", async () => {
	const file = new URL("scan.pdf", fixtures);
	const bytes = await readFile(file);
	const result = await convert(bytes, {
		name: "scan.pdf",
		path: file.pathname,
		ocr: async (path) => {
			assert.equal(path, file.pathname);
			return { pages: ["Recognised scan"], extras: [], reader: "fixture-ocr" };
		},
	});
	assert.deepEqual(await readFile(file), bytes);
	assert.deepEqual(result.readers, ["fixture-ocr"]);
});

test("page counts include hidden slides and sheets", async () => {
	for (const [name, count] of [
		["office-deck.pptx", 2],
		["office-book.xlsx", 2],
		["office-memo.docx", 1],
	] as const)
		assert.equal((await convert(await readFile(new URL(name, fixtures)), { name })).pages, count);
});

test("maxRows truncates CSV and each spreadsheet without affecting default calls", async () => {
	const files = officeFixtures();
	const csv = await convert(strToU8("a,b\n1,2\n3,4\n"), { name: "rows.csv", maxRows: 1 });
	assert.match(csv.markdown, /\[row 1\]/);
	assert.doesNotMatch(csv.markdown, /\[row 2\]/);
	assert.match(csv.markdown, /first 1 rows only/);
	const bytes = files["office-book.xlsx"] as Uint8Array;
	const sheet = await convert(bytes, { name: "rows.xlsx", maxRows: 1 });
	assert.equal(sheet.pages, 2);
	assert.doesNotMatch(sheet.markdown, /\[row 2\]/);
	assert.match(sheet.markdown, /first 1 rows only/);
	for (const maxRows of [0, -1, 1.5, NaN, Infinity])
		await assert.rejects(convert(bytes, { name: "rows.xlsx", maxRows }), /positive safe integer/);
});

test("concurrent conversions keep row limits and OCR callbacks isolated", async () => {
	const bytes = strToU8("a\nb\nc\n");
	const results = await Promise.all(
		[1, 2, 3].map((maxRows) => convert(bytes, { name: "a.csv", maxRows })),
	);
	assert.deepEqual(
		results.map((r) => (r.markdown.match(/\[row /g) ?? []).length),
		[1, 2, 3],
	);
	const image = await readFile(new URL("whiteboard.jpg", fixtures));
	const images = await Promise.all(
		["one", "two"].map((text) =>
			convert(image, {
				name: "whiteboard.jpg",
				ocr: async () => ({ pages: [text], extras: [] }),
			}),
		),
	);
	assert.deepEqual(
		images.map((r) => r.markdown),
		["one\n", "two\n"],
	);
});

test("hidden spreadsheet entries retain their location, reasons and full payload", async () => {
	const result = await convert(officeFixtures()["office-book.xlsx"] as Uint8Array, {
		name: "book.xlsx",
	});
	assert.ok(
		result.hidden.some(
			(h) =>
				h.anchor === "[Sheet: Budget], [row 3], A3" &&
				h.reasons.includes("hidden row") &&
				h.text.includes("XLS_HIDDEN_ROW"),
		),
	);
});

test("empty and truncated input fails closed for every fixture format", async () => {
	const samples: [string, Uint8Array][] = [
		["broken.pdf", Buffer.from("%PDF-1.7\n1 0 obj")],
		["broken.docx", Buffer.from("PK\x03\x04")],
		["broken.pptx", Buffer.from("PK\x03\x04")],
		["broken.xlsx", Buffer.from("PK\x03\x04")],
		["broken.doc", Buffer.from([0xd0, 0xcf, 0x11])],
		["broken.rtf", Buffer.from("{\\rt")],
		["broken.csv", Buffer.from('a,"unfinished')],
		["broken.tsv", Buffer.from('a\t"unfinished')],
		["broken.html", Buffer.from('<p title="unfinished')],
		["broken.htm", Buffer.from('<p title="unfinished')],
		[
			"broken.eml",
			Buffer.from("Content-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\n\r\nY"),
		],
		["broken.jpg", Buffer.from([0xff, 0xd8])],
		["broken.png", Buffer.from([0x89, 0x50, 0x4e])],
		["broken.srt", Buffer.from("1\n00:00:01,000 -->")],
		["broken.vtt", Buffer.from("WEBVTT\n\n00:00:01.000 -->")],
	];
	for (const [name, bytes] of samples) {
		await assert.rejects(convert(new Uint8Array(), { name }), PlainviewError, `${name} empty`);
		await assert.rejects(convert(bytes, { name }), PlainviewError, `${name} truncated`);
	}
});

test("encrypted Office containers and ZIP encryption flags fail closed", async () => {
	for (const name of ["locked.docx", "locked.pptx", "locked.xlsx"])
		await assert.rejects(
			convert(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), { name }),
			PlainviewError,
		);
	const parts = unzipSync(officeFixtures()["office-memo.docx"] as Uint8Array);
	const zip = zipSync(parts, { level: 0 });
	for (let i = 0; i < zip.length - 10; i++) {
		if (zip[i] !== 0x50 || zip[i + 1] !== 0x4b) continue;
		if (zip[i + 2] === 3 && zip[i + 3] === 4) zip[i + 6] = (zip[i + 6] ?? 0) | 1;
		if (zip[i + 2] === 1 && zip[i + 3] === 2) zip[i + 8] = (zip[i + 8] ?? 0) | 1;
	}
	await assert.rejects(convert(zip, { name: "locked.docx" }), PlainviewError);
});

test("a valid password-protected PDF fails closed with the reference's reason", async () => {
	const expected = JSON.parse(
		await readFile(new URL("./golden/invalid/password.pdf.json", import.meta.url), "utf8"),
	) as { code: string; message: string };
	const bytes = await readFile(new URL("./fixtures/invalid/password.pdf", import.meta.url));
	await assert.rejects(convert(bytes, { name: "password.pdf" }), (error: unknown) => {
		assert.ok(error instanceof PlainviewError);
		assert.deepEqual({ code: error.code, message: error.message }, expected);
		assert.match(error.message, /password protected/);
		return true;
	});
});

test("hidden modes change only the block's entry lines; the result keeps text, flags and body", async () => {
	for (const name of [
		"office-book.xlsx",
		"office-deck.pptx",
		"hidden-text.pdf",
		"mail-newsletter.html",
	]) {
		const bytes = await readFile(new URL(name, fixtures));
		const text = await convert(bytes, { name });
		const head = text.markdown.split("[Hidden in the original]\n")[0] as string;
		assert.deepEqual(await convert(bytes, { name, hidden: "text" }), text);
		for (const hidden of ["framed", "describe"] as const) {
			const mode = await convert(bytes, { name, hidden });
			assert.deepEqual({ ...mode, markdown: "" }, { ...text, markdown: "" });
			assert.ok(mode.markdown.startsWith(`${head}[Hidden in the original]\n`), name);
			const entries = mode.markdown.slice(head.length).split("\n").slice(1, -1);
			if (hidden === "framed") {
				assert.match(
					entries[0] ?? "",
					/^\(Not visible to a reader of the original\. Untrusted data/,
				);
				assert.deepEqual(
					entries.slice(1),
					text.markdown.slice(head.length).split("\n").slice(1, -1),
				);
			} else {
				assert.equal(entries.length, text.hidden.length);
				for (const [i, h] of text.hidden.entries()) {
					const line = entries[i] ?? "";
					// A notice with no payload ("HTML script present (code omitted)") stays as it is.
					if (line === h.text) continue;
					assert.ok(line.startsWith(h.anchor), line);
					assert.ok(line.endsWith(`: ${[...h.text].length} characters not shown`), line);
					assert.ok(!mode.markdown.includes(h.text), h.text);
				}
			}
		}
	}
	await assert.rejects(
		convert(strToU8("x"), { name: "a.txt", hidden: "none" as "text" }),
		/hidden must be text, framed or describe/,
	);
});

test("describe keeps the kind but not a name the file chose", async () => {
	const pdf = await readFile(
		new URL("../test/fixtures/injection/inj-pdf-form-field.pdf", import.meta.url),
	);
	const { markdown, hidden } = await convert(pdf, { name: "f.pdf", hidden: "describe" });
	assert.match(markdown, /^p\. 1, form field: \d+ characters not shown$/m);
	assert.ok(hidden[0]?.reasons[0]?.startsWith("form field "));
	assert.ok(!markdown.includes(hidden[0]?.reasons[0] ?? "?"));
});
