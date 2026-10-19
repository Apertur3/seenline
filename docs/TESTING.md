# Reader verification

`npm test` first builds the package, then runs TypeScript tests directly with Node type stripping. `npm run check` runs strict type checking and Biome. `npm run build` emits ESM JavaScript and declarations; `npm run smoke` imports built JavaScript with plain Node, converts a PDF, DOCX and XLSX, and compares a CLI PDF conversion to its golden. Runtime dependencies stay pinned to the rows in DEPENDENCIES.md.

CLI tests spawn `dist/cli.js` and check exact golden stdout, JSON lines, output files, refusal paths, usage errors and hidden-content exit codes. MCP tests use the SDK's in-memory transport for discovery, golden Markdown and structured metadata, invalid paths, missing files, missing OCR and refusal of legacy Office formats that require temporary writes; an additional built stdio round trip checks the actual subcommand. The recursive no-network source scan includes the CLI and MCP files and enforces MCP dependency isolation from both core entry points. All tests run offline.

The golden inventory contains 62 readable fixtures: documents, document injection sources and subtitles. Goldens come exclusively from reference commit bca4fe5; see `test/golden/README.md`. Three raw Unicode/markup fixtures have byte-identical scanner snapshots, and an additional valid password-protected PDF has a reference refusal snapshot. Its synthetic password is `fixture`; it was checked to open with that password and refuse without it. Every fixture format has empty-input and structurally truncated-input refusal coverage. CSV/TSV and HTML truncation samples end inside a quoted field or attribute: a shorter but otherwise valid text document cannot be identified as truncated from bytes alone. Encrypted Office containers and ZIP encryption bits are also tested.

The port preserves PDF operators and extras, image metadata, Office XML/ZIP checks, HTML/CSS, MIME, subtitle text and timing, legacy conversion and the six hidden-content scan classes. OCR callbacks receive a supplied path or a private temporary copy that is deleted on success and failure. Without a callback, an image or a PDF whose every page needs recognition fails with `unavailable`. When only some pages need it and no callback reads them (none given, or it fails), the text pages are kept and each other page carries the fixed `(no readable text layer on this page; ...)` line under its anchor; the reference left those pages empty. Page counts include hidden slides and sheets; unpaginated formats report one logical document. Optional reader names describe OCR pages and native PDF pages when the callback names its reader.

## Reference tests

| Suite | Reader coverage retained | Consumer integration left out |
| --- | --- | --- |
| documents | PDF anchors and tables, invisible text, malformed PDF, OCR routing/empty results/failure, every document canary | Inbox/archive bookkeeping, client calls, native OCR recognition accuracy |
| office | All fact/row/anchor/hidden assertions; delimiter detection, row budgets and malformed/encrypted inputs | None |
| office-safety | All six cases: inherited backgrounds/default styles, inherited slide formatting, ZIP integrity/XML rejection, custom attributes | None |
| mail | All facts, structure, headers, alternatives, attachments, encodings, hidden inheritance, budgets and MSG refusal | Inbox/archive bookkeeping and vault verification |
| mail-safety | All five cases: CSS inheritance/cascade, malformed/ambiguous styles, external styles, fake markers, UTF-8 headers and colour syntax | None |
| legacy-office | Conversion, hidden canaries, cleanup, damaged input and explicit Windows/Linux refusal | Platform-inapplicable cases retain their original skip conditions |
| subtitles | VTT/SRT cue order, speakers, tags, entities, time anchors and empty-cue refusal | Claim time inheritance/overrides and inbox/archive bookkeeping |
| office/mail boundary | Preservation exactly once, hidden-header position, scan flags and hidden lines; parsed hidden metadata added | Claims, acceptance policy, quarantine roles and fenced client responses |
| office/mail mutation | Child-process source hooks must kill the boundary tests when the hidden header is removed; production files stay unchanged | None |

No model harness, audio, transcription, vault, policy, claim flags or speaker scanner class is included. Speaker names in subtitles and presenter notes remain ordinary document content.

## Offline fixture generation

All copied files are synthetic. `node scripts/office-fixtures.ts` and `node scripts/mail-fixtures.ts` regenerate the hand-authored Office and mail sets using installed dependencies only. Keys and facts remain independent answer data.

`make-fixtures.ts`, `make-hard.ts` and `make-injection.ts` require an already installed Playwright with its Chromium browser. They run offline and never install or download tools. The fixture-only browser adapter resolves the optional tool locally or through `NODE_PATH`; it is not a package dependency. Browser builds and system fonts can change generated PDF/image bytes: regenerate goldens from the pinned reference after changing fixtures.

`python3 scripts/make-office.py` recreates the other Office binaries and QR image used by the document injection cases. It requires already installed `python-docx`, `python-pptx`, `openpyxl` and `qrcode` with Pillow. No Python tools are needed to run tests, build or regenerate goldens. The two legacy Office binaries are copied synthetic fixtures, exercised through system `textutil` on macOS.

OCR uses deterministic stub output in this suite. Recognition quality, layout benchmarking and competitor comparisons belong to a later phase.
