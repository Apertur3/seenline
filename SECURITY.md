# Security policy

## Supported versions

The latest 0.x release. Fixes land there; older 0.x releases are not patched.

## Reporting

Use GitHub private vulnerability reporting on this repository (Security tab, "Report a vulnerability"). Please do not open a public issue for a vulnerability.

## What counts

- A vulnerability: anything that lets a crafted file make Plainview read or write files it should not, run code, reach the network, or escape the limits of the MCP server (which reads only the path it is given and writes nothing).
- A bug, not a vulnerability: hidden text that one of the documented detections should flag but does not. Open a normal issue with a file that shows it.

## What Plainview does not claim

It does not detect every way of hiding text, and it does not judge intent. The known gaps are listed in the README under "What it does not catch". A clean output is not proof that a file is safe to hand to a model.
