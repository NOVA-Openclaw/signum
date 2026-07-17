#!/usr/bin/env bash
#
# run-and-deploy.sh — deterministic aggregator run + validate + deploy.
#
# Runs the signum aggregator once, validates the generated signatures.json
# (schema keys present, counts coherent, signature count has not shrunk vs
# the last deployed copy), and only on validation success copies it to the
# deploy target and runs an optional deploy command. On any failure the
# last-good deployed file is left untouched and the script exits nonzero.
#
# Designed for cron (see docs/scheduled-aggregator-runs.md). All output is
# timestamped; point cron's stdout/stderr at a logfile.
#
# Usage:
#   run-and-deploy.sh -c <config.json> [-t <deploy_target>] [-d <deploy_cmd>]
#
#   -c  aggregator config (required; passed as SIGNUM_CONFIG)
#   -t  local deploy target path for the validated signatures.json
#       (also used as the "previous" file for regression checks)
#   -d  shell command to run after the copy (e.g. targeted rsync to the
#       web host). Only runs when validation and copy succeed.
#
# Environment fallbacks: SIGNUM_CONFIG, SIGNUM_DEPLOY_TARGET, SIGNUM_DEPLOY_CMD
#
# Exit codes: 0 success, 1 usage/config error, 2 aggregator run failed,
#             3 validation failed, 4 deploy failed.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGG_DIR="$(dirname "$SCRIPT_DIR")"

CONFIG="${SIGNUM_CONFIG:-}"
DEPLOY_TARGET="${SIGNUM_DEPLOY_TARGET:-}"
DEPLOY_CMD="${SIGNUM_DEPLOY_CMD:-}"
RUN_TIMEOUT="${SIGNUM_RUN_TIMEOUT:-600}"

while getopts "c:t:d:h" opt; do
  case "$opt" in
    c) CONFIG="$OPTARG" ;;
    t) DEPLOY_TARGET="$OPTARG" ;;
    d) DEPLOY_CMD="$OPTARG" ;;
    h) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "usage: $0 -c <config.json> [-t <deploy_target>] [-d <deploy_cmd>]" >&2; exit 1 ;;
  esac
done

log() { echo "$(date -u +'%Y-%m-%dT%H:%M:%SZ') [run-and-deploy] $*"; }
fail() { log "FAIL: $1"; exit "$2"; }

[ -n "$CONFIG" ] || fail "no config given (-c or SIGNUM_CONFIG)" 1
CONFIG="$(cd "$(dirname "$CONFIG")" && pwd)/$(basename "$CONFIG")" || fail "config path unresolvable" 1
[ -f "$CONFIG" ] || fail "config not found: $CONFIG" 1
command -v node >/dev/null || fail "node not on PATH" 1

# Prevent overlapping runs (cron cadence < run duration).
LOCK_FILE="${TMPDIR:-/tmp}/signum-aggregator-$(basename "$CONFIG").lock"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "another run holds $LOCK_FILE; skipping"
  exit 0
fi

cd "$AGG_DIR" || fail "cannot cd to $AGG_DIR" 1

# Resolve the output path from the config so we validate what the run wrote.
OUTPUT_PATH="$(node -e "
  const c = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
  const p = c.output && c.output.path ? c.output.path : './output/signatures.json';
  console.log(require('path').resolve(p));
" "$CONFIG")" || fail "cannot parse output.path from $CONFIG" 1

log "starting: config=$CONFIG output=$OUTPUT_PATH"

# 1. Run the aggregator once.
if ! SIGNUM_CONFIG="$CONFIG" timeout "$RUN_TIMEOUT" node src/index.js --once; then
  fail "aggregator run failed or timed out (${RUN_TIMEOUT}s); last-good deploy untouched" 2
fi
[ -f "$OUTPUT_PATH" ] || fail "aggregator reported success but $OUTPUT_PATH missing" 2

# 2. Validate against the last deployed copy (if any).
if ! node src/validate-output.js "$OUTPUT_PATH" ${DEPLOY_TARGET:+"$DEPLOY_TARGET"}; then
  fail "validation failed; last-good deploy untouched" 3
fi

# 3. Deploy.
if [ -n "$DEPLOY_TARGET" ]; then
  mkdir -p "$(dirname "$DEPLOY_TARGET")" || fail "cannot create deploy target dir" 4
  TMP_TARGET="${DEPLOY_TARGET}.tmp.$$"
  if cp "$OUTPUT_PATH" "$TMP_TARGET" && mv "$TMP_TARGET" "$DEPLOY_TARGET"; then
    log "deployed to $DEPLOY_TARGET"
  else
    rm -f "$TMP_TARGET"
    fail "copy to $DEPLOY_TARGET failed" 4
  fi
fi

if [ -n "$DEPLOY_CMD" ]; then
  if bash -c "$DEPLOY_CMD"; then
    log "deploy command succeeded"
  else
    fail "deploy command failed: $DEPLOY_CMD" 4
  fi
fi

log "done"
