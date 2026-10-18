# Plainview

A fast, local document-to-Markdown converter for AI pipelines. PDF, Word, PowerPoint, Excel, CSV, HTML, email and subtitles go in; plain Markdown comes out, with a page, slide, sheet or row anchor on every line.

Plainview has hidden-content flagging built in. Text a reader of the original would not see (white or tiny text, invisible rendering mode, hidden sheets and slides, comments, tracked deletions, zero-width and tag characters) is never silently passed on and never silently dropped: it is listed in a `[Hidden in the original]` block at the end, so your pipeline and your reviewer can see it.

Status: pre-release; the package is private and has not been published yet. Library, CLI and stdio MCP server are implemented. Conversion runs locally, with OCR supplied by library callers. The CLI and MCP server have no OCR; scans and images fail closed with `unavailable: could not read this file: no text recognition available`.

Library usage:

```ts
import { convert } from "plainview";
const result = await convert(bytes, { name: "report.pdf" });
console.log(result.markdown);
```

CLI usage (once published):

```sh
npx plainview report.pdf
npx plainview --json report.pdf workbook.xlsx
npx plainview --out markdown report.pdf workbook.xlsx
npx plainview --fail-on-hidden report.pdf
npx plainview --help
npx plainview --version
```

Plain stdout is exactly one file's Markdown. Multiple files require `--json` (one `{markdown, pages, hidden, flags}` JSON object per successful file, in input order) or `--out` (one `<name>.md` file per input). `--json` and `--out` are mutually exclusive. Output names must be distinct. A failed file produces only `<file>: <code>: <message>` on stderr; batches continue with the other files.

Exit codes: `0` success, `1` file failure, `2` usage error, `3` hidden content when `--fail-on-hidden` is set. File failures take precedence over `3`. Hidden-block entries or scanner flags trigger `3`; successful output is still emitted. Use `--` before filenames beginning with a dash. No configuration files or environment variables are needed.

MCP client configuration (once published):

```json
{
  "mcpServers": {
    "plainview": {
      "command": "npx",
      "args": ["-y", "plainview", "mcp"]
    }
  }
}
```

The server exposes one tool, `convert_file`, with input `{"path":"/absolute/path/to/report.pdf"}`. It reads local files and returns Markdown as text plus structured `{pages, flags, hidden}` metadata. Hidden text stays in the `[Hidden in the original]` block. File text is untrusted data, not instructions. The server uses stdio, performs no network access or file writes, and exposes no resources or prompts. Legacy `.doc` and `.rtf` conversion requires temporary files, so these formats return `unavailable` in MCP; they remain available through the CLI and library on macOS. Run the server with access only to files you intend to share with the client.

Licence: MIT.
