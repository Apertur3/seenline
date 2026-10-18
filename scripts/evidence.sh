#!/bin/sh
# Merge the CI record for the land tier with a review verdict into the evidence file land.sh validates.
# Usage: sh scripts/evidence.sh <sha> <LAND|HOLD|ERROR> "<reviewer>" "<notes>"
# Run `sh scripts/ci.sh <land_tier>` on a clean checkout of <sha> first. Never edits an existing evidence file.
set -eu
cd "$(dirname "$0")/.."
[ "$#" -eq 4 ] || { echo "usage: evidence.sh <sha> <LAND|HOLD|ERROR> <reviewer> <notes>"; exit 2; }
sha=$(git rev-parse --verify -q "$1^{commit}") || { echo "evidence.sh: unknown commit $1"; exit 2; }
dir="$(git rev-parse --git-common-dir)/factory/evidence"
python3 - "$sha" "$dir" "$2" "$3" "$4" <<'PY'
import json, os, subprocess, sys
sha, d, verdict, by, notes = sys.argv[1:]
git = lambda *a: subprocess.run(["git", *a], capture_output=True, text=True, check=True).stdout.strip()
tier = json.loads(git("show", f"{sha}:factory.json"))["land_tier"]
ci = json.load(open(f"{d}/{sha}.ci-{tier}.json"))
bad = [c["name"] for c in ci["checks"] if c["status"] != "pass"]
if bad or ci.get("dirty") is not False:
    sys.exit(f"evidence.sh: the {tier} ci record is not clean and green ({bad or 'dirty tree'})")
try:
    base = git("rev-parse", "origin/main")
except subprocess.CalledProcessError:
    base = git("rev-parse", f"{sha}^")
out = f"{d}/{sha}.json"
if os.path.exists(out):
    sys.exit(f"evidence.sh: {out} already exists (evidence is immutable per attempt)")
json.dump({"sha": sha, "tree": ci["tree"], "base": base, "attempt": 1, "inputs": {"package-lock.json": git("hash-object", "package-lock.json")},
           "checks": ci["checks"], "review": {"verdict": verdict, "by": by, "notes": notes}}, open(out, "w"), indent=2)
print(f"evidence written: {out}")
PY
