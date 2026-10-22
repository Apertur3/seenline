# Contributing

## Run the gate

```sh
npm ci
sh scripts/ci.sh fast        # lint, types, size, unit, golden, sweep
sh scripts/ci.sh candidate   # fast plus acceptance (build, smoke, CLI and MCP tests)
```

A change is ready when `candidate` is green. Tiers and commands live in `factory.json`.

## Output contract

The anchor lines and the `[Hidden in the original]` block grammar are a public contract. Any change to either is a new semver major and needs a CHANGELOG.md entry.

## Fixtures and goldens

Files in `test/golden/` are byte-identical to a pinned reference. Change them only in a commit of their own, with the reason in the message. Fixtures are synthetic or redacted real files; never add a file with personal data.

## Size

Source files aim for under 400 lines and must stay under 1,000. A file already over the limit may only shrink. Units may not grow more than 10% per release without a recorded exemption. `python3 scripts/check-size netloc main...HEAD` shows a branch's net lines; prefer deleting to adding.

## Commits and public hygiene

No AI attribution trailers, no personal data (names, emails, home paths), and no machine names or addresses in files or commit messages. `sh scripts/sweep.sh` checks this.
