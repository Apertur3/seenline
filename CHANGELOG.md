# Changelog

Format: one heading per version. The anchor lines and the `[Hidden in the original]` block grammar are the output contract; changing them is a new major version.

## Unreleased

- PDF: with no text recognition, a file where only some pages have (almost) no text layer is read instead of refused; each such page keeps its anchor and the line `(no readable text layer on this page; it may be a scan or an image)`. A file where every page needs recognition still fails with `unavailable`; output with a working OCR callback is unchanged.
- HTML: XHTML reads (an `<?xml ...?>` declaration is kept as a comment, `<br/>` closes itself). A CSS rule whose selector is not supported is skipped when its declarations cannot hide text; one that can still fails closed. With a linked stylesheet, which already flags all text, the page's own CSS no longer fails the file.
- Email: mbox exports (a leading `From ` envelope line), header-less MIME parts, a trailing `;` after parameters and a multipart that lost its closing boundary are read as mail readers show them.
- PowerPoint: decks with sections (`p14:sectionLst`) no longer fail; section entries are not slides.
- HTML, email and Office failures name their class of cause (for example `an HTML element has too many attributes`, `unsupported CSS selector in a rule that can hide text`) instead of one generic message, without echoing document content.
- PDF: text outside its clipping path (`clipped`) and text squeezed or stretched past readability by horizontal scaling (`squeezed`) is listed under `[Hidden in the original]` instead of the body. Horizontal scaling now also moves the text position. Found with the Split-View canaries EG09 and EG13. Output changes for PDFs that use these.
- Add the `plainview` CLI with JSON, file output and hidden-content exit codes, and a stdio MCP server with the read-only `convert_file` tool.
- First port of the readers: PDF, Word, PowerPoint, Excel, CSV and TSV, HTML, email, subtitles and image metadata; the hidden-content scan (`plainview/hidden`); `convert()` with an optional injected OCR callback.
