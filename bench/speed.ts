// Set F: cold start, peak memory, install size and warm per-page time of Plainview, measured on a
// clean install of the packed tarball. `speed` writes <cache>/speed.json; `speedSection` renders it.
import { execFileSync, spawnSync } from "node:child_process";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { cpus, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { convert } from "../src/index.ts";
import { median } from "./stats.ts";

const root = join(import.meta.dirname, "..");
const sample = join(root, "test/fixtures/documents/report.pdf");
const REPS = 3;

const size = (path: string): number => {
	const st = lstatSync(path); // lstat: a symlink counts as itself, never twice
	return st.isDirectory()
		? readdirSync(path).reduce((sum, name) => sum + size(join(path, name)), 0)
		: st.size;
};

const sh = (cmd: string, args: string[], cwd: string) =>
	execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

/** Peak resident set of one run: BSD `time -l` reports bytes, GNU `time -v` reports KiB. */
function peakMemory(bin: string): { bytes: number; tool: string } | null {
	const mac = platform() === "darwin";
	const args = [mac ? "-l" : "-v", process.execPath, bin, sample];
	const r = spawnSync("/usr/bin/time", args, {
		encoding: "utf8",
		stdio: ["ignore", "ignore", "pipe"],
	});
	const m = r.stderr?.match(
		mac ? /(\d+)\s+maximum resident set size/ : /Maximum resident set size \(kbytes\): (\d+)/,
	);
	return m ? { bytes: Number(m[1]) * (mac ? 1 : 1024), tool: `/usr/bin/time ${args[0]}` } : null;
}

export async function speed(cache: string): Promise<void> {
	const work = mkdtempSync(join(tmpdir(), "plainview-speed-"));
	try {
		sh("npm", ["run", "build", "--silent"], root);
		const tarball = sh("npm", ["pack", "--silent", "--pack-destination", work], root).trim();
		const app = join(work, "app");
		mkdirSync(app);
		sh("npm", ["init", "-y"], app);
		sh(
			"npm",
			["install", "--silent", "--ignore-scripts", "--prefer-offline", join(work, tarball)],
			app,
		);
		const bin = join(app, "node_modules/plainview/dist/cli.js");
		const wall = Array.from({ length: REPS }, () => {
			const t = performance.now();
			const run = spawnSync(process.execPath, [bin, sample], { stdio: "ignore" });
			if (run.status !== 0) throw new Error(`cold start run failed: status ${run.status}`);
			return (performance.now() - t) / 1000;
		});
		const memory = peakMemory(bin);
		// Warm: one in-process warm-up, then the median of REPS runs, divided by the page count.
		const bytes = readFileSync(sample);
		await convert(bytes, { name: "report.pdf", path: sample });
		const warm: number[] = [];
		let pages = 0;
		for (let i = 0; i < REPS; i++) {
			const t = performance.now();
			const out = await convert(bytes, { name: "report.pdf", path: sample });
			warm.push((performance.now() - t) / 1000);
			pages = out.markdown.split("\n").filter((l) => /^\[p\. \d+\]$/.test(l)).length;
		}
		writeFileSync(
			join(cache, "speed.json"),
			JSON.stringify({
				date: new Date().toISOString().slice(0, 10),
				node: process.version,
				cpu:
					cpus()[0]
						?.model.replace(/\((R|TM)\)/g, "")
						.trim() ?? "?",
				coldSeconds: median(wall),
				coldRuns: wall,
				peakBytes: memory?.bytes ?? null,
				peakTool: memory?.tool ?? "unavailable",
				tarballBytes: size(join(work, tarball)),
				installBytes: size(join(app, "node_modules")),
				pages,
				warmSeconds: median(warm),
			}),
		);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

interface Speed {
	date: string;
	node: string;
	cpu: string;
	coldSeconds: number;
	coldRuns: number[];
	peakBytes: number | null;
	peakTool: string;
	tarballBytes: number;
	installBytes: number;
	pages: number;
	warmSeconds: number;
}

export function speedSection(cache: string, version: string, hardware: string): string {
	let s: Speed;
	try {
		s = JSON.parse(readFileSync(join(cache, "speed.json"), "utf8"));
	} catch {
		return "## Speed and size (set F)\n\nNot run for this report (`npm run bench -- speed`); no claim is made.\n";
	}
	const mib = (b: number) => `${(b / 2 ** 20).toFixed(1)} MiB`;
	return `## Speed and size (set F)

Plainview ${version}, ${s.date}, Node ${s.node}. Hardware: ${hardware}, CPU class ${s.cpu}. Measured on a clean install of the
packed tarball (\`npm pack\`, then \`npm install\` into an empty directory), on \`report.pdf\` (${s.pages} pages), median of ${REPS} runs.

| measure | value |
| --- | --- |
| cold start, \`node cli.js report.pdf\`, spawn to exit | ${s.coldSeconds.toFixed(3)} s (runs: ${s.coldRuns.map((x) => x.toFixed(3)).join(", ")}) |
| peak memory (max resident set of that process, via ${s.peakTool}) | ${s.peakBytes === null ? "-" : mib(s.peakBytes)} |
| warm conversion, in process, after one warm-up | ${s.warmSeconds.toFixed(4)} s, ${(s.warmSeconds / Math.max(s.pages, 1)).toFixed(4)} s per page |
| package tarball | ${(s.tarballBytes / 1024).toFixed(1)} KiB |
| clean install (all of node_modules, apparent bytes) | ${mib(s.installBytes)} |

The page count comes from the fixture's own anchors. The document is small, so read the per-page figure as a floor, not a throughput figure.
`;
}
