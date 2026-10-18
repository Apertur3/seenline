#!/bin/sh
# The one gate entry point: sh scripts/ci.sh <fast|candidate|integration|full|release>
# Runs the checks factory.json lists for the tier, all of them, then reports.
# RED on: an unknown or empty tier, a check that is not defined or has no command (TODO),
# a missing tool, the wrong platform, a failing check, a timeout. Skipping is never green;
# only a check marked "required": false may skip, and it says so.
# On a git checkout it writes a ci record to <git-common-dir>/factory/evidence/<sha>.ci-<tier>.json.
# HEAD, its tree and `git status --porcelain` are captured before the checks; if any changed by
# the end, the run is RED and no record is written (the checks did not test that commit).
set -eu
cd "$(dirname "$0")/.."
tier="${1:-fast}"
command -v python3 >/dev/null 2>&1 || { echo "RED: python3 is missing; the kit needs it"; exit 1; }
US=$(printf '\037')

# Kit copy stamp: KIT_VERSION (the kit's) vs factory.json kit_version (the project's). Warn; red on a major mismatch.
if [ -f KIT_VERSION ]; then
	python3 - <<'PY' || exit 1
import json
kit = open("KIT_VERSION").read().strip()
want = str(json.load(open("factory.json")).get("kit_version", ""))
if want and want != kit:
    print(f"WARN: kit copy is stale: v{kit} vs v{want} (KIT_VERSION vs factory.json kit_version)")
    if want.split(".")[0] != kit.split(".")[0]:
        raise SystemExit("RED: kit major version differs; re-copy the kit template")
PY
fi

plan=$(python3 - "$tier" "$US" <<'PY'
import json, sys
tier, sep = sys.argv[1], sys.argv[2]
f = json.load(open("factory.json"))
names = f["tiers"].get(tier)
if not names:
    sys.exit(f"RED: tier '{tier}' is unknown or empty in factory.json")
for n in names:
    c = f["checks"].get(n)
    if c is None:
        sys.exit(f"RED: tier '{tier}' lists check '{n}', which factory.json does not define")
    plat = f.get("platforms", {}).get(c.get("platform", ""), {})
    if c.get("platform") and not plat:
        sys.exit(f"RED: check '{n}' names platform '{c['platform']}', which factory.json does not define")
    tools = c.get("tools", []) + plat.get("tools", [])
    print(sep.join([n, str(c.get("timeout", 600)), " ".join(tools), plat.get("uname", ""),
                    "yes" if c.get("required", True) else "no", c.get("cmd") or ""]))
PY
)

snapshot() {
	git rev-parse HEAD HEAD^{tree} 2>/dev/null && git status --porcelain 2>/dev/null
}
before=$(snapshot) || before=""

red=0
results=""
while IFS="$US" read -r name timeout tools uname required cmd; do
	why=""
	if [ -z "$cmd" ] || [ "$cmd" = "TODO" ]; then
		why="no command configured in factory.json"
	elif [ -n "$uname" ] && [ "$(uname -s)" != "$uname" ]; then
		why="needs platform $uname, this runner is $(uname -s)"
	else
		for t in $tools; do
			command -v "$t" >/dev/null 2>&1 || why="${why:-missing tool(s):} $t"
		done
	fi
	if [ -n "$why" ]; then
		if [ "$required" = "no" ]; then
			echo "SKIP $name (optional): $why"
			results="$results$name skip 0
"
		else
			echo "RED $name: $why"
			red=1
			results="$results$name red 0
"
		fi
		continue
	fi
	echo "== $name: $cmd"
	start=$(date +%s)
	if python3 - "$timeout" "$cmd" <<'PY'
import os, signal, subprocess, sys
p = subprocess.Popen(["sh", "-c", sys.argv[2]], start_new_session=True, stdin=subprocess.DEVNULL)
try:
    sys.exit(p.wait(timeout=float(sys.argv[1])))
except subprocess.TimeoutExpired:
    os.killpg(p.pid, signal.SIGKILL)
    sys.exit(f"timed out after {sys.argv[1]}s")
PY
	then status=pass; else status=fail; red=1; echo "RED $name: failed"; fi
	results="$results$name $status $(($(date +%s) - start))
"
done <<EOF
$plan
EOF

if [ "$(snapshot)" != "$before" ]; then
	echo "RED: HEAD, its tree or the working tree changed during the run; no ci record written"
	red=1
elif [ -n "$before" ]; then
	dir="$(git rev-parse --git-common-dir)/factory/evidence"
	mkdir -p "$dir"
	sha=$(git rev-parse HEAD)
	dirty=false
	[ "$(printf '%s\n' "$before" | sed -n '3,$p')" = "" ] || dirty=true
	printf '%s' "$results" | python3 -c '
import json, sys
sha, tree, tier, dirty, path = sys.argv[1:]
checks = [{"name": n, "status": s, "seconds": int(t)} for n, s, t in (l.split() for l in sys.stdin.read().splitlines())]
json.dump({"sha": sha, "tree": tree, "tier": tier, "dirty": dirty == "true", "checks": checks},
          open(path, "w"), indent=2)
' "$sha" "$(git rev-parse HEAD^{tree})" "$tier" "$dirty" "$dir/$sha.ci-$tier.json"
fi

if [ "$red" = 0 ]; then echo "GREEN: tier $tier"; else echo "RED: tier $tier"; exit 1; fi
