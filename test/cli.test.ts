import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { convert } from "../src/index.ts";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const fixture = (name: string) =>
	fileURLToPath(new URL(`./fixtures/documents/${name}`, import.meta.url));
const golden = (name: string) =>
	readFile(new URL(`./golden/documents/${name}.md`, import.meta.url), "utf8");

function run(...args: string[]) {
	const result = spawnSync(process.execPath, [cli, ...args], {
		encoding: "utf8",
		timeout: 20_000,
	});
	assert.ifError(result.error);
	assert.equal(result.signal, null, result.stderr);
	return result;
}

test("built CLI emits exactly the golden Markdown and no diagnostics for readable files", async () => {
	for (const name of ["report.pdf", "office-memo.docx", "office-book.xlsx"]) {
		const result = run(fixture(name));
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stderr, "");
		assert.equal(result.stdout, await golden(name));
	}
});

test("CLI JSON is one result per file and excludes optional reader metadata", async () => {
	const names = ["report.pdf", "office-book.xlsx"];
	const result = run("--json", ...names.map(fixture));
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, "");
	const lines = result.stdout.trimEnd().split("\n");
	assert.equal(lines.length, 2);
	for (const [index, name] of names.entries()) {
		const expected = await convert(await readFile(fixture(name)), { name });
		assert.deepEqual(JSON.parse(lines[index] as string), expected);
	}
});

test("CLI --out writes multiple Markdown files without stdout", async () => {
	const scratch = await mkdtemp(join(tmpdir(), "plainview-cli-"));
	try {
		const out = join(scratch, "nested", "output");
		const result = run("--out", out, fixture("report.pdf"), fixture("office-book.xlsx"));
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout, "");
		assert.equal(result.stderr, "");
		assert.equal(await readFile(join(out, "report.md"), "utf8"), await golden("report.pdf"));
		assert.equal(
			await readFile(join(out, "office-book.md"), "utf8"),
			await golden("office-book.xlsx"),
		);
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
});

test("CLI file failures emit a code and message on stderr and no stdout", () => {
	for (const [file, code, message] of [
		[fixture("missing.pdf"), "invalid", "could not read this file"],
		[fixture("scan.pdf"), "unavailable", "no text recognition available"],
		[fixture("screenshot.png"), "unavailable", "no text recognition available"],
	]) {
		const result = run(file as string);
		assert.equal(result.status, 1);
		assert.equal(result.stdout, "");
		assert.ok(result.stderr.startsWith(`${file}: ${code}: `), result.stderr);
		assert.ok(result.stderr.includes(message as string), result.stderr);
	}
});

test("CLI reads a PDF with one near-empty page and marks that page", () => {
	const result = run(
		fileURLToPath(new URL("./fixtures/pdf-hiding/weak-page.pdf", import.meta.url)),
	);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /\n\[p\. 2\]\n\(no readable text layer on this page[^\n]*\n2 of 3\n/);
});

test("CLI failed conversion writes no --out file and batches continue after errors", async () => {
	const out = await mkdtemp(join(tmpdir(), "plainview-cli-"));
	try {
		const result = run("--out", out, fixture("scan.pdf"), fixture("report.pdf"));
		assert.equal(result.status, 1);
		assert.equal(result.stdout, "");
		assert.deepEqual(await readdir(out), ["report.md"]);
		const json = run("--json", fixture("missing.pdf"), fixture("report.pdf"));
		assert.equal(json.status, 1);
		assert.equal(JSON.parse(json.stdout).markdown, await golden("report.pdf"));
	} finally {
		await rm(out, { recursive: true, force: true });
	}
});

test("CLI empty, damaged, unsupported and unwritable files fail closed", async () => {
	const scratch = await mkdtemp(join(tmpdir(), "plainview-cli-"));
	try {
		for (const [name, text] of [
			["empty.csv", ""],
			["broken.pdf", "%PDF-1.7\n1 0 obj"],
			["file.unknown", "some document text"],
		]) {
			const file = join(scratch, name as string);
			await writeFile(file, text as string);
			const result = run("--json", file);
			assert.equal(result.status, 1);
			assert.equal(result.stdout, "");
			assert.ok(result.stderr.startsWith(`${file}: invalid: `));
		}
		const blocked = join(scratch, "file");
		await writeFile(blocked, "occupied");
		const result = run("--out", blocked, fixture("report.pdf"));
		assert.equal(result.status, 1);
		assert.equal(result.stdout, "");
		assert.ok(result.stderr.startsWith(`${fixture("report.pdf")}: invalid: `));
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
});

test("CLI --fail-on-hidden preserves output, detects scanner flags and gives file errors priority", async () => {
	const hidden = fixture("office-book.xlsx");
	const flagged = run("--fail-on-hidden", hidden);
	assert.equal(flagged.status, 3);
	assert.equal(flagged.stdout, await golden("office-book.xlsx"));
	assert.equal(flagged.stderr, "");
	assert.equal(run("--fail-on-hidden", fixture("report.pdf")).status, 0);
	assert.equal(run("--fail-on-hidden", "--json", hidden, fixture("missing.pdf")).status, 1);
	assert.equal(run("--fail-on-hidden", "--json", hidden).status, 3);
	const scratch = await mkdtemp(join(tmpdir(), "plainview-cli-"));
	try {
		const unicode = join(scratch, "unicode.csv");
		await writeFile(unicode, "name\nhello\u200Bworld\n");
		const result = run("--fail-on-hidden", "--json", unicode);
		assert.equal(result.status, 3);
		assert.deepEqual(JSON.parse(result.stdout).hidden, []);
		assert.deepEqual(JSON.parse(result.stdout).flags, ["zero-width"]);
		assert.equal(run("--fail-on-hidden", "--out", scratch, hidden).status, 3);
		assert.equal(await readFile(join(scratch, "office-book.md"), "utf8"), flagged.stdout);
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
});

test("CLI usage errors exit 2 before conversion and never write stdout", () => {
	for (const args of [
		[],
		[fixture("report.pdf"), fixture("office-book.xlsx")],
		["--unknown"],
		["--out"],
		["--out", "", fixture("report.pdf")],
		["--json", "--out", "output", fixture("report.pdf")],
		["--out", "output", "report.pdf", "another/report.docx"],
		["mcp", "--json"],
	]) {
		const result = run(...args);
		assert.equal(result.status, 2, `${args}: ${result.stderr}`);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /usage/);
	}
});

test("CLI --help, --version, end-of-options and package bin", async () => {
	const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
	const help = run("--help");
	assert.equal(help.status, 0);
	assert.match(help.stdout, /Usage: plainview/);
	assert.equal(help.stderr, "");
	assert.equal(run("--version").stdout, `${pkg.version}\n`);
	assert.equal(run("--version").status, 0);
	assert.equal(run("--version").stderr, "");
	assert.equal(run("--", fixture("report.pdf")).stdout, await golden("report.pdf"));
	assert.equal(pkg.bin.plainview, "./dist/cli.js");
	assert.equal(pkg.exports["./package.json"], "./package.json");
	assert.equal(pkg.private, true);
	assert.ok((await readFile(cli, "utf8")).startsWith("#!/usr/bin/env node\n"));
});
