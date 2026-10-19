import assert from "node:assert/strict";
import test from "node:test";
import { mailFixtures } from "../scripts/mail-fixtures.ts";
import { mailKey } from "../scripts/mail-key.ts";
import { HIDDEN_BLOCK, scan } from "../src/hidden.ts";
import { convert as convertFile } from "../src/index.ts";

const fixtures = mailFixtures();
const convert = (name: string, bytes = fixtures[name] as Uint8Array) =>
	convertFile(bytes, { name }).then((r) => r.markdown);

for (const key of mailKey) {
	test(`mail converts ${key.file} with facts, structure, headers and hidden flagging`, async () => {
		const output = await convert(key.file);
		const visible = output.split(HIDDEN_BLOCK)[0] ?? "";
		for (const fact of [...key.facts, ...key.structure, ...key.headers])
			assert.ok(visible.includes(fact), `missing visible answer: ${fact}`);
		const lines = output.split("\n");
		const flagged = scan(lines).hidden;
		for (const canary of key.hidden) {
			assert.ok(!visible.includes(canary), `hidden content passed normally: ${canary}`);
			const at = lines.findIndex((line) => line.includes(canary));
			assert.ok(at >= 0, `hidden content dropped: ${canary}`);
			assert.ok(flagged.has(at + 1), `hidden content not flagged: ${canary}`);
		}
	});
}

test("HTML preserves document order and notes script/style presence without executable code", async () => {
	const text = await convert("mail-newsletter.html");
	const visible = text.split(HIDDEN_BLOCK)[0] ?? "";
	const order = [
		"Harbor bulletin",
		"Budget is 42000 EUR",
		"Delivery",
		"Launch on 8 November",
		"First action",
		"Second action",
		"Plan (",
		"Team | Seats",
		"Otter | 12",
	];
	for (let i = 1; i < order.length; i++)
		assert.ok(visible.indexOf(order[i] as string) > visible.indexOf(order[i - 1] as string));
	const hidden = text.split(HIDDEN_BLOCK)[1] ?? "";
	assert.match(hidden, /script/i);
	assert.match(hidden, /style/i);
	assert.doesNotMatch(text, /throw new Error|\.unused \{/);
});

test("MIME attachments list metadata without converting their body", async () => {
	const text = await convert("mail-alternative.eml");
	assert.match(text, /agenda\.pdf[^\n]*application\/pdf[^\n]*12\s*(?:bytes|B)\b/i);
	assert.doesNotMatch(text, /%PDF-1\.4|JVBERi0/);
	assert.match(text, /(?:quoted|> Earlier budget)/i);
});

test("mail decodes iso-8859-1 quoted-printable and folded headers", async () => {
	const raw =
		'From: Mira Otter <mira@example.com>\r\nTo: Finn Reed <finn@example.com>\r\nSubject: Folded\r\n subject\r\nContent-Type: text/plain; charset="iso-8859-1"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nCaf=E9 co=\r\nsta\r\n';
	const text = await convert("latin.eml", Buffer.from(raw));
	assert.match(text, /Subject: Folded subject/);
	assert.match(text, /Café costa/);
});

test("HTML hidden inheritance and quoted attributes cannot escape flagging", async () => {
	const raw =
		'<h1>Visible</h1><div hidden><span>INHERITED_HIDDEN</span></div><p title="quoted > TITLE_HIDDEN">Shown</p>';
	const text = await convert("hostile.html", Buffer.from(raw));
	const visible = text.split(HIDDEN_BLOCK)[0] ?? "";
	assert.match(visible, /Visible[\s\S]*Shown/);
	assert.doesNotMatch(visible, /INHERITED_HIDDEN|TITLE_HIDDEN/);
	assert.match(text.split(HIDDEN_BLOCK)[1] ?? "", /INHERITED_HIDDEN[\s\S]*TITLE_HIDDEN/);
});

test("hostile HTML and MIME over budgets or malformed encodings fail closed", async () => {
	const cases: [string, string][] = [
		["deep.html", `${"<div>".repeat(1000)}payload${"</div>".repeat(1000)}`],
		["attribute.html", `<p title="${"x".repeat(1024 * 1024)}">shown</p>`],
		["broken.html", '<p hidden="unterminated>HIDDEN_MUST_NOT_ESCAPE'],
		[
			"bad.eml",
			"Content-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\n\r\n%%%broken%%%",
		],
		["charset.eml", "Content-Type: text/plain; charset=unknown-test-charset\r\n\r\nbody"],
		["boundary.eml", 'Content-Type: multipart/alternative; boundary="missing"\r\n\r\nbody'],
	];
	for (const [name, raw] of cases)
		await assert.rejects(convert(name, Buffer.from(raw)), /could not read this file/i, name);
});

test("mbox exports, header-less parts, trailing semicolons and a lost close boundary read", async () => {
	const raw = [
		"From mira@example.com  Thu Apr 30 14:27:51 1998",
		"From: Mira Otter <mira@example.com>",
		"Subject: Archive copy",
		'Content-Type: multipart/mixed; boundary="b1";',
		"",
		"preamble",
		"--b1",
		"",
		"HEADERLESS_PART",
		"--b1",
		"Content-Type: text/plain; charset=us-ascii;",
		"",
		"TRUNCATED_LAST_PART",
	].join("\r\n");
	const text = await convert("archive.eml", Buffer.from(raw));
	assert.match(text, /^From: Mira Otter <mira@example\.com>\nSubject: Archive copy\n/);
	assert.match(text, /HEADERLESS_PART[\s\S]*TRUNCATED_LAST_PART/);
	assert.doesNotMatch(text, /preamble/);
});

test("only a MIME part may skip its headers; a message starting with a blank line is refused", async () => {
	const part =
		'Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\n\r\nNO_HEADERS\r\n--b--\r\n';
	assert.match(await convert("part.eml", Buffer.from(part)), /^NO_HEADERS\n/);
	const message =
		'\r\nFrom: a@b.example\nBcc: x\nContent-Type: text/html\n\n<p style="display:none">HIDDEN_HTML</p>';
	await assert.rejects(convert("blank.eml", Buffer.from(message)), /malformed email structure/);
});

test("a first line that only starts with From is not taken for an mbox envelope", async () => {
	for (const raw of [
		"From Monday to Friday we work.",
		"From Monday to Friday we work.\r\nSubject: Hours\r\n\r\nBody",
		"From mira@example.com  Thu Apr 30 14:27:51 1998\r\n\r\nBody",
	])
		await assert.rejects(convert("plain.eml", Buffer.from(raw)), /malformed email structure/, raw);
});

test("unsupported Outlook MSG is clearly refused", async () => {
	await assert.rejects(
		convert("mail-outlook.msg", Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])),
		/(?:save|export).*\.eml/i,
	);
});
