// The package makes no network access at runtime: no network modules, fetch or sockets in the shipped sources.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const SRC = new URL("../src/", import.meta.url).pathname;
const NETWORK =
	/node:(?:https?|http2|net|tls|dns|dgram)\b|from\s+["'](?:https?|net|tls|dns|dgram)["']|\bfetch\s*\(|XMLHttpRequest|WebSocket|\bEventSource\b/;

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

test("no install scripts that could download code", () => {
	const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	for (const hook of ["preinstall", "install", "postinstall"]) {
		assert.equal(manifest.scripts?.[hook], undefined, `${hook} script present`);
	}
});
