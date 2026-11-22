#!/bin/sh
# Public-repo sweep: tracked files and all history must hold no personal data, machine names, addresses or agent residue.
# The owner's name is allowed only in the LICENSE copyright line. Exit 1 on any hit.
set -eu
cd "$(dirname "$0")/.."
PATTERN='/Users/|@gmail|192\.168\.|100\.64\.|co-authored-by|generated with \[claude|anthropic\.com|\bcodex\b|(^|[^-[:alnum:]_])agent' # an HTTP user-agent header is not agent residue
# Private names (machines, hosts, usernames) never live in the tree: one regex alternation per line in the untracked
# file .git/info/sweep-private, or in SWEEP_PRIVATE (a CI secret). Without either, only the generic pattern runs.
private=${SWEEP_PRIVATE:-$(cat "$(git rev-parse --git-common-dir)/info/sweep-private" 2>/dev/null || true)}
private=$(printf '%s\n' "$private" | grep -v '^$' | paste -s -d '|' - || true)
[ -z "$private" ] && echo "sweep: no private name list; generic pattern only" || PATTERN="$PATTERN|$private"
OWNER='Copyright (c) 2026 Martijn Hermans'
# src/suspect.json is detector data: its rules must name what an injection says to an AI (agent,
# assistant), so it is the one source file left out of both greps. test/suspect.test.ts pins the list.
bad=0
hits=$(git grep -I -n -i -E "$PATTERN" -- . ':!package-lock.json' ':!scripts/sweep.sh' ':!src/suspect.json' | grep -v -F "LICENSE:3:$OWNER" || true)
[ -z "$hits" ] || { echo "sweep: tracked files:"; echo "$hits"; bad=1; }
hist=$(git log --all -p --format='%an <%ae>%n%cn <%ce>%n%B' -- . ':!scripts/sweep.sh' ':!src/suspect.json' | grep -i -E "$PATTERN" | grep -v -F "+$OWNER" | sort -u || true)
[ -z "$hist" ] || { echo "sweep: history:"; echo "$hist" | head -20; bad=1; }
mail=$(git log --all --format='%ae%n%ce' | sort -u | grep -v '@users\.noreply\.github\.com$' || true)
[ -z "$mail" ] || { echo "sweep: author or committer email is not a noreply address: $mail"; bad=1; }
[ "$bad" = 0 ] && echo "sweep: clean"
exit "$bad"
