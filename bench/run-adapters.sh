#!/bin/sh
# Run the competitor adapters on any Linux or macOS host that has uv (and Java for tika and opendataloader).
#   sh bench/run-adapters.sh <cache> [candidate ...]
# <cache> is the absolute scratch directory of `npm run bench -- prepare` (input/ and manifest.json exist).
# Each tool gets its own uv environment with the versions pinned in bench/data/environment.json. A tool
# that cannot be installed or started is recorded as not-run with the reason; nothing is skipped silently.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=${1:?usage: run-adapters.sh <cache> [candidate ...]}
shift
case $root in /*) ;; *) echo "cache must be an absolute path" >&2; exit 2;; esac
[ -f "$root/manifest.json" ] && [ -d "$root/input" ] || { echo "run 'npm run bench -- prepare' first" >&2; exit 2; }
command -v uv >/dev/null 2>&1 || { echo "uv is required" >&2; exit 2; }
export UV_CACHE_DIR=${UV_CACHE_DIR:-$root/cache/uv}
export HF_HOME=${HF_HOME:-$root/cache/hf}
export TORCH_HOME=${TORCH_HOME:-$root/cache/torch}
export OMP_NUM_THREADS=${OMP_NUM_THREADS:-4}
export TOKENIZERS_PARALLELISM=false
python=$(python3 -I -c "import json,sys;print(json.load(open(sys.argv[1]))['python'])" "$here/data/environment.json")
[ $# -gt 0 ] || set -- $(python3 -I -c "import json,sys;print(' '.join(k for k in json.load(open(sys.argv[1]))['candidates'] if k!='plainview'))" "$here/data/environment.json")
for candidate in "$@"; do
  venv=$root/venvs/$candidate
  mkdir -p "$root/$candidate"
  reqs=$(python3 -I -c "import json,sys;print('\n'.join(json.load(open(sys.argv[1]))['candidates'][sys.argv[2]].get('requirements',[])))" "$here/data/environment.json" "$candidate")
  if ! { uv venv -q --allow-existing --python "$python" "$venv" && { [ -z "$reqs" ] || printf '%s\n' "$reqs" | uv pip install -q --python "$venv/bin/python" -r -; }; } 2>"$root/$candidate/install.log"; then
    python3 -I -c "import json,sys;print(json.dumps({'reason':'install failed: '+' '.join(open(sys.argv[1]).read()[-300:].split())}))" "$root/$candidate/install.log" >"$root/$candidate/not-run.json"
    echo "$candidate: not-run (install failed)"
    continue
  fi
  "$venv/bin/python" "$here/reference.py" "$candidate" "$root" || echo "$candidate: adapter stopped early"
done
