// The package makes no network access at runtime: no network modules, fetch or sockets in the shipped sources.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const SRC = new URL("../src/", import.meta.url).pathname;
const NETWORK =
	/node:(?:https?|http2|net|tls|dns|dgram)\b|(?:from\s*|import\s*\(|require\s*\()\s*["'](?:https?|http2|net|tls|dns|dgram)["']|\bfetch\s*\(|XMLHttpRequest|WebSocket|\bEventSource\b/;

test("shipped sources use no network API", () => {
	for (const name of readdirSync(SRC, { recursive: true, encoding: "utf8" })) {
		if (!name.endsWith(".ts")) continue;
		assert.doesNotMatch(
			readFileSync(join(SRC, name), "utf8"),
			NETWORK,
			`network use in src/${name}`,
		);
	}
});

test("core entry points never load MCP dependencies and the server imports only stdio transport", () => {
	const seen = new Set<string>();
	function visit(path: string) {
		if (seen.has(path)) return;
		seen.add(path);
		const source = readFileSync(path, "utf8");
		assert.doesNotMatch(source, /@modelcontextprotocol|["']zod(?:\/|["'])/, path);
		for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*["'](\.\.?\/[^"']+\.ts)["']/g)) {
			visit(resolve(dirname(path), match[1] as string));
		}
	}
	visit(join(SRC, "index.ts"));
	visit(join(SRC, "hidden.ts"));
	for (const name of readdirSync(SRC, { encoding: "utf8" })) {
		if (!name.endsWith(".ts")) continue;
		const source = readFileSync(join(SRC, name), "utf8");
		if (name !== "mcp.ts") assert.doesNotMatch(source, /@modelcontextprotocol|["']zod["']/);
		for (const match of source.matchAll(/["'](@modelcontextprotocol\/[^"']+)["']/g)) {
			assert.ok(
				[
					"@modelcontextprotocol/sdk/server/mcp.js",
					"@modelcontextprotocol/sdk/server/stdio.js",
				].includes(match[1] as string),
				`unexpected MCP import: ${match[1]}`,
			);
		}
	}
});

test("no install scripts that could download code", () => {
	const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	for (const hook of ["preinstall", "install", "postinstall"]) {
		assert.equal(manifest.scripts?.[hook], undefined, `${hook} script present`);
	}
});
