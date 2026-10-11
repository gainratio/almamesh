#!/usr/bin/env bash
# PR 3 mutation red runs: the Change-then-Back race and the 401 real-fetch gap.
#
# Each row: prove the named test is green on the real code, apply the mutation,
# prove it applied (file differs, marker exactly once), run the test and require
# a non-zero exit with at least one FAILED test in the runner's JSON report (a
# crash is not a red), then restore. Ends by requiring clean sources and no
# leftover markers in src. Verdicts come from exit codes and JSON reports.
#
# Rows 1-2 are Vitest. Row 3 builds the mutated app and runs the Playwright
# egress spec's real-401 journey against it (Chromium, ~2 min).
#
# Run from anywhere:  frontend/apps/web/scripts/mutations/pr3-time-travel-race.sh
# shellcheck disable=SC2016 # perl expressions are single-quoted on purpose
set -euo pipefail

WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$WEB_DIR"

TRAVEL=src/lib/timeTravel.ts
ERRORS=src/lib/errors.ts
UNIT=src/lib/__tests__/timeTravel.test.ts
HOOK=src/hooks/__tests__/useChatThread.timeTravel.test.tsx
E2E_CONFIG=playwright.ai-setup-panel.egress.config.ts
E2E_NAME='a 401 on the first-ever connect leaves AI off'
MARKERS=(MUTATION_NO_INTENT_CHECK MUTATION_SUPERSEDED_KEEPS_THREAD MUTATION_401_AS_NETWORK)
PORT=4233
REPORTS="$(mktemp -d)"
PREVIEW_PID=""

if ! git diff --quiet -- "$TRAVEL" "$ERRORS" "$UNIT" "$HOOK"; then
  echo "refusing: $TRAVEL, $ERRORS or their tests have uncommitted changes" >&2
  exit 1
fi

cleanup() {
  git checkout -- "$TRAVEL" "$ERRORS"
  [ -z "$PREVIEW_PID" ] || kill "$PREVIEW_PID" 2>/dev/null || true
  rm -rf "$REPORTS" dist-mutant
}
trap cleanup EXIT
trap 'exit 130' INT TERM

fail() { echo "FAIL $1" >&2; exit 1; }
count() { node -e 'const r = require(process.argv[1]); process.stdout.write(String(r[process.argv[2]] ?? 0))' "$1" "$2"; }

# vitest_named FILE NAME REPORT -> vitest's exit code
vitest_named() {
  local code=0 pattern
  pattern="$(printf '%s' "$2" | sed 's/[][\.*^$()+?{}|]/\\&/g')"
  rm -f "$3"
  perl -e 'alarm 180; exec @ARGV' bunx vitest run "$1" -t "$pattern" --reporter=json --outputFile="$3" >/dev/null 2>&1 || code=$?
  return "$code"
}

apply() { # FILE MARKER PERL_EXPR
  local before after
  before="$(git hash-object "$1")"
  perl -0pi -e "$3" "$1"
  after="$(git hash-object "$1")"
  [ "$before" != "$after" ] || fail "$2: the mutation did not apply (file unchanged)"
  [ "$(grep -c "$2" "$1")" -eq 1 ] || fail "$2: the mutation did not apply exactly once"
}

# unit_row LABEL MARKER FILE PERL_EXPR TEST_FILE TEST_NAME
unit_row() {
  local label="$1" marker="$2" file="$3" expr="$4" tfile="$5" name="$6"
  local base="$REPORTS/$marker.$(basename "$tfile").base.json" mut="$REPORTS/$marker.$(basename "$tfile").mut.json" code=0
  vitest_named "$tfile" "$name" "$base" || fail "$label: '$name' is not green on the real code"
  [ "$(count "$base" numPassedTests)" -ge 1 ] || fail "$label: '$name' matched no test"
  apply "$file" "$marker" "$expr"
  vitest_named "$tfile" "$name" "$mut" || code=$?
  [ "$code" -ne 0 ] || fail "$label: '$name' stayed GREEN under the mutation"
  [ -f "$mut" ] || fail "$label: the run crashed (exit $code) and wrote no report"
  [ "$(count "$mut" numFailedTests)" -ge 1 ] || fail "$label: the run errored (exit $code) without a failing test"
  git checkout -- "$file"
  printf '| %s | %s | %s | %s | %s |\n' "$label" "$marker" "$name" "$code" "$(count "$mut" numFailedTests)"
}

# e2e_run -> Playwright's exit code against a fresh build of the CURRENT sources.
e2e_run() {
  local report="$1" code=0
  [ -z "$PREVIEW_PID" ] || { kill "$PREVIEW_PID" 2>/dev/null || true; PREVIEW_PID=""; }
  rm -rf dist-mutant "$report"
  VITE_API_URL= VITE_EXIT_GATE_HOOKS=1 bunx vite build --outDir dist-mutant >/dev/null 2>&1 || fail "build failed"
  bunx vite preview --outDir dist-mutant --host 127.0.0.1 --port "$PORT" --strictPort >/dev/null 2>&1 &
  PREVIEW_PID=$!
  for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/" >/dev/null && break; sleep 1; done
  AI_PANEL_EGRESS_E2E_BASE_URL="http://127.0.0.1:$PORT" PLAYWRIGHT_JSON_OUTPUT_NAME="$report" \
    perl -e 'alarm 420; exec @ARGV' bunx playwright test --config="$E2E_CONFIG" -g "$E2E_NAME" --reporter=json >/dev/null 2>&1 || code=$?
  return "$code"
}

echo '| Mutation | Marker | Test that went red | Exit | Failed |'
echo '| --- | --- | --- | --- | --- |'

unit_row "remove the intent-token check (Change)" MUTATION_NO_INTENT_CHECK "$TRAVEL" \
  's{  if \(!isLatest\(\)\) return SUPERSEDED;\n(  useTimeTravelStore\.getState\(\)\.setMoment\(target\.profileId, request\.asOf\);)}{  /* MUTATION_NO_INTENT_CHECK */\n$1}' \
  "$UNIT" "Change then Back: the slow Change save lands last and moves nothing"

unit_row "remove the intent-token check (Change), hook level" MUTATION_NO_INTENT_CHECK "$TRAVEL" \
  's{  if \(!isLatest\(\)\) return SUPERSEDED;\n(  useTimeTravelStore\.getState\(\)\.setMoment\(target\.profileId, request\.asOf\);)}{  /* MUTATION_NO_INTENT_CHECK */\n$1}' \
  "$HOOK" "ends on today: no moment, the today thread selected, no banner"

unit_row "a superseded call still hands back its thread to select" MUTATION_SUPERSEDED_KEEPS_THREAD "$TRAVEL" \
  's{  if \(!isLatest\(\)\) return SUPERSEDED;\n(  useTimeTravelStore\.getState\(\)\.setMoment\(target\.profileId, request\.asOf\);)}{  if (!isLatest()) return { threadId }; /* MUTATION_SUPERSEDED_KEEPS_THREAD */\n$1}' \
  "$UNIT" "Change then Back: the slow Change save lands last and moves nothing"

unit_row "a superseded call still hands back its thread to select, hook level" MUTATION_SUPERSEDED_KEEPS_THREAD "$TRAVEL" \
  's{  if \(!isLatest\(\)\) return SUPERSEDED;\n(  useTimeTravelStore\.getState\(\)\.setMoment\(target\.profileId, request\.asOf\);)}{  if (!isLatest()) return { threadId }; /* MUTATION_SUPERSEDED_KEEPS_THREAD */\n$1}' \
  "$HOOK" "ends on today: no moment, the today thread selected, no banner"

# Row 3: a real HTTP 401 must classify as a rejected key, not a network error.
BASE="$REPORTS/e2e-base.json" MUT="$REPORTS/e2e-mut.json"
e2e_run "$BASE" || fail "classifyConnectionError row: the real-401 journey is not green on the real code"
node -e 'const r=require(process.argv[1]); if (!(r.stats.expected>=1 && r.stats.unexpected===0)) process.exit(1)' "$BASE" \
  || fail "classifyConnectionError row: the baseline report shows no passing test"
apply "$ERRORS" MUTATION_401_AS_NETWORK \
  's{(export function classifyConnectionError\(err: unknown\): ConnectionErrorKind \{\n)}{$1  if ((err as \{ status?: number \} \| null)?.status === 401) return \x27network\x27; /* MUTATION_401_AS_NETWORK */\n}'
code=0
e2e_run "$MUT" || code=$?
[ "$code" -ne 0 ] || fail "401-as-network: the real-401 journey stayed GREEN under the mutation"
[ -f "$MUT" ] || fail "401-as-network: the run crashed (exit $code) and wrote no report"
FAILED="$(node -e 'const r=require(process.argv[1]); process.stdout.write(String(r.stats.unexpected))' "$MUT")"
[ "$FAILED" -ge 1 ] || fail "401-as-network: errored (exit $code) without a failing test"
git checkout -- "$ERRORS"
printf '| %s | %s | %s | %s | %s |\n' "a real 401 classified as a network error" MUTATION_401_AS_NETWORK "$E2E_NAME" "$code" "$FAILED"

git diff --quiet -- "$TRAVEL" "$ERRORS" || fail "$TRAVEL or $ERRORS is not clean after restore"
for marker in "${MARKERS[@]}"; do
  if grep -rq "$marker" src; then fail "$marker left in src"; fi
done
echo "all 5 mutations went RED; source restored and clean"
