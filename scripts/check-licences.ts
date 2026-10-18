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
// Enumerate physical packages: deduplicated JSON nodes can omit their path or
// appear before the full subtree, which would skip transitive dependencies.
const paths = new Set(
	execFileSync("npm", ["ls", "--omit=dev", "--all", "--parseable"], { encoding: "utf8" })
		.trim()
		.split("\n")
		.slice(1),
);
const bad: string[] = [];
for (const path of paths) {
	const pkg = JSON.parse(readFileSync(`${path}/package.json`, "utf8"));
	const licence = typeof pkg.license === "string" ? pkg.license : JSON.stringify(pkg.license);
	if (!ALLOWED.has(licence)) bad.push(`${pkg.name}@${pkg.version}: ${licence}`);
}
if (bad.length > 0) {
	console.error(`Licences outside the allow-list:\n${bad.join("\n")}`);
	process.exit(1);
}
console.log(`Licence check: ${paths.size} runtime packages, all allowed.`);
