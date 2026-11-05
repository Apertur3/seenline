# Security policy

## Supported versions

The latest 0.x release. Fixes land there; older 0.x releases are not patched.

## Reporting

Use GitHub private vulnerability reporting on this repository (Security tab, "Report a vulnerability"). Please do not open a public issue for a vulnerability.

## What counts

- A vulnerability: anything that lets a crafted file make Seenline read or write files it should not, run code, reach the network, exhaust memory or stall the process past the resource limits below, or escape the limits of the MCP server (which writes nothing, and with `--root` reads only files whose real path lies inside the given folders).
- A bug, not a vulnerability: hidden text that one of the documented detections should flag but does not. Open a normal issue with a file that shows it.

## The MCP server reads any path unless limited

Without `--root`, `seenline mcp` reads any absolute path the client asks for, with the rights of the user who runs it; a prompt injection in the client can ask for any file. Start it with `--root <dir>` (repeatable) to limit it to files whose real path, after symbolic links, lies inside those folders. Error messages name the cause in fixed words and never repeat the path or the system's own message.

## Resource limits

An input over 100 MB, a pipe, a device or a folder is refused before it is read; a file is opened without waiting on a pipe and read once. A PDF is read in a worker thread with a 1 GB heap, a 2 GB limit on the process's memory growth (decoded streams included) and a 120 second deadline: past any of them the file fails with that cause and the process keeps running. A PDF has at most 300 pages and 100,000 text runs a page. Office files and CSV are read up to 50 MB (a package up to 5,000 parts, 32 MB a part and 64 MB unpacked, each part decompressed into a buffer of its declared size), email up to 50 MB, an HTML file or part up to 5 MB, and an Office, HTML or email file's Markdown up to 5 MB. A hidden block of more than 100,000 entries fails the file; up to that, reading the block for instructions costs one joined check per entry (about ten seconds at the limit). The regular expressions run on document text are written to take time linear in its length; `test/limits.test.ts` holds hostile inputs of 100,000 characters to a deadline.

## What Seenline does not claim

It does not detect every way of hiding text, and it does not judge intent. The known gaps are listed in the README under "What it does not catch". A clean output is not proof that a file is safe to hand to a model.
