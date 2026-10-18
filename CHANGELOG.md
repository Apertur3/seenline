# Changelog

Format: one heading per version. The anchor lines and the `[Hidden in the original]` block grammar are the output contract; changing them is a new major version.

## Unreleased

- PDF: text outside its clipping path (`clipped`) and text squeezed or stretched past readability by horizontal scaling (`squeezed`) is listed under `[Hidden in the original]` instead of the body. Horizontal scaling now also moves the text position. Found with the Split-View canaries EG09 and EG13. Output changes for PDFs that use these.
- Add the `plainview` CLI with JSON, file output and hidden-content exit codes, and a stdio MCP server with the read-only `convert_file` tool.
- First port of the readers: PDF, Word, PowerPoint, Excel, CSV and TSV, HTML, email, subtitles and image metadata; the hidden-content scan (`plainview/hidden`); `convert()` with an optional injected OCR callback.
