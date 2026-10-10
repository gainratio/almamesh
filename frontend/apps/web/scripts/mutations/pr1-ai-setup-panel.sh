#!/usr/bin/env bash
# PR 1 mutation red runs for the shared AiSetupPanel.
#
# For each mutation: prove the named test exists and is green on the real code,
# apply the mutation, prove it applied (the file differs and the marker is there
# exactly once), run the test and require a non-zero exit with at least one
# FAILED test in Vitest's JSON report (a crash is not a red), then restore.
# Ends by requiring a clean source file and no leftover markers anywhere in src.
# Verdicts come from exit codes and the JSON report, never from grepped prose.
#
# Run from anywhere:  frontend/apps/web/scripts/mutations/pr1-ai-setup-panel.sh
# shellcheck disable=SC2016 # perl expressions are single-quoted on purpose: $1 is perl's, not the shell's
set -euo pipefail

WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$WEB_DIR"

PANEL=src/components/features/ai/AiSetupPanel.tsx
TEST=src/components/features/ai/AiSetupPanel.test.tsx
MARKERS=(
  MUTATION_EARLY_CONNECTED MUTATION_NO_FLUSH_AWAIT MUTATION_SKIP_FLUSH
  MUTATION_PROBEGEN MUTATION_POSTFLUSH_GUARD MUTATION_HIDE_DISCLOSURE
  MUTATION_HIDE_WARNING MUTATION_POSTFLUSH_CATCH MUTATION_NO_UNMOUNT_CLEANUP
  MUTATION_OFF_RESOLVE_GUARD MUTATION_OFF_REJECT_GUARD MUTATION_REPLACE_NO_BUMP
  MUTATION_OFF_NO_BUMP MUTATION_OFF_STORAGE_CATCH MUTATION_FAILED_PROBE_GUARD
)
REPORTS="$(mktemp -d)"

if ! git diff --quiet -- "$PANEL" "$TEST"; then
  echo "refusing: $PANEL or $TEST has uncommitted changes" >&2
  exit 1
fi

# Installed only after the dirty check, so a refusal never wipes the caller's edits.
trap 'git checkout -- "$PANEL"; rm -rf "$REPORTS"' EXIT
trap 'exit 130' INT TERM
ROW=0

# run_named NAME REPORT -> returns Vitest's exit code. NAME is matched as a
# regex by -t, so metacharacters are escaped to keep it a literal substring.
run_named() {
  local code=0 pattern
  pattern="$(printf '%s' "$1" | sed 's/[][\.*^$()+?{}|]/\\&/g')"
  rm -f "$2" # a crash must never be judged from a stale report
  # perl alarm is the portable timeout (no GNU timeout on macOS): SIGALRM kills a hung run.
  perl -e 'alarm 180; exec @ARGV' bunx vitest run "$TEST" -t "$pattern" --reporter=json --outputFile="$2" >/dev/null 2>&1 || code=$?
  return "$code"
}

# count REPORT FIELD -> prints a number from Vitest's JSON report
count() {
  node -e 'const r = require(process.argv[1]); process.stdout.write(String(r[process.argv[2]] ?? 0))' "$1" "$2"
}

restore_and_fail() {
  git checkout -- "$PANEL"
  echo "FAIL $1" >&2
  exit 1
}

# expect_red LABEL MARKER PERL_EXPR TEST_NAME
expect_red() {
  local label="$1" marker="$2" expr="$3" name="$4"
  ROW=$((ROW + 1))
  local base="$REPORTS/row$ROW.base.json" mut="$REPORTS/row$ROW.mut.json"
  local before_hash after_hash

  run_named "$name" "$base" || restore_and_fail "$label: '$name' is not green on the real code"
  [ -f "$base" ] || restore_and_fail "$label: no report written for the baseline run"
  [ "$(count "$base" numPassedTests)" -ge 1 ] || restore_and_fail "$label: '$name' matched no test"

  before_hash="$(git hash-object "$PANEL")"
  perl -0pi -e "$expr" "$PANEL"
  after_hash="$(git hash-object "$PANEL")"
  [ "$before_hash" != "$after_hash" ] || restore_and_fail "$label: the mutation did not apply (file unchanged)"
  [ "$(grep -c "$marker" "$PANEL")" -eq 1 ] || restore_and_fail "$label: the mutation did not apply exactly once"

  local code=0
  run_named "$name" "$mut" || code=$?
  [ "$code" -ne 0 ] || restore_and_fail "$label: '$name' stayed GREEN under the mutation"
  [ -f "$mut" ] || restore_and_fail "$label: the run crashed (exit $code) and wrote no report"
  local failed
  failed="$(count "$mut" numFailedTests)"
  [ "$failed" -ge 1 ] || restore_and_fail "$label: the run errored (exit $code) without a failing test"

  git checkout -- "$PANEL"
  printf '| %s | %s | %s | %s | %s |\n' "$label" "$marker" "$name" "$code" "$failed"
}

echo '| Mutation | Marker | Test that went red | Exit | Failed |'
echo '| --- | --- | --- | --- | --- |'

expect_red "onConnected before the probe resolves" MUTATION_EARLY_CONNECTED \
  's{(\n    setConn\(\{ phase: \x27testing\x27, source \}\);)}{\n    onConnected?.(describeLlmStatus(persisted)); /* MUTATION_EARLY_CONNECTED */$1}' \
  "does not report connected on a failed probe"

expect_red "do not await flushSettings before probing" MUTATION_NO_FLUSH_AWAIT \
  's{(writeLlmSettings\(\{ \.\.\.next, engine: \x27\x27 \}\);\s+)await flushSettings\(\);}{${1}void flushSettings(); /* MUTATION_NO_FLUSH_AWAIT */}' \
  "reports connected only after the settings are durable"

expect_red "skip flushSettings entirely" MUTATION_SKIP_FLUSH \
  's{(writeLlmSettings\(\{ \.\.\.next, engine: \x27\x27 \}\);\s+)await flushSettings\(\);}{${1}/* MUTATION_SKIP_FLUSH */}' \
  "does not report connected when the settings write fails"

expect_red "skip the probeGen check on the probe result" MUTATION_PROBEGEN \
  's{(for a config that is gone\.\n\s*)if \(gen !== probeGen\.current\) \{}{${1}if (false /* MUTATION_PROBEGEN */) \{}' \
  "does not report connected when a newer save superseded the probe"

expect_red "skip the probeGen check on the probe result (edit mid-test)" MUTATION_PROBEGEN \
  's{(for a config that is gone\.\n\s*)if \(gen !== probeGen\.current\) \{}{${1}if (false /* MUTATION_PROBEGEN */) \{}' \
  "ignores a stale probe result after the config is edited mid-test"

expect_red "drop the post-flush supersede guard" MUTATION_POSTFLUSH_GUARD \
  's{(the verdict that the newer save now owns\.\n\s*)if \(gen !== probeGen\.current\) \{}{${1}if (false /* MUTATION_POSTFLUSH_GUARD */) \{}' \
  "keeps the newer Connected verdict when a superseded save flushes late"

expect_red "drop the supersede guard in the flush catch" MUTATION_POSTFLUSH_CATCH \
  's{(a late failure must not paint over it\.\n\s*)if \(gen !== probeGen\.current\) \{}{${1}if (false /* MUTATION_POSTFLUSH_CATCH */) \{}' \
  "keeps the newer Connected verdict when a superseded save rejects late"

expect_red "hide the disclosure when showOffChoice is false" MUTATION_HIDE_DISCLOSURE \
  's{\{t\(\x27tiers\.cloud_body\x27\)\}}{\{showOffChoice ? t(\x27tiers.cloud_body\x27) : null /* MUTATION_HIDE_DISCLOSURE */\}}' \
  "shows the AI disclosure in the onboarding variant"

expect_red "hide the refusal warning when showOffChoice is false" MUTATION_HIDE_WARNING \
  's{\{willRefuse && \(}{\{willRefuse \&\& showOffChoice /* MUTATION_HIDE_WARNING */ \&\& \(}' \
  "keeps the local-only refusal warning in the onboarding variant"

expect_red "no unmount cleanup (probe outlives the screen)" MUTATION_NO_UNMOUNT_CLEANUP \
  's{gens\.current \+= 1; // unmount supersedes the probe\n\s*aborts\.current\?\.abort\(\);}{/* MUTATION_NO_UNMOUNT_CLEANUP */}' \
  "does not report connected after unmount, and aborts the in-flight probe"

expect_red "turnAiOff ignores its own gen on a late flush resolve" MUTATION_OFF_RESOLVE_GUARD \
  's{(the verdict to whoever superseded this turn-off\.\n\s*)if \(offGen !== probeGen\.current\) \{}{${1}if (false /* MUTATION_OFF_RESOLVE_GUARD */) \{}' \
  "keeps the newer Connected verdict when a superseded Turn-AI-off flushes late"

expect_red "turnAiOff ignores its own gen on a late flush reject" MUTATION_OFF_REJECT_GUARD \
  's{(a late off-failure must not paint over it\.\n\s*)if \(offGen !== probeGen\.current\) \{}{${1}if (false /* MUTATION_OFF_REJECT_GUARD */) \{}' \
  "keeps the newer Connected verdict when a superseded Turn-AI-off rejects late"

expect_red "remote Replace no longer bumps probeGen (M6)" MUTATION_REPLACE_NO_BUMP \
  's{(event\.detail\?\.replace !== true\) return;\n\s*)probeGen\.current \+= 1;}{${1}/* MUTATION_REPLACE_NO_BUMP */}' \
  "does not report connected when a remote Replace lands mid-probe"

expect_red "turnAiOff no longer bumps probeGen (M9)" MUTATION_OFF_NO_BUMP \
  's{const offGen = \(probeGen\.current \+= 1\);}{const offGen = probeGen.current; /* MUTATION_OFF_NO_BUMP */}' \
  "does not report connected when AI is turned off mid-probe"

expect_red "turnAiOff storage catch swallows the failure" MUTATION_OFF_STORAGE_CATCH \
  's{setConn\(\{ phase: \x27error\x27, source: \x27guided\x27, kind: \x27storage\x27 \}\);}{/* MUTATION_OFF_STORAGE_CATCH */}' \
  "shows a storage error, and keeps AI on, when turning AI off cannot be saved"

expect_red "drop the supersede guard on a FAILED probe" MUTATION_FAILED_PROBE_GUARD \
  's{(current verdict; ignore its result\.\n\s*)if \(gen !== probeGen\.current\) \{}{${1}if (false /* MUTATION_FAILED_PROBE_GUARD */) \{}' \
  "ignores a superseded probe that FAILS late"

# Restored: the source is clean and no marker survives anywhere in src.
git diff --quiet -- "$PANEL" || { echo "FAIL: $PANEL is not clean after restore" >&2; exit 1; }
for marker in "${MARKERS[@]}"; do
  if grep -rq "$marker" src; then
    echo "FAIL: $marker left in src" >&2
    exit 1
  fi
done
echo "all 16 mutations went RED; source restored and clean"
