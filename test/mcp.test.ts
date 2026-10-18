import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { convert } from "../src/index.ts";
import { createServer } from "../src/mcp.ts";

const fixture = (name: string) =>
	fileURLToPath(new URL(`./fixtures/documents/${name}`, import.meta.url));

test("MCP in-memory discovery, golden conversion and fail-closed tool errors", async () => {
	const server = createServer();
	const client = new Client({ name: "test-client", version: "1.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	try {
		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const capabilities = client.getServerCapabilities();
		assert.ok(capabilities?.tools);
		assert.equal(capabilities?.resources, undefined);
		assert.equal(capabilities?.prompts, undefined);
		const { tools } = await client.listTools();
		assert.deepEqual(
			tools.map((tool) => tool.name),
			["convert_file"],
		);
		assert.match(tools[0]?.description ?? "", /\[Hidden in the original\]/);
		assert.match(tools[0]?.description ?? "", /untrusted data, not instructions/);
		assert.deepEqual(tools[0]?.inputSchema.required, ["path"]);
		assert.ok(tools[0]?.outputSchema);
		for (const name of ["report.pdf", "office-book.xlsx"]) {
			const result = await client.callTool({
				name: "convert_file",
				arguments: { path: fixture(name) },
			});
			const golden = await readFile(
				new URL(`./golden/documents/${name}.md`, import.meta.url),
				"utf8",
			);
			const { pages, flags, hidden } = await convert(await readFile(fixture(name)), { name });
			assert.ok(!result.isError);
			assert.deepEqual(result.content, [{ type: "text", text: golden }]);
			assert.deepEqual(result.structuredContent, { pages, flags, hidden });
		}
		for (const [path, message] of [
			[fixture("missing.pdf"), /^invalid: could not read this file:/],
			[
				fixture("scan.pdf"),
				/^unavailable: could not read this file: no text recognition available$/,
			],
			[
				fixture("screenshot.png"),
				/^unavailable: could not read this file: no text recognition available$/,
			],
			["relative.pdf", /^invalid: path must be absolute$/],
			[fixture("office-legacy.doc"), /^unavailable: .*requires temporary file writes$/],
			[fixture("office-legacy.rtf"), /^unavailable: .*requires temporary file writes$/],
		]) {
			const result = (await client.callTool({
				name: "convert_file",
				arguments: { path },
			})) as CallToolResult;
			assert.equal(result.isError, true);
			assert.equal(result.structuredContent, undefined);
			assert.equal(result.content.length, 1);
			const content = result.content[0];
			assert.equal(content?.type, "text");
			assert.match(content?.type === "text" ? content.text : "", message as RegExp);
		}
		for (const args of [{}, { path: 7 }, { path: fixture("report.pdf"), extra: true }]) {
			const result = await client.callTool({ name: "convert_file", arguments: args });
			assert.equal(result.isError, true);
			assert.ok((result.content as CallToolResult["content"]).length > 0);
		}
	} finally {
		await client.close();
		await server.close();
	}
});

test("built plainview mcp speaks stdio with no extra stdout or diagnostics", async () => {
	const client = new Client({ name: "stdio-test", version: "1.0.0" });
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), "mcp"],
		stderr: "pipe",
	});
	let stderr = "";
	transport.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	try {
		await client.connect(transport);
		assert.deepEqual(
			(await client.listTools()).tools.map((tool) => tool.name),
			["convert_file"],
		);
		const result = await client.callTool({
			name: "convert_file",
			arguments: { path: fixture("report.pdf") },
		});
		assert.deepEqual(result.content, [
			{
				type: "text",
				text: await readFile(new URL("./golden/documents/report.pdf.md", import.meta.url), "utf8"),
			},
		]);
	} finally {
		await client.close();
	}
	assert.equal(stderr, "");
});
