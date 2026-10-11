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
DURABILITY=src/components/features/ai/aiSettingsDurability.ts
TEST=src/components/features/ai/AiSetupPanel.test.tsx
MARKERS=(
  MUTATION_EARLY_CONNECTED MUTATION_NO_FLUSH_AWAIT MUTATION_SKIP_FLUSH
  MUTATION_PROBEGEN MUTATION_POSTFLUSH_GUARD MUTATION_HIDE_DISCLOSURE
  MUTATION_HIDE_WARNING MUTATION_POSTFLUSH_CATCH MUTATION_UNMOUNT_NO_BUMP MUTATION_UNMOUNT_NO_ABORT
  MUTATION_OFF_RESOLVE_GUARD MUTATION_OFF_REJECT_GUARD MUTATION_REPLACE_NO_BUMP
  MUTATION_OFF_NO_BUMP MUTATION_OFF_STORAGE_CATCH MUTATION_FAILED_PROBE_GUARD
  MUTATION_OFF_NO_REFRESH MUTATION_ONCONNECTED_UNGUARDED MUTATION_ONCONNECTED_NO_AWAIT
  MUTATION_OFF_FAILOPEN_RESTORE MUTATION_OFF_FAILED_BADGE MUTATION_SAVE_NO_RESTORE
  MUTATION_OFF_NO_FLUSH_AWAIT MUTATION_OFF_FAILED_HEADER MUTATION_OFF_LATE_FAIL_NO_REFRESH
  MUTATION_RESTORE_AFTER_SUPERSEDE MUTATION_RESTORE_FROM_MEMORY MUTATION_RESTORE_IGNORES_NEWER_WRITE
  MUTATION_OFF_GENERIC_COPY MUTATION_OFF_KEEPS_FORM MUTATION_OFF_NO_RESTORE_TARGET
  MUTATION_OFF_TARGET_AFTER_AWAIT MUTATION_OFF_TARGET_IN_CATCH MUTATION_PER_INSTANCE
  MUTATION_REPLACE_NO_TARGET
)
REPORTS="$(mktemp -d)"

if ! git diff --quiet -- "$PANEL" "$DURABILITY" "$TEST"; then
  echo "refusing: $PANEL, $DURABILITY or $TEST has uncommitted changes" >&2
  exit 1
fi

# Installed only after the dirty check, so a refusal never wipes the caller's edits.
trap 'git checkout -- "$PANEL" "$DURABILITY"; rm -rf "$REPORTS"' EXIT
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
  git checkout -- "$PANEL" "$DURABILITY"
  echo "FAIL $1" >&2
  exit 1
}

# expect_red LABEL MARKER PERL_EXPR TEST_NAME [FILE]   (FILE defaults to the panel)
expect_red() {
  local label="$1" marker="$2" expr="$3" name="$4" file="${5:-$PANEL}"
  ROW=$((ROW + 1))
  local base="$REPORTS/row$ROW.base.json" mut="$REPORTS/row$ROW.mut.json"
  local before_hash after_hash

  run_named "$name" "$base" || restore_and_fail "$label: '$name' is not green on the real code"
  [ -f "$base" ] || restore_and_fail "$label: no report written for the baseline run"
  [ "$(count "$base" numPassedTests)" -ge 1 ] || restore_and_fail "$label: '$name' matched no test"

  before_hash="$(git hash-object "$file")"
  perl -0pi -e "$expr" "$file"
  after_hash="$(git hash-object "$file")"
  [ "$before_hash" != "$after_hash" ] || restore_and_fail "$label: the mutation did not apply (file unchanged)"
  [ "$(grep -c "$marker" "$file")" -eq 1 ] || restore_and_fail "$label: the mutation did not apply exactly once"

  local code=0
  run_named "$name" "$mut" || code=$?
  [ "$code" -ne 0 ] || restore_and_fail "$label: '$name' stayed GREEN under the mutation"
  [ -f "$mut" ] || restore_and_fail "$label: the run crashed (exit $code) and wrote no report"
  local failed
  failed="$(count "$mut" numFailedTests)"
  [ "$failed" -ge 1 ] || restore_and_fail "$label: the run errored (exit $code) without a failing test"

  git checkout -- "$file"
  printf '| %s | %s | %s | %s | %s |\n' "$label" "$marker" "$name" "$code" "$failed"
}

echo '| Mutation | Marker | Test that went red | Exit | Failed |'
echo '| --- | --- | --- | --- | --- |'

expect_red "onConnected before the probe resolves" MUTATION_EARLY_CONNECTED \
  's{(\n    setConn\(\{ phase: \x27testing\x27, source \}\);)}{\n    onConnected?.(describeLlmStatus(persisted)); /* MUTATION_EARLY_CONNECTED */$1}' \
  "does not report connected on a failed probe"

expect_red "do not await flushSettings before probing" MUTATION_NO_FLUSH_AWAIT \
  's{(writeLlmSettings\(\{ \.\.\.next, engine: \x27\x27 \}\);\n\s*const written = readLlmSettings\(\);\s+)await flushSettings\(\);}{${1}void flushSettings(); /* MUTATION_NO_FLUSH_AWAIT */}' \
  "reports connected only after the settings are durable"

expect_red "skip flushSettings entirely" MUTATION_SKIP_FLUSH \
  's{(writeLlmSettings\(\{ \.\.\.next, engine: \x27\x27 \}\);\n\s*const written = readLlmSettings\(\);\s+)await flushSettings\(\);}{${1}/* MUTATION_SKIP_FLUSH */}' \
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

expect_red "unmount no longer supersedes the probe" MUTATION_UNMOUNT_NO_BUMP \
  's{probeGen\.current \+= 1; // unmount supersedes the probe}{/* MUTATION_UNMOUNT_NO_BUMP */}' \
  "does not report connected after unmount, and aborts the in-flight probe"

expect_red "unmount no longer aborts the probe" MUTATION_UNMOUNT_NO_ABORT \
  's{probeAbort\.current\?\.abort\(\); // unmount aborts the probe}{/* MUTATION_UNMOUNT_NO_ABORT */}' \
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
  's{setConn\(\{ phase: \x27error\x27, source: \x27guided\x27, kind: \x27storage_off\x27 \}\);}{/* MUTATION_OFF_STORAGE_CATCH */}' \
  "shows a storage error, and fails closed (AI off in memory and on the badge), when turning AI off cannot be saved"

expect_red "drop the supersede guard on a FAILED probe" MUTATION_FAILED_PROBE_GUARD \
  's{(current verdict; ignore its result\.\n\s*)if \(gen !== probeGen\.current\) \{}{${1}if (false /* MUTATION_FAILED_PROBE_GUARD */) \{}' \
  "ignores a superseded probe that FAILS late"

expect_red "superseded turnAiOff skips the status refresh" MUTATION_OFF_NO_REFRESH \
  's{(the verdict to whoever superseded this turn-off\.\n\s*if \(offGen !== probeGen\.current\) \{\n)\s*setStatus\(describeLlmStatus\(\)\);\n\s*notifyLlmSettingsChanged\(\);\n}{${1}      /* MUTATION_OFF_NO_REFRESH */\n}' \
  "refreshes the status surfaces, but keeps the edit, when a Turn-AI-off flushes after a field edit"

expect_red "a throwing onConnected escapes the save handler" MUTATION_ONCONNECTED_UNGUARDED \
  's{try \{\n\s*await (onConnected\?\.\(describeLlmStatus\(persisted\)\);)\n\s*\} catch \(err\) \{.*?safeError\(\x27app\.typed_error\x27, err\);\n\s*\}}{/* MUTATION_ONCONNECTED_UNGUARDED */ $1}s' \
  "keeps Connected, and raises no unhandled rejection, when onConnected throws"

expect_red "an async onConnected is not awaited" MUTATION_ONCONNECTED_NO_AWAIT \
  's{await onConnected\?\.}{/* MUTATION_ONCONNECTED_NO_AWAIT */ onConnected?.}' \
  "keeps Connected, logs, and raises no unhandled rejection, when an async onConnected rejects"

expect_red "a failed turn-off restores the old key (fails OPEN)" MUTATION_OFF_FAILOPEN_RESTORE \
  's{(const offGen = \(probeGen\.current \+= 1\);)}{$1 const beforeOffM = readLlmSettings();}; s{(setStatus\(describeLlmStatus\(\)\); // fail-closed badge after a failed turn-off)}{hydrateLlmSettings(JSON.stringify(beforeOffM)); /* MUTATION_OFF_FAILOPEN_RESTORE */ $1}' \
  "shows a storage error, and fails closed (AI off in memory and on the badge), when turning AI off cannot be saved"

expect_red "a failed turn-off leaves the badge claiming AI is on" MUTATION_OFF_FAILED_BADGE \
  's{setStatus\(describeLlmStatus\(\)\); // fail-closed badge after a failed turn-off}{/* MUTATION_OFF_FAILED_BADGE */}' \
  "shows a storage error, and fails closed (AI off in memory and on the badge), when turning AI off cannot be saved"

expect_red "a failed turn-off does not signal the header" MUTATION_OFF_FAILED_HEADER \
  's{notifyLlmSettingsChanged\(\); // fail-closed header after a failed turn-off}{/* MUTATION_OFF_FAILED_HEADER */}' \
  "notifies the status surfaces when an un-superseded turn-off fails"

expect_red "a superseded turn-off that fails late skips the refresh" MUTATION_OFF_LATE_FAIL_NO_REFRESH \
  's{setStatus\(describeLlmStatus\(\)\); // fail-closed badge after a failed turn-off\n\s*notifyLlmSettingsChanged\(\); // fail-closed header after a failed turn-off\n}{/* MUTATION_OFF_LATE_FAIL_NO_REFRESH */\n}' \
  "superseded turn-off that fails late still shows AI off"

expect_red "a failed save leaves the unsaved config live in memory" MUTATION_SAVE_NO_RESTORE \
  's{hydrateLlmSettings\(JSON\.stringify\(restoreTargetSettings\(\)\)\); // restore the last durable config}{/* MUTATION_SAVE_NO_RESTORE */}' \
  "restores the previous in-memory settings when a save cannot be made durable"

expect_red "turnAiOff does not await its flush" MUTATION_OFF_NO_FLUSH_AWAIT \
  's{(// off is the restore target\n\s*)await flushSettings\(\);}{${1}void flushSettings(); /* MUTATION_OFF_NO_FLUSH_AWAIT */}' \
  "turns AI off only after the off write is durable"

expect_red "N5: restore only when the save still owns the verdict (edit)" MUTATION_RESTORE_AFTER_SUPERSEDE \
  's{if \(ownsSettingsMemory\(saveWrite\)\) \{}{if (ownsSettingsMemory(saveWrite) \&\& gen === probeGen.current /* MUTATION_RESTORE_AFTER_SUPERSEDE */) \{}' \
  "P4b-edit: a failed save superseded by a field EDIT"

expect_red "N5: restore only when the save still owns the verdict (unmount)" MUTATION_RESTORE_AFTER_SUPERSEDE \
  's{if \(ownsSettingsMemory\(saveWrite\)\) \{}{if (ownsSettingsMemory(saveWrite) \&\& gen === probeGen.current /* MUTATION_RESTORE_AFTER_SUPERSEDE */) \{}' \
  "P4b-unmount: a failed save superseded by UNMOUNT"

expect_red "restore reads memory, not the last durable config" MUTATION_RESTORE_FROM_MEMORY \
  's{(const saveWrite = beginSettingsWrite\(\);)}{$1 const beforeSaveM = readLlmSettings();}; s{hydrateLlmSettings\(JSON\.stringify\(restoreTargetSettings\(\)\)\); // restore the last durable config}{hydrateLlmSettings(JSON.stringify(beforeSaveM)); /* MUTATION_RESTORE_FROM_MEMORY */}' \
  "P4b-chain: two failed saves (A superseded by B)"

expect_red "an older failed save restores over a newer write" MUTATION_RESTORE_IGNORES_NEWER_WRITE \
  's{if \(ownsSettingsMemory\(saveWrite\)\) \{}{if (true /* MUTATION_RESTORE_IGNORES_NEWER_WRITE */) \{}' \
  "a failed older save does not wipe a newer save whose flush is still pending"

expect_red "a failed turn-off shows the generic storage copy" MUTATION_OFF_GENERIC_COPY \
  's{kind: \x27storage_off\x27 \}\);}{kind: \x27storage\x27 /* MUTATION_OFF_GENERIC_COPY */ \});}' \
  "says AI is off for now, and clears the key field, when turning AI off cannot be saved"

expect_red "a failed turn-off leaves the key in the form" MUTATION_OFF_KEEPS_FORM \
  's{setSettings\(readLlmSettings\(\)\); // clear the form after a failed turn-off}{/* MUTATION_OFF_KEEPS_FORM */}' \
  "says AI is off for now, and clears the key field, when turning AI off cannot be saved"

expect_red "a failed turn-off keeps the old key as the restore target" MUTATION_OFF_NO_RESTORE_TARGET \
  's{markRestoreTarget\(offWrite, readLlmSettings\(\)\); // off is the restore target}{/* MUTATION_OFF_NO_RESTORE_TARGET */}' \
  "a failed save after a failed turn-off restores memory to off, not the old key"

expect_red "a successful turn-off keeps the old key as the restore target" MUTATION_OFF_NO_RESTORE_TARGET \
  's{markRestoreTarget\(offWrite, readLlmSettings\(\)\); // off is the restore target}{/* MUTATION_OFF_NO_RESTORE_TARGET */}' \
  "after a successful turn-off, a failed save restores off, not the old key"

expect_red "I1: the off target is read from memory AFTER the flush" MUTATION_OFF_TARGET_AFTER_AWAIT \
  's{markRestoreTarget\(offWrite, readLlmSettings\(\)\); // off is the restore target\n(\s*)await flushSettings\(\);}{await flushSettings();\n${1}markRestoreTarget(offWrite, readLlmSettings()); /* MUTATION_OFF_TARGET_AFTER_AWAIT */}' \
  "off resolves, then a newer save rejects"

expect_red "I1: the off target is read from memory after a failed flush" MUTATION_OFF_TARGET_IN_CATCH \
  's{markRestoreTarget\(offWrite, readLlmSettings\(\)\); // off is the restore target\n}{}; s{(safeError\(\x27provider\.disable_failed\x27, err\);)}{$1 markRestoreTarget(offWrite, readLlmSettings()); /* MUTATION_OFF_TARGET_IN_CATCH */}' \
  "off rejects, then a newer save rejects"

expect_red "I1: off target missing when the save fails first" MUTATION_OFF_NO_RESTORE_TARGET \
  's{markRestoreTarget\(offWrite, readLlmSettings\(\)\); // off is the restore target}{/* MUTATION_OFF_NO_RESTORE_TARGET */}' \
  "a newer save rejects first, then the off flush settles"

expect_red "I2: durability is per panel instance again (reset on mount)" MUTATION_PER_INSTANCE \
  's{(import \{\n  beginSettingsWrite,)}{import { resetSettingsDurabilityForTests as perInstanceReset } from \x27./aiSettingsDurability\x27;\n$1}; s{(  const probeAbort = useRef<AbortController \| null>\(null\);\n)}{$1  useState(() => perInstanceReset()); /* MUTATION_PER_INSTANCE */\n}' \
  "two panel instances share one durability record"

expect_red "I3: a Replace is not the restore target" MUTATION_REPLACE_NO_TARGET \
  's{target = \{ writeId: writeCounter, settings: readLlmSettings\(\) \}; // Replace is the restore target}{/* MUTATION_REPLACE_NO_TARGET */}' \
  "after a remote Replace, a failed save restores the replaced config" "$DURABILITY"

# Restored: the source is clean and no marker survives anywhere in src.
git diff --quiet -- "$PANEL" "$DURABILITY" || { echo "FAIL: $PANEL or $DURABILITY is not clean after restore" >&2; exit 1; }
for marker in "${MARKERS[@]}"; do
  if grep -rq "$marker" src; then
    echo "FAIL: $marker left in src" >&2
    exit 1
  fi
done
echo "all 39 mutations went RED; source restored and clean"
