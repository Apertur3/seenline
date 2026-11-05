#!/bin/sh
# Artifact check: pack the package, install the tarball into a clean directory and run the shipped binary.
# The output must match the golden for report.pdf, and the tarball must hold only what a release should ship.
set -eu
cd "$(dirname "$0")/.."
npm run build >/dev/null
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
tarball=$(npm pack --silent --pack-destination "$work")
files=$(tar -tzf "$work/$tarball" | sed 's#^package/##')
echo "$files" | grep -qx 'dist/cli.js' || { echo "pack-smoke: dist/cli.js is missing from the tarball"; exit 1; }
extra=$(echo "$files" | grep -v -E '^(dist/|docs/|README\.md$|LICENSE$|CHANGELOG\.md$|package\.json$)' || true)
[ -z "$extra" ] || { echo "pack-smoke: unexpected files in the tarball:"; echo "$extra"; exit 1; }
mkdir "$work/app"
(cd "$work/app" && npm init -y >/dev/null && npm install --silent --ignore-scripts --prefer-offline "../$tarball")
"$work/app/node_modules/.bin/seenline" test/fixtures/documents/report.pdf | cmp - test/golden/documents/report.pdf.md \
	|| { echo "pack-smoke: installed binary output differs from the golden"; exit 1; }
echo "pack-smoke: ok ($(echo "$files" | wc -l | tr -d ' ') files)"
