#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { convertFile, errorMessage, formatError } from "./file.ts";
import { version } from "./version.ts";

const HELP = `Usage: plainview <file> [more files] [options]
       plainview mcp

Convert local documents to Markdown. Scans require OCR and fail closed.

  --json             Write one JSON object per file to stdout
  --out <dir>        Write <name>.md files instead of stdout
  --fail-on-hidden   Exit 3 if any successful file has hidden content
  --help             Show this help
  --version          Show the package version

Multiple files require --json or --out. These options are mutually exclusive.
Use -- before filenames beginning with a dash (or ./mcp for a file named mcp).
Exit codes: 0 success, 1 file failure, 2 usage error, 3 hidden content.
File failures take precedence over hidden content. Failed files emit no output.
`;

function parse(args: string[]) {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			json: { type: "boolean" },
			out: { type: "string" },
			"fail-on-hidden": { type: "boolean" },
			help: { type: "boolean" },
			version: { type: "boolean" },
		},
	});
	if (values.help || values.version) return { values, files: positionals };
	if (positionals.length === 0) throw new Error("provide at least one file");
	if (values.json && values.out !== undefined) throw new Error("use either --json or --out");
	if (values.out === "") throw new Error("--out requires a nonempty directory");
	if (positionals.length > 1 && !values.json && values.out === undefined)
		throw new Error("multiple files require --json or --out");
	if (values.out !== undefined) {
		const outputs = positionals.map((file) => resolve(values.out as string, outputName(file)));
		if (new Set(outputs).size !== outputs.length)
			throw new Error("input filenames would write the same output file");
	}
	return { values, files: positionals };
}

function outputName(file: string): string {
	return `${basename(file, extname(file))}.md`;
}

async function run(args: string[]): Promise<number> {
	if (args[0] === "mcp") {
		if (args.length !== 1) return usage("mcp takes no options or filenames");
		const { startMcp } = await import("./mcp.ts");
		await startMcp();
		return 0;
	}
	let options: ReturnType<typeof parse>;
	try {
		options = parse(args);
	} catch (error) {
		return usage(errorMessage(error));
	}
	const { values, files } = options;
	if (values.help || values.version) {
		process.stdout.write(values.help ? HELP : `${version}\n`);
		return 0;
	}
	let failed = false;
	let hidden = false;
	for (const file of files) {
		try {
			const { markdown, pages, hidden: entries, flags } = await convertFile(file);
			if (values.out !== undefined) {
				await mkdir(values.out, { recursive: true });
				await writeFile(join(values.out, outputName(file)), markdown);
			} else {
				process.stdout.write(
					values.json
						? `${JSON.stringify({ markdown, pages, hidden: entries, flags })}\n`
						: markdown,
				);
			}
			hidden ||= entries.length > 0 || flags.length > 0;
		} catch (error) {
			process.stderr.write(`${file}: ${formatError(error)}\n`);
			failed = true;
		}
	}
	return failed ? 1 : values["fail-on-hidden"] && hidden ? 3 : 0;
}

function usage(message: string): number {
	process.stderr.write(`plainview: ${message}\nRun plainview --help for usage.\n`);
	return 2;
}

try {
	process.exitCode = await run(process.argv.slice(2));
} catch (error) {
	process.stderr.write(`plainview: ${formatError(error)}\n`);
	process.exitCode = 1;
}
