// CLI and MCP OCR through fake tesseract and pdftoppm scripts on PATH; one real run when tesseract is installed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { convert } from "../src/index.ts";
import { tesseract } from "../src/ocr.ts";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const FAKE = {
	// Prints how many bytes came in on stdin and its own arguments, so a test sees the page and that no path was passed.
	tesseract: `case "$FAKE" in
fail) exit 3 ;;
hang) exec /bin/sleep 30 ;;
flood) exec /bin/dd if=/dev/zero bs=1048576 count=40 2>/dev/null ;;
text:*) /bin/cat >/dev/null; echo "\${FAKE#text:}"; exit 0 ;;
esac
n=$(/bin/cat | /usr/bin/wc -c)
echo "Recognised $((n)) bytes: $*"`,
	// Page N becomes a PNG signature and N bytes; pipe returns the PDF it was given, raw no image, slow takes a while.
	pdftoppm: `case "$FAKE" in
pipe) printf '\\211PNG\\r\\n\\032\\n'; exec /bin/cat ;;
raw) exec /usr/bin/head -c 9 /dev/zero ;;
slow) /bin/sleep 0.3 ;;
esac
/bin/cat >/dev/null
printf '\\211PNG\\r\\n\\032\\n'
/usr/bin/head -c "$6" /dev/zero`,
};
let scratch = "";
let both = "";
let none = "";
let onlyTesseract = "";
let onlyPdftoppm = "";

before(async () => {
	scratch = await mkdtemp(join(tmpdir(), "seenline-ocr-test-"));
	both = join(scratch, "both");
	none = join(scratch, "none");
	onlyTesseract = join(scratch, "tesseract");
	onlyPdftoppm = join(scratch, "pdftoppm");
	for (const dir of [both, none, onlyTesseract, onlyPdftoppm]) await mkdir(dir);
	for (const [dir, names] of [
		[both, ["tesseract", "pdftoppm"]],
		[onlyTesseract, ["tesseract"]],
		[onlyPdftoppm, ["pdftoppm"]],
	] as const)
		for (const name of names) {
			await writeFile(join(dir, name), `#!/bin/sh\n${FAKE[name]}\n`);
			await chmod(join(dir, name), 0o755);
		}
});
after(() => rm(scratch, { recursive: true, force: true }));

function run(path: string, args: string[], fake = "") {
	const result = spawnSync(process.execPath, [cli, ...args], {
		encoding: "utf8",
		timeout: 20_000,
		env: { PATH: path, FAKE: fake },
	});
	assert.ifError(result.error);
	return result;
}

test("--ocr reads an image through tesseract on stdin, with the language flag", async () => {
	const size = (await readFile(fixture("documents/screenshot.png"))).length;
	const result = run(both, ["--ocr", fixture("documents/screenshot.png")]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, `Recognised ${size} bytes: stdin stdout -l eng\n`);
	const deu = run(both, ["--ocr", "--ocr-lang", "deu+eng", fixture("documents/screenshot.png")]);
	assert.match(deu.stdout, /stdin stdout -l deu\+eng\n$/);
});

test("--ocr reads only the weak PDF pages, each under its own anchor", () => {
	const scan = run(both, ["--ocr", fixture("documents/scan.pdf")]);
	assert.equal(scan.status, 0, scan.stderr);
	assert.equal(scan.stdout, "[p. 1]\nRecognised 9 bytes: stdin stdout -l eng\n");
	const weak = run(both, ["--ocr", fixture("pdf-hiding/weak-page.pdf")]);
	assert.equal(weak.status, 0, weak.stderr);
	assert.match(
		weak.stdout,
		/^\[p\. 1\]\n[^\n]+\n\[p\. 2\]\nRecognised 10 bytes: [^\n]+\n\[p\. 3\]\n/,
	);
});

test("--ocr without tesseract or pdftoppm fails closed with what to install", () => {
	for (const [path, file, hint] of [
		[none, "documents/screenshot.png", "needs tesseract (install it, for example brew install"],
		[onlyTesseract, "documents/scan.pdf", "needs pdftoppm (install poppler, for example brew"],
	] as const) {
		const result = run(path, ["--ocr", fixture(file)]);
		assert.equal(result.status, 1);
		assert.equal(result.stdout, "");
		const message = result.stderr.slice(fixture(file).length);
		assert.ok(message.startsWith(": unavailable: could not read this file: "), message);
		assert.ok(message.includes(hint), message);
		assert.doesNotMatch(message, /\/|\n\s+at /);
	}
	// With --ocr a PDF with one scanned page fails too; without it the page is marked as before.
	const weak = run(onlyPdftoppm, ["--ocr", fixture("pdf-hiding/weak-page.pdf")]);
	assert.equal(weak.status, 1);
	assert.equal(weak.stdout, "");
	assert.match(
		weak.stderr,
		/unavailable: could not read this file: text recognition needs tesseract/,
	);
	const off = run(none, [fixture("pdf-hiding/weak-page.pdf")]);
	assert.equal(off.status, 0, off.stderr);
	assert.match(off.stdout, /\[p\. 2\]\n\(no readable text layer/);
});

test("--ocr fails closed on a recogniser error, output over the cap, and a file that is no image", async () => {
	for (const [fake, message] of [
		["fail", "invalid: could not read this file: text recognition failed (tesseract exited"],
		["flood", "invalid: could not read this file: text recognition output is over the size limit"],
	]) {
		const result = run(both, ["--ocr", fixture("documents/screenshot.png")], fake);
		assert.equal(result.status, 1);
		assert.equal(result.stdout, "");
		assert.ok(result.stderr.includes(message as string), result.stderr);
	}
	// Tesseract reads a non-image as a list of files to open; it must never see one.
	const list = join(scratch, "list.png");
	await writeFile(list, `${fixture("documents/whiteboard.jpg")}\n`);
	const result = run(both, ["--ocr", list]);
	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /unavailable: .*reads PNG, JPEG, GIF, BMP and WebP images only/);
});

async function withFake<T>(fake: string, body: () => Promise<T>): Promise<T> {
	const saved = process.env;
	process.env = { PATH: both, FAKE: fake };
	try {
		return await body();
	} finally {
		process.env = saved;
	}
}

test("pdftoppm renders the bytes that were parsed, not the file now at the path", async () => {
	const bytes = await readFile(fixture("documents/scan.pdf"));
	const result = await withFake("pipe", () =>
		convert(bytes, {
			name: "scan.pdf",
			path: fixture("pdf-hiding/weak-page.pdf"),
			ocr: tesseract("eng"),
		}),
	);
	assert.equal(
		result.markdown,
		`[p. 1]\nRecognised ${8 + bytes.length} bytes: stdin stdout -l eng\n`,
	);
});

test("pdftoppm output that is no image, a weak BMP signature and a file over its deadline fail closed", async () => {
	const pdf = await readFile(fixture("documents/scan.pdf"));
	await withFake("raw", () =>
		assert.rejects(tesseract("eng")("x.pdf", [1], pdf), {
			message: "could not read this file: text recognition failed (pdftoppm returned no image)",
		}),
	);
	const bmp = Buffer.alloc(58);
	bmp.write("BM");
	bmp.writeUInt32LE(58, 2);
	bmp.writeUInt32LE(54, 10);
	bmp.writeUInt32LE(40, 14);
	const read = await withFake("", () => tesseract("eng")("x.bmp", undefined, bmp));
	assert.deepEqual(read.pages, ["Recognised 58 bytes: stdin stdout -l eng\n"]);
	// A stream writer leaves the size field 0; that is still a BMP.
	const streamed = Buffer.from(bmp).fill(0, 2, 6);
	const unsized = await withFake("", () => tesseract("eng")("x.bmp", undefined, streamed));
	assert.deepEqual(unsized.pages, read.pages);
	for (const fake of [
		Buffer.from("BM\n/etc/hosts\n".padEnd(40)),
		bmp.subarray(0, 40),
		Buffer.from("RIFFWEBP"),
	])
		await withFake("", () =>
			assert.rejects(tesseract("eng")("x.bmp", undefined, fake), { code: "unavailable" }),
		);
	// Each run is under its own timeout, but four 0.3 s pages overrun the file's 0.6 s.
	const started = Date.now();
	await withFake("slow", () =>
		assert.rejects(tesseract("eng", 5_000, 200, 100)("x.pdf", [1, 2, 3, 4], pdf), {
			code: "invalid",
			message: "could not read this file: text recognition is over the time limit for this file",
		}),
	);
	assert.ok(Date.now() - started < 3_000);
});

test("a hung recogniser is killed at the timeout", async () => {
	const saved = process.env;
	process.env = { PATH: both, FAKE: "hang" };
	try {
		const started = Date.now();
		await assert.rejects(tesseract("eng", 300)(fixture("documents/screenshot.png")), {
			code: "invalid",
			message: "could not read this file: text recognition timed out (tesseract)",
		});
		assert.ok(Date.now() - started < 5_000);
	} finally {
		process.env = saved;
	}
});

test("OCR flags are opt-in and checked before conversion", () => {
	for (const args of [
		["--ocr-lang", "deu", fixture("documents/scan.pdf")],
		["--ocr", "--ocr-lang", "eng;rm", fixture("documents/scan.pdf")],
		["--ocr", "--ocr-lang", "-c", fixture("documents/scan.pdf")],
		["--ocr", "--ocr-lang"],
		["mcp", "--ocr-lang", "deu"],
		["mcp", "--ocr", "file.pdf"],
		["mcp", "--ocr=yes"],
	]) {
		const result = run(both, args);
		assert.equal(result.status, 2, `${args}: ${result.stderr}`);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /usage/);
	}
	const off = run(both, [fixture("documents/scan.pdf")]);
	assert.equal(off.status, 1);
	assert.match(off.stderr, /unavailable: could not read this file: no text recognition available/);
});

const memo = fixture("pdf-hiding/short-page.pdf");
const differs =
	"[Hidden in the original]\np. 1, text differs from page image: 1 word only in the text layer, 1 word only in the page image\np. 1, text not drawn as written: 9 characters not shown\n";
test("--verify lists a page whose image shows other words and fails closed without the tools", () => {
	const same = run(both, ["--verify", "--fail-on-hidden", memo], "text:Approved.");
	assert.equal(same.status, 0, same.stderr);
	assert.equal(same.stdout, "[p. 1]\nApproved.\n");
	const other = run(
		both,
		["--verify", "--ocr-lang", "nld", "--fail-on-hidden", memo],
		"text:Rejected.",
	);
	assert.equal(other.status, 3, other.stderr);
	assert.equal(other.stdout, `[p. 1]\n${differs}`);
	for (const [path, hint] of [
		[none, "needs pdftoppm (install poppler"],
		[onlyPdftoppm, "needs tesseract (install it"],
	] as const) {
		const result = run(path, ["--verify", memo], "text:Approved.");
		assert.equal(result.status, 1);
		assert.equal(result.stdout, "");
		assert.ok(result.stderr.includes(`: unavailable: could not read this file: text recognition`));
		assert.ok(result.stderr.includes(hint), result.stderr);
	}
	// Without --verify no program runs and the output is unchanged.
	assert.equal(run(none, [memo]).stdout, "[p. 1]\nApproved.\n");
});

test("seenline mcp --verify lists the page in the structured result", async () => {
	const client = new Client({ name: "verify-test", version: "1.0.0" });
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [cli, "mcp", "--verify"],
		env: { PATH: both, FAKE: "text:Rejected." },
		stderr: "pipe",
	});
	try {
		await client.connect(transport);
		const result = await client.callTool({ name: "convert_file", arguments: { path: memo } });
		assert.ok(!result.isError, JSON.stringify(result.content));
		assert.deepEqual(result.content, [{ type: "text", text: `[p. 1]\n${differs}` }]);
		assert.deepEqual((result.structuredContent as { hidden: unknown }).hidden, [
			{
				anchor: "p. 1",
				reasons: ["text differs from page image"],
				text: "1 word only in the text layer, 1 word only in the page image",
			},
			{ anchor: "p. 1", reasons: ["text not drawn as written"], text: "Approved." },
		]);
	} finally {
		await client.close();
	}
});

test("seenline mcp --ocr reads a scan over stdio", async () => {
	const client = new Client({ name: "ocr-test", version: "1.0.0" });
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [cli, "mcp", "--ocr", "--ocr-lang", "nld"],
		env: { PATH: both },
		stderr: "pipe",
	});
	try {
		await client.connect(transport);
		const result = await client.callTool({
			name: "convert_file",
			arguments: { path: fixture("documents/scan.pdf") },
		});
		assert.ok(!result.isError, JSON.stringify(result.content));
		assert.deepEqual(result.content, [
			{ type: "text", text: "[p. 1]\nRecognised 9 bytes: stdin stdout -l nld\n" },
		]);
	} finally {
		await client.close();
	}
});

const real = ["tesseract", "pdftoppm"].every((cmd) => !spawnSync(cmd, ["-v"]).error);
test("real tesseract reads the scanned invoice", {
	skip: !real && "tesseract or pdftoppm not on PATH",
}, () => {
	const result = run(process.env.PATH ?? "", ["--ocr", fixture("documents/scan.pdf")]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /^\[p\. 1\]\nInvoice 2026-0457\n/);
	assert.match(result.stdout, /Total due: EUR 4,015\.00/);
	// Text after a valid signature is decoded as that format and fails; it is never read as a list of files.
	const list = join(scratch, "signed.bmp");
	writeFileSync(list, `BM\n${fixture("documents/whiteboard.jpg")}\n`);
	const listed = run(process.env.PATH ?? "", ["--ocr", list]);
	assert.equal(listed.status, 1);
	assert.doesNotMatch(listed.stdout + listed.stderr, /Sprint goals/);
});

test("real tesseract: --verify lists the remapped font and not its twin", {
	skip: !real && "tesseract or pdftoppm not on PATH",
}, () => {
	const remapped = run(process.env.PATH ?? "", [
		"--verify",
		fixture("pdf-hiding/font-remapped.pdf"),
	]);
	assert.equal(remapped.status, 0, remapped.stderr);
	assert.match(
		remapped.stdout,
		/\n\[Hidden in the original\]\np\. 1, text differs from page image: /,
	);
	assert.match(remapped.stdout, /p\. 1, text not drawn as written: 16 characters not shown/);
	assert.doesNotMatch(remapped.stdout, /FGBC|CNLZRAG|ABJ/);
	const twin = run(process.env.PATH ?? "", [
		"--verify",
		fixture("pdf-hiding/font-remapped-true.pdf"),
	]);
	assert.equal(twin.status, 0, twin.stderr);
	assert.equal(twin.stdout, "[p. 1]\nApproved budget: EUR 100,000 for 2027.\nSTOP PAYMENT NOW\n");
});
