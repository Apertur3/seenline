# Reference outputs

The 62 Markdown files were generated from the read-only export pinned at commit **bca4fe5**, using its `documentToText` function. The two subtitle files use its `subtitlesToText` function, as they do in the reference router.

Run `npm run golden` with that export available under `.ref/`. The generator discovers the directory by commit suffix and never imports the current readers. `npm test` compares output bytes, including whitespace and final newlines, and checks that every readable fixture has exactly one golden.

Images and scanned PDFs use the committed executable `scripts/ocr-stub.ts` through the reference's OCR-helper environment override. Tests inject the same deterministic answers as an OCR callback. These outputs verify conversion and metadata handling, not recognition accuracy. Native OCR and its platform binaries are outside this library.

The three raw `a4-*` Unicode/markup samples have JSON snapshots from reference `scan` and `visible`, excluding the consumer-only speaker class. A fourth JSON snapshot records the reference error code and message for the valid password-protected synthetic PDF. All 66 fixture results are compared with the reference. Legacy `.doc` and `.rtf` goldens require macOS `textutil`; their conversion tests are skipped on other platforms, where refusal is tested instead.
