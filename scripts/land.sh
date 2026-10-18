#!/bin/sh
# Landing adapter. STUB: 'validate' works; 'land' is for the project to wire to its queue.
#
# Evidence contract. One immutable file per attempt at
#   <git-common-dir>/factory/evidence/<sha>.json   (inside .git, so it is never committed)
#   {
#     "sha": "<candidate commit>",  "tree": "<its tree>",  "base": "<base commit>",
#     "attempt": 1,
#     "inputs": {"<lockfile or model>": "<fingerprint>"},
#     "checks": [{"name": "size", "status": "pass", "seconds": 3, "log": "<path>"}],
#     "review": {"verdict": "LAND" | "HOLD" | "ERROR", "by": "<reviewer>", "notes": "..."}
#   }
# ci.sh writes the per-tier check records (<sha>.ci-<tier>.json); the lane driver merges them
# with the review verdict into <sha>.json. Valid means: sha and tree match the commit (stale
# evidence fails), the named base is an ancestor of sha, at least one check ran and every check
# passed, the review verdict is LAND, and <sha>.ci-<land_tier>.json (land_tier from the commit's
# factory.json) matches sha and tree, was clean (dirty false) and passed every check of that
# tier. Malformed evidence or review output is a protocol failure: red.
#
#   sh scripts/land.sh validate <sha> [<remote-sha>]   exit 0 when the evidence is valid; with a
#       remote sha (the pre-push hook passes it) it must be all zeros or an ancestor of sha
#   sh scripts/land.sh land <sha>       validate, land through the queue, confirm the remote head
set -eu
cd "$(dirname "$0")/.."
cmd="${1:-}"
sha="${2:-}"
[ -n "$sha" ] || { echo "usage: land.sh validate|land <sha>"; exit 2; }
sha=$(git rev-parse --verify -q "$sha^{commit}") || { echo "land.sh: unknown commit $2"; exit 2; }

validate() {
	python3 - "$sha" "$(git rev-parse "$sha^{tree}")" "$(git rev-parse --git-common-dir)/factory/evidence" "${3:-}" <<'PY'
import json, subprocess, sys
sha, tree, evdir, remote = sys.argv[1:]
def red(msg):
    sys.exit(f"evidence {sha[:12]}: {msg}")
def ancestor(a, b):
    return subprocess.run(["git", "merge-base", "--is-ancestor", a, b], capture_output=True).returncode == 0
def load(path):
    try:
        e = json.load(open(path))
    except FileNotFoundError:
        red(f"missing {path}")
    except ValueError as x:
        red(f"malformed JSON in {path} ({x})")
    if not isinstance(e, dict):
        red(f"{path} is not a JSON object")
    if e.get("sha") != sha:
        red(f"sha {e.get('sha')} in {path} does not match the commit")
    if e.get("tree") != tree:
        red(f"tree in {path} does not match the commit (stale evidence)")
    checks = e.get("checks")
    if not isinstance(checks, list) or not checks:
        red(f"no executed checks in {path}")
    bad = [c.get("name", "?") if isinstance(c, dict) else "?" for c in checks
           if not isinstance(c, dict) or c.get("status") != "pass"]
    if bad:
        red(f"checks not passing in {path}: {', '.join(map(str, bad))}")
    return e
if remote and remote.strip("0") and not ancestor(remote, sha):
    red(f"remote head {remote[:12]} is not an ancestor of {sha[:12]} (refusing a rewind; fetch and rebase)")
try:
    cfg = json.loads(subprocess.run(["git", "show", f"{sha}:factory.json"], capture_output=True,
                                    check=True).stdout)
    tier = cfg["land_tier"]
    want = cfg["tiers"][tier]
except (subprocess.CalledProcessError, ValueError, KeyError, TypeError) as x:
    red(f"cannot read land_tier and its checks from {sha[:12]}:factory.json ({x!r})")
if not isinstance(want, list) or not want:
    red(f"land_tier '{tier}' lists no checks")
ci = load(f"{evdir}/{sha}.ci-{tier}.json")
if ci.get("dirty") is not False:
    red(f"ci record for tier {tier} ran on a dirty tree")
missing = sorted(set(want) - {c["name"] for c in ci["checks"] if isinstance(c.get("name"), str)})
if missing:
    red(f"ci record for tier {tier} is missing checks: {', '.join(missing)}")
e = load(f"{evdir}/{sha}.json")
base = e.get("base")
if not isinstance(base, str) or not base or not ancestor(base, sha):
    red(f"base {base!r} is not an ancestor of the commit")
review = e.get("review")
if not isinstance(review, dict) or review.get("verdict") not in ("LAND", "HOLD", "ERROR"):
    red("malformed review verdict (protocol failure)")
if review["verdict"] != "LAND":
    red(f"review verdict is {review['verdict']}")
print(f"evidence {sha[:12]}: valid")
PY
}

case "$cmd" in
validate) validate "$@" ;;
land)
	validate "$@"
	echo "land.sh land: STUB. Wire this to the project's queue: enqueue $sha, wait, then confirm"
	echo "the remote default branch head equals $sha. Until then, nothing landed."
	exit 2
	;;
*) echo "usage: land.sh validate|land <sha>"; exit 2 ;;
esac
