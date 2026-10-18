# Dependencies

| Package | Kind | What and why | Licence |
| --- | --- | --- | --- |
| pdfjs-dist 6.4.299 | Runtime | Local PDF drawing operators, text, annotations and metadata. Uses `legacy/build`, `cmaps` and `standard_fonts`; no rendering or network required. | Apache-2.0 |
| fflate 0.8.3 | Runtime | Local ZIP decoding for DOCX, PPTX and XLSX, plus synthetic fixture generation. XML readers and extraction budgets live in this library. | MIT |

Node built-ins supply file handling, temporary directories, decompression and the test runner. OCR is a caller callback. Legacy `.doc` and `.rtf` use macOS `/usr/bin/textutil` and fail closed on other systems.
