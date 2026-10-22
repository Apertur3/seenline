#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { convertFile, errorMessage, formatError, type Readers } from "./file.ts";
import { tesseract } from "./ocr.ts";
import { HIDDEN_MODES } from "./parse-hidden.ts";
import type { ConvertOptions } from "./types.ts";
import { version } from "./version.ts";

const HELP = `Usage: plainview <file> [more files] [options]
       plainview mcp [--ocr] [--verify] [--ocr-lang <lang>]

Convert local documents to Markdown. Scans and images fail closed unless --ocr is set.

  --json             Write one JSON object per file to stdout
  --out <dir>        Write <name>.md files instead of stdout
  --fail-on-hidden   Exit 3 if any successful file has hidden content
  --hidden <mode>    How the hidden block shows hidden text: describe (default; location, kind
                     and size), text (the text itself) or framed (the text after an
                     untrusted-data line). --json keeps the text in every mode
  --fail-on-suspect  Exit 4 if a hidden entry reads like an instruction to an AI (a rule-based
                     signal for triage; explicit instructions only, not hidden keyword lists)
  --ocr              Read scans and images with a local tesseract (PDF pages also need
                     pdftoppm from poppler); off by default, nothing leaves the machine
  --verify           Compare each PDF page's text layer with a text recognition reading of
                     the rendered page (same tools as --ocr) and list the pages that differ
  --ocr-lang <lang>  Tesseract languages for --ocr and --verify, for example deu or eng+nld
                     (default eng)
  --help             Show this help
  --version          Show the package version

Multiple files require --json or --out. These options are mutually exclusive.
Use -- before filenames beginning with a dash (or ./mcp for a file named mcp).
Exit codes: 0 success, 1 file failure, 2 usage error, 3 hidden content, 4 suspect hidden text.
Precedence: 1, then 4, then 3. Failed files emit no output.
`;

function parse(args: string[]) {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			json: { type: "boolean" },
			out: { type: "string" },
			"fail-on-hidden": { type: "boolean" },
			"fail-on-suspect": { type: "boolean" },
			hidden: { type: "string" },
			...OCR_OPTIONS,
			help: { type: "boolean" },
			version: { type: "boolean" },
		},
	});
	if (values.help || values.version) return { values, files: positionals };
	if (positionals.length === 0) throw new Error("provide at least one file");
	if (values.json && values.out !== undefined) throw new Error("use either --json or --out");
	if (values.out === "") throw new Error("--out requires a nonempty directory");
	const hidden = values.hidden as ConvertOptions["hidden"];
	if (hidden !== undefined && !HIDDEN_MODES.includes(hidden))
		throw new Error("--hidden takes text, framed or describe");
	if (positionals.length > 1 && !values.json && values.out === undefined)
		throw new Error("multiple files require --json or --out");
	if (values.out !== undefined) {
		const outputs = positionals.map((file) => resolve(values.out as string, outputName(file)));
		if (new Set(outputs).size !== outputs.length)
			throw new Error("input filenames would write the same output file");
	}
	return { values, files: positionals, readers: readersFrom(values), hidden };
}

const OCR_OPTIONS = {
	ocr: { type: "boolean" },
	verify: { type: "boolean" },
	"ocr-lang": { type: "string" },
} as const;

function readersFrom(values: { ocr?: boolean; verify?: boolean; "ocr-lang"?: string }): Readers {
	const lang = values["ocr-lang"];
	if (lang !== undefined && !values.ocr && !values.verify)
		throw new Error("--ocr-lang requires --ocr or --verify");
	if (lang !== undefined && !/^[A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*$/.test(lang))
		throw new Error("--ocr-lang takes tesseract language codes such as eng or eng+deu");
	const read = tesseract(lang ?? "eng");
	return { ...(values.ocr && { ocr: read }), ...(values.verify && { verify: read }) };
}

function outputName(file: string): string {
	return `${basename(file, extname(file))}.md`;
}

async function run(args: string[]): Promise<number> {
	if (args[0] === "mcp") {
		let readers: Readers;
		try {
			readers = readersFrom(parseArgs({ args: args.slice(1), options: OCR_OPTIONS }).values);
		} catch (error) {
			return usage(errorMessage(error));
		}
		const { startMcp } = await import("./mcp.ts");
		await startMcp(readers);
		return 0;
	}
	let options: ReturnType<typeof parse>;
	try {
		options = parse(args);
	} catch (error) {
		return usage(errorMessage(error));
	}
	const { values, files, readers, hidden: mode } = options;
	if (values.help || values.version) {
		process.stdout.write(values.help ? HELP : `${version}\n`);
		return 0;
	}
	let failed = false;
	let hidden = false;
	let suspect = false;
	for (const file of files) {
		try {
			const {
				markdown,
				pages,
				hidden: entries,
				flags,
			} = await convertFile(file, {
				...readers,
				...(mode && { hidden: mode }),
			});
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
			suspect ||= entries.some((e) => e.suspect);
		} catch (error) {
			process.stderr.write(`${file}: ${formatError(error)}\n`);
			failed = true;
		}
	}
	if (failed) return 1;
	if (values["fail-on-suspect"] && suspect) return 4;
	return values["fail-on-hidden"] && hidden ? 3 : 0;
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
