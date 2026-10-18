# Changelog

Format: one heading per version. The anchor lines and the `[Hidden in the original]` block grammar are the output contract; changing them is a new major version.

## Unreleased

- Add the `plainview` CLI with JSON, file output and hidden-content exit codes, and a stdio MCP server with the read-only `convert_file` tool.
- First port of the readers: PDF, Word, PowerPoint, Excel, CSV and TSV, HTML, email, subtitles and image metadata; the hidden-content scan (`plainview/hidden`); `convert()` with an optional injected OCR callback.
