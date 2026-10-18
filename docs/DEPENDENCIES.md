# Dependencies

| Package | Kind | What and why | Licence |
| --- | --- | --- | --- |
| pdfjs-dist 6.4.299 | Runtime | Local PDF drawing operators, text, annotations and metadata. Uses `legacy/build`, `cmaps` and `standard_fonts`; no rendering or network required. | Apache-2.0 |
| fflate 0.8.3 | Runtime | Local ZIP decoding for DOCX, PPTX and XLSX, plus synthetic fixture generation. XML readers and extraction budgets live in this library. | MIT |
| @modelcontextprotocol/sdk 1.32.1 | Runtime, MCP entry only | MCP tool registration, schemas and stdio transport. No HTTP or other network transport is started. | MIT |
| zod 4.6.7 | Runtime, MCP entry only | Validate the MCP tool input and describe its structured output. | MIT |

Node built-ins supply file handling, temporary directories, decompression and the test runner. OCR is a caller callback. Legacy `.doc` and `.rtf` use macOS `/usr/bin/textutil` and fail closed on other systems.

The core library and `plainview/hidden` never import the MCP SDK or zod. The CLI loads the MCP entry only for `plainview mcp`. The SDK installs additional transitive dependencies, including network transports; Plainview uses its stdio transport only. `npm run licences` checks the entire installed runtime tree.
