# Plainview

A fast, local document-to-Markdown converter for AI pipelines. PDF, Word, PowerPoint, Excel, CSV, HTML, email and subtitles go in; plain Markdown comes out, with a page, slide, sheet or row anchor on every line.

Plainview has hidden-content flagging built in. Text a reader of the original would not see (white or tiny text, invisible rendering mode, hidden sheets and slides, comments, tracked deletions, zero-width and tag characters) is never silently passed on and never silently dropped: it is listed in a `[Hidden in the original]` block at the end, so your pipeline and your reviewer can see it.

Status: pre-release library; CLI and MCP server are planned. Conversion runs locally, with OCR supplied by the caller.

```ts
import { convert } from "plainview";
const result = await convert(bytes, { name: "report.pdf" });
console.log(result.markdown);
```

Licence: MIT.
