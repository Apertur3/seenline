#!/bin/sh
# Merge the CI record for the land tier with a review verdict into the evidence file land.sh validates.
# Usage: sh scripts/evidence.sh <sha> <LAND|HOLD|ERROR> "<reviewer>" ["<notes>"]
#        sh scripts/evidence.sh <sha> --file <path>   (file: one line "<VERDICT> <reviewer>[ | <notes>]")
# Run `sh scripts/ci.sh <land_tier>` on a clean checkout of <sha> first. Never edits an existing evidence file.
# Refuses when the ci-<land_tier> record is missing, red, dirty, for another sha or tree, or lacks a
# land_tier check. A reviewer named "orchestrator" or "self" is recorded as an explicit routine self-review.
set -eu
cd "$(dirname "$0")/.."
usage() { echo "usage: evidence.sh <sha> <LAND|HOLD|ERROR> <reviewer> [notes] | evidence.sh <sha> --file <path>"; exit 2; }
[ "$#" -ge 3 ] || usage
sha=$(git rev-parse --verify -q "$1^{commit}") || { echo "evidence.sh: unknown commit $1"; exit 2; }
dir="$(git rev-parse --git-common-dir)/factory/evidence"
[ "$2" != "--file" ] || [ -f "$3" ] || usage
python3 - "$sha" "$dir" "$@" <<'PY'
import json, os, subprocess, sys
sha, d, _, a2, a3, *rest = sys.argv[1:]
if a2 == "--file":
    head, _, notes = open(a3).readline().partition("|")
    parts = (head.split(None, 1) + [""])[:2]
    verdict, by, notes = parts[0], parts[1].strip(), notes.strip()
else:
    verdict, by, notes = a2, a3, (rest[0] if rest else "")
if verdict not in ("LAND", "HOLD", "ERROR") or not by.strip():
    sys.exit("evidence.sh: need a verdict of LAND, HOLD or ERROR and a reviewer name")
if by.strip().lower().split()[0] in ("orchestrator", "self"):
    by = "orchestrator self-review (routine, not independent)"
def git(*a):
    return subprocess.run(["git", *a], capture_output=True, text=True, check=True).stdout.strip()
try:
    cfg = json.loads(git("show", f"{sha}:factory.json"))
    tier = cfg["land_tier"]
    want = cfg["tiers"][tier]
    ci = json.load(open(f"{d}/{sha}.ci-{tier}.json"))
    done = {c["name"]: c["status"] for c in ci["checks"]}
except (OSError, ValueError, KeyError, TypeError, subprocess.CalledProcessError) as x:
    sys.exit(f"evidence.sh: cannot read the {sha[:12]} land_tier or its ci record ({x!r}); run scripts/ci.sh first")
tree = git("rev-parse", f"{sha}^{{tree}}")
if ci.get("sha") != sha or ci.get("tree") != tree:
    sys.exit(f"evidence.sh: the ci-{tier} record is for another sha or tree")
if ci.get("dirty") is not False:
    sys.exit(f"evidence.sh: the ci-{tier} record ran on a dirty tree")
bad = sorted(n for n in done if done[n] != "pass")
if bad:
    sys.exit(f"evidence.sh: the ci-{tier} record is red ({', '.join(bad)})")
missing = sorted(set(want) - set(done))
if missing:
    sys.exit(f"evidence.sh: the ci-{tier} record lacks land_tier checks: {', '.join(missing)}")
for ref in ("origin/main", f"{sha}^", sha):
    try:
        base = git("rev-parse", ref)
        break
    except subprocess.CalledProcessError:
        pass
inputs = {}
for f in ("package-lock.json", "Cargo.lock", "uv.lock", "poetry.lock", "go.sum"):
    try:
        inputs[f] = git("rev-parse", f"{sha}:{f}")
    except subprocess.CalledProcessError:
        pass
out = f"{d}/{sha}.json"
if os.path.exists(out):
    sys.exit(f"evidence.sh: {out} already exists (evidence is immutable per attempt)")
json.dump({"sha": sha, "tree": tree, "base": base, "attempt": 1, "inputs": inputs, "checks": ci["checks"],
           "review": {"verdict": verdict, "by": by, "notes": notes}}, open(out, "w"), indent=2)
print(f"evidence written: {out}")
PY
