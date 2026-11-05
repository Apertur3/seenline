// Resource limits at the edges: text that made a backtracking regex stall, and the file boundary
// (special files, size, symbolic links, the MCP server's allowed folders). Each risky call runs in a
// child process with a hard deadline, so a regression fails here instead of hanging the suite.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { MAX_INPUT } from "../src/documents.ts";
import { convert } from "../src/index.ts";
import { createServer } from "../src/mcp.ts";
import { parseHidden } from "../src/parse-hidden.ts";

const src = (name: string) => new URL(`../src/${name}`, import.meta.url).href;
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const fixture = (name: string) =>
	fileURLToPath(new URL(`./fixtures/documents/${name}`, import.meta.url));

// Each case: [label, code run in the child]; the child prints each case's time in ms.
const HOSTILE: [string, string][] = [
	["base64 check, 100 KB", `listedValue("Title", "Aa1".repeat(33_334) + "!")`],
	["gap of hyphens", `suspect("ignore " + "-".repeat(100_000) + " xyz")`],
	["gap of quotes", `suspect("ignore " + "' ".repeat(50_000) + "xyz")`],
	["quote run after a verb", `suspect("include " + '"'.repeat(100_000) + "!")`],
	["sentence starts", `suspect(". ".repeat(50_000) + "!")`],
	["heading marks", `suspect("#".repeat(100_000) + "!")`],
	["unclosed tags", `scan(["<".repeat(100_000)])`],
	[
		"css without braces",
		`convert(html("<style>" + "a".repeat(100_000) + "</style>"), { name: "x.html" })`,
	],
	[
		"css comment openings",
		`convert(html("<style>" + "/*".repeat(50_000) + "</style>"), { name: "x.html" })`,
	],
	["xml of tag openings", `xml("<a>" + "<".repeat(100_000) + "</a>")`],
	[
		"subtitle tag openings",
		`subtitlesToText("00:00:01.000 --> 00:00:02.000\\n" + "<".repeat(100_000))`,
	],
	[
		"subtitle speaker openings",
		`subtitlesToText("00:00:01.000 --> 00:00:02.000\\n" + "<v ".repeat(33_334))`,
	],
	[
		"subtitle style comment openings",
		`subtitlesToText("WEBVTT\\n\\nSTYLE\\n" + "/*a".repeat(100_000) + "\\n\\n00:00:01.000 --> 00:00:02.000\\nHi\\n")`,
	],
	[
		"subtitle style brace openings",
		`subtitlesToText("WEBVTT\\n\\nSTYLE\\n" + "::cue {".repeat(50_000) + "\\n\\n00:00:01.000 --> 00:00:02.000\\nHi\\n")`,
	],
	["Dutch reply lines", `convert(eml("Op " + "schreef ".repeat(12_500)), { name: "x.eml" })`],
	[
		"boundary blanks",
		`convert(Buffer.from(multipart(" ".repeat(100_000) + "x")), { name: "x.eml" })`,
	],
	[
		"a long body, no hidden block",
		`convert(eml("Text." + "\\n".repeat(100_000) + "x"), { name: "x.eml" })`,
	],
	["too many hidden entries", `parseHidden(Array(100_001).fill("p. 1, white text: words"))`],
];
const CHILD = `
import { listedValue, parseHidden } from "${src("parse-hidden.ts")}";
import { suspect } from "${src("suspect.ts")}";
import { scan } from "${src("hidden.ts")}";
import { xml } from "${src("office-xml.ts")}";
import { subtitlesToText } from "${src("subtitles.ts")}";
import { convert } from "${src("index.ts")}";
const html = (s) => Buffer.from("<html><body><p>Text.</p>" + s + "</body></html>");
const eml = (body) => Buffer.from("From: a@example.com\\r\\nSubject: x\\r\\nContent-Type: text/plain\\r\\n\\r\\n" + body + "\\r\\n");
const multipart = (line) => 'From: a@example.com\\r\\nContent-Type: multipart/mixed; boundary="b"\\r\\n\\r\\n--b\\r\\nContent-Type: text/plain\\r\\n\\r\\nText.\\r\\n' + line + "\\r\\n--b--\\r\\n";
const ms = [];
${HOSTILE.map(([, code]) => `{ const t = performance.now(); try { await ${code}; } catch {} ms.push(Math.round(performance.now() - t)); }`).join("\n")}
console.log(JSON.stringify(ms));
`;

test("hostile text of 100,000 characters never stalls a regex: each case well under a second", () => {
	const child = spawnSync(process.execPath, ["--input-type=module", "-e", CHILD], {
		encoding: "utf8",
		timeout: 60_000,
	});
	assert.equal(child.signal, null, "the child finished before its deadline");
	assert.equal(child.status, 0, child.stderr);
	const ms = JSON.parse(child.stdout) as number[];
	for (const [i, [label]] of HOSTILE.entries())
		assert.ok((ms[i] ?? 0) < 1000, `${label}: ${ms[i]} ms`);
});

test("a block of more than 100,000 hidden entries fails closed, naming the cause", () => {
	const lines = (n: number) => Array(n).fill("p. 1, white text: words");
	assert.throws(() => parseHidden(lines(100_001)), /more than 100,000 hidden entries/);
	assert.equal(parseHidden(lines(10)).length, 10);
});

test("the built PDF reader starts under every way of running Node, and a reader that cannot start never blames the file", () => {
	const dist = new URL("../dist/index.js", import.meta.url).href;
	const read = `(await convert(readFileSync(${JSON.stringify(fixture("report.pdf"))}), { name: "x.pdf" })).markdown.split("\\n")[0]`;
	const esm = `import { convert } from "${dist}"; import { readFileSync } from "node:fs"; console.log(await (async () => ${read})().catch((e) => e.code + ": " + e.message));`;
	const cjs = `const { readFileSync } = require("node:fs"); import(${JSON.stringify(dist)}).then(async ({ convert }) => console.log(${read}));`;
	const refuse = `data:text/javascript,import { isMainThread } from "node:worker_threads"; if (!isMainThread) throw new Error("no")`;
	const cases: [string[], (string | undefined)?, string?][] = [
		[["--input-type=module", "-e", esm]],
		[["--input-type", "module", "-e", esm]],
		[["--import", "data:text/javascript,export {}", "--input-type=module", "-e", esm]],
		[["--experimental-vm-modules", "--no-warnings", "--input-type=module", "-e", esm]],
		[["--expose-gc", "--stack-size=2000", "--input-type=module", "-e", esm]],
		[["--input-type=module"], esm],
		[["-e", cjs]],
		[["--input-type=commonjs", "-e", cjs]],
		[
			["--import", refuse, "--input-type=module", "-e", esm],
			undefined,
			"unavailable: the PDF reader could not start: no",
		],
	];
	for (const [args, input, out = "[p. 1]"] of cases) {
		const r = spawnSync(process.execPath, args, { input, encoding: "utf8", timeout: 30_000 });
		assert.equal(r.stdout, `${out}\n`, `${args.slice(0, -2).join(" ")}: ${r.stderr}`);
	}
});

function run(...args: string[]) {
	const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 20_000 });
	assert.equal(result.signal, null, `finished before the deadline: ${args.join(" ")}`);
	return result;
}

test("the CLI refuses a pipe, a device, a folder and an oversized file without waiting or reading it", async () => {
	const dir = await mkdtemp(join(tmpdir(), "seenline-limits-"));
	try {
		const fifo = join(dir, "pipe.pdf");
		assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
		const zero = join(dir, "zero.pdf");
		await symlink("/dev/zero", zero);
		const big = join(dir, "big.pdf");
		await writeFile(big, "");
		await truncate(big, MAX_INPUT + 1);
		for (const [file, why] of [
			[fifo, "not a regular file"],
			["/dev/zero", "not a regular file"],
			[zero, "not a regular file"],
			[dir, "not a regular file"],
			[big, "larger than the 100 MB input limit"],
			[join(dir, "missing.pdf"), "no such file"],
		]) {
			const result = run(file as string);
			assert.equal(result.status, 1);
			assert.equal(result.stderr, `${file}: invalid: could not read this file: ${why}\n`);
		}
		// The library holds the same limit for bytes it is given.
		await assert.rejects(
			convert(new Uint8Array(MAX_INPUT + 1), { name: "big.pdf" }),
			/larger than the 100 MB input limit/,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("seenline mcp --root takes existing folders only", () => {
	const result = run("mcp", "--root", join(tmpdir(), "seenline-no-such-folder"));
	assert.equal(result.status, 2);
	assert.match(result.stderr, /--root takes an existing folder/);
});

test("MCP with roots reads inside them only, by real path, and never names the path in an error", async () => {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "seenline-root-")));
	const server = createServer({}, [dir]);
	const client = new Client({ name: "limits", version: "1.0.0" });
	const [a, b] = InMemoryTransport.createLinkedPair();
	try {
		await writeFile(join(dir, "inside.csv"), "a,b\n1,2\n");
		await symlink(fixture("office-book.xlsx"), join(dir, "link.xlsx"));
		await server.connect(b);
		await client.connect(a);
		const call = async (path: string) =>
			(await client.callTool({ name: "convert_file", arguments: { path } })) as CallToolResult;
		const text = (r: CallToolResult) => (r.content[0]?.type === "text" ? r.content[0].text : "");
		assert.equal(text(await call(join(dir, "inside.csv"))), "[row 1]\na | b\n[row 2]\n1 | 2\n");
		const outside = "invalid: could not read this file: outside the folders this server may read";
		for (const path of [
			fixture("report.pdf"),
			join(dir, "link.xlsx"),
			join(dir, "..", "elsewhere.pdf"),
			"/etc/hosts",
		]) {
			const result = await call(path);
			assert.equal(result.isError, true);
			assert.equal(text(result), outside, path);
		}
		// A missing file and a link inside the root to a missing file elsewhere read the same.
		await symlink(join(tmpdir(), "seenline-no-such-target"), join(dir, "dangling.pdf"));
		for (const name of ["missing.pdf", "dangling.pdf"])
			assert.equal(
				text(await call(join(dir, name))),
				"invalid: could not read this file: no such file, or a link that cannot be followed",
			);
		// Legacy formats need temporary files, which the server never writes, whatever the name says.
		await assert.rejects(
			convert(Buffer.from("{\\rtf1 x}"), { name: "x.rtf", noTempFiles: true }),
			/legacy Office conversion requires temporary file writes/,
		);
	} finally {
		await client.close();
		await server.close();
		await rm(dir, { recursive: true, force: true });
	}
});
