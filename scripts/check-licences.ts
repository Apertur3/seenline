// Fails when any installed runtime dependency (direct or transitive) has a licence outside the allow-list.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ALLOWED = new Set([
	"MIT",
	"Apache-2.0",
	"BSD-2-Clause",
	"BSD-3-Clause",
	"ISC",
	"MPL-2.0",
	"0BSD",
]);
const tree = JSON.parse(
	execFileSync("npm", ["ls", "--omit=dev", "--all", "--json", "--long"], { encoding: "utf8" }),
);
const bad: string[] = [];
const seen = new Set<string>();
function walk(deps: Record<string, { path?: string; dependencies?: object }> | undefined) {
	for (const [name, node] of Object.entries(deps ?? {})) {
		if (!node.path || seen.has(node.path)) continue;
		seen.add(node.path);
		const pkg = JSON.parse(readFileSync(`${node.path}/package.json`, "utf8"));
		const licence = typeof pkg.license === "string" ? pkg.license : JSON.stringify(pkg.license);
		if (!ALLOWED.has(licence)) bad.push(`${name}@${pkg.version}: ${licence}`);
		walk(node.dependencies as never);
	}
}
walk(tree.dependencies);
if (bad.length > 0) {
	console.error(`Licences outside the allow-list:\n${bad.join("\n")}`);
	process.exit(1);
}
console.log(`Licence check: ${seen.size} runtime packages, all allowed.`);
