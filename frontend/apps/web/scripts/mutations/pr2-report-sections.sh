#!/usr/bin/env bash
# PR 2 mutation red runs ("dates in the report come only from the engine").
#
# Each mutation breaks a PROPERTY in @almamesh/llm source. For each one:
#   1. the named test must pass on the unmutated tree (baseline, else a red
#      run proves nothing);
#   2. the mutation must apply (its marker is asserted present, or we abort);
#   3. the named test must FAIL: verdict = vitest's exit code AND its JSON
#      report showing >=1 failed test whose name is the named test. A crash or
#      collection error (no failed test in the JSON) is NOT a red;
#   4. the file is restored and `git diff --quiet` proves it.
# At the end the tracked tree must be clean and no marker may be left behind.
#
# Run: bash frontend/apps/web/scripts/mutations/pr2-report-sections.sh
# Exit 0 = every mutation went red. Non-zero = a guard measured shape, or the
# harness could not prove a mutation applied.
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel)"
LLM="$ROOT/frontend/packages/llm"
SRC_REL="frontend/packages/llm/src"
LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pr2-mutations.XXXXXX")"
cd "$ROOT"

if ! git diff --quiet -- "$SRC_REL" || ! git diff --cached --quiet -- "$SRC_REL"; then
  echo "refusing to run: $SRC_REL has uncommitted changes" >&2
  exit 2
fi

FAILED=0
MARKERS=()
CURRENT_FILE=""

restore_current() {
  if [ -n "$CURRENT_FILE" ]; then
    git checkout -- "$CURRENT_FILE"
    CURRENT_FILE=""
  fi
}
trap restore_current EXIT INT TERM

# vitest -t takes a regex; test names contain ( ) / . , so escape them.
regex_escape() {
  perl -e 'print quotemeta($ARGV[0])' "$1"
}

# run_test <log-id> <test-file> <test-name>; sets RUN_CODE and RUN_JSON.
run_test() {
  local id="$1" test_file="$2" test_name="$3"
  RUN_JSON="$LOG_DIR/$id.json"
  rm -f "$RUN_JSON"
  (cd "$LLM" && bunx vitest run "$test_file" -t "$(regex_escape "$test_name")" \
    --reporter=json --outputFile="$RUN_JSON" >"$LOG_DIR/$id.log" 2>&1)
  RUN_CODE=$?
}

# count <json> <status> <test-name> [needle]: assertions in vitest's JSON report
# with that status whose title is the test name (and, with a needle, whose
# failure message is "... not to contain '<needle>'"). A missing or unreadable
# report counts 0, so a crash can never read as a red.
count() {
  node -e '
    const [file, status, title, needle] = process.argv.slice(1);
    let report;
    try { report = JSON.parse(require("fs").readFileSync(file, "utf8")); } catch { console.log(0); process.exit(0); }
    const hits = (report.testResults ?? []).flatMap((f) => f.assertionResults ?? []).filter((a) =>
      a.status === status && a.title === title &&
      (!needle || (a.failureMessages ?? []).some((m) => m.includes(`not to contain '"'"'${needle}'"'"'`))));
    console.log(hits.length);
  ' "$@"
}

# int_or_die <value> <what>: abort unless the value is a non-negative integer.
int_or_die() {
  case "$1" in
    ''|*[!0-9]*) echo "harness error: $2 is not a count ('$1')" >&2; exit 1 ;;
  esac
}

mutate() {
  local id="$1" file="$2" perl_expr="$3" marker="$4" test_file="$5" test_name="$6"
  local needle="${7:-}" sites="${8:-1}"
  MARKERS+=("$marker")

  run_test "$id-baseline" "$test_file" "$test_name"
  local base_pass
  base_pass="$(count "$RUN_JSON" passed "$test_name")"
  int_or_die "$base_pass" "baseline pass count"
  if [ "$RUN_CODE" -ne 0 ] || [ "$base_pass" -lt 1 ]; then
    echo "MUTATION $id: baseline not green for '$test_name' (exit $RUN_CODE, passed $base_pass)" >&2
    exit 1
  fi

  CURRENT_FILE="$file"
  perl -0pi -e "$perl_expr" "$ROOT/$file"
  local applied
  applied="$(grep -cF "$marker" "$ROOT/$file")"
  if [ "$applied" -ne "$sites" ]; then
    echo "MUTATION $id did not apply to $file ($applied of $sites sites)" >&2
    restore_current
    exit 1
  fi

  run_test "$id" "$test_file" "$test_name"
  restore_current
  if ! git diff --quiet -- "$file"; then
    echo "MUTATION $id: $file not restored" >&2
    exit 1
  fi

  local failed on_needle
  failed="$(count "$RUN_JSON" failed "$test_name")"
  int_or_die "$failed" "failed count"
  on_needle="$failed"
  if [ -n "$needle" ]; then
    on_needle="$(count "$RUN_JSON" failed "$test_name" "$needle")"
    int_or_die "$on_needle" "needle count"
  fi

  if [ "$RUN_CODE" -ne 0 ] && [ "$failed" -ge 1 ] && [ "$on_needle" -ge 1 ]; then
    echo "| $id | $file | $test_name | RED | $RUN_CODE | $failed |"
  elif [ "$RUN_CODE" -ne 0 ] && [ "$failed" -lt 1 ]; then
    echo "| $id | $file | $test_name | CRASH (no failed test in JSON; not a red) | $RUN_CODE | 0 |"
    FAILED=1
  elif [ "$failed" -ge 1 ]; then
    echo "| $id | $file | $test_name | RED on the wrong needle (wanted $needle) | $RUN_CODE | $failed |"
    FAILED=1
  else
    echo "| $id | $file | $test_name | GREEN (guard did NOT catch it) | $RUN_CODE | $failed |"
    FAILED=1
  fi
}


DG=frontend/packages/llm/src/date-guard.ts
RS=frontend/packages/llm/src/report-sections.ts
CE=frontend/packages/llm/src/cost-estimate.ts
SI=frontend/packages/llm/src/structured-interpretation.ts
CL=frontend/packages/llm/src/client.ts
ST=frontend/packages/llm/src/section-timeout.ts

echo "| # | file | test | verdict | exit | failed |"
echo "| --- | --- | --- | --- | --- | --- |"

# 1. The date guard returns its input untouched.
mutate 1 "$DG" \
  's/(\): \{ section: T; removals: number \} \{\n)/$1  return { section, removals: 0 }; \/\/ MUTATION-PR2-1\n/' \
  'MUTATION-PR2-1' src/__tests__/date-guard.test.ts 'removes a month the engine did not supply'

# 2. Day-precision dates are let through (only month checks remain).
mutate 2 "$DG" \
  's/if \(DAY_PRECISION\.some\(\(pattern\) => pattern\.test\(sentence\)\)\) return true;/if (false) return true; \/\/ MUTATION-PR2-2/' \
  'MUTATION-PR2-2' src/__tests__/date-guard.test.ts 'removes day-precision dates'

# 3. life_outlook gets the full predictive block.
mutate 3 "$RS" \
  's/return forecast \? \[\{ \.\.\.forecast, house_lords: houses\[domain\] \?\? \[\] \}\] : \[\];/return forecast ? [{ ...forecast, ...chart.predictive, house_lords: houses[domain] ?? [] }] : []; \/\/ MUTATION-PR2-3/' \
  'MUTATION-PR2-3' src/__tests__/report-slices.test.ts 'passes life_outlook_1 only its four domain forecasts plus their house-lord rows'

# 4. A price is invented when the catalog has none.
mutate 4 "$CE" \
  's/if \(pricing === null\) return null;/if (pricing === null) pricing = { promptUsdPerToken: 0.0000003, completionUsdPerToken: 0.0000012 }; \/\/ MUTATION-PR2-4/' \
  'MUTATION-PR2-4' src/__tests__/cost-estimate.test.ts 'no price, no number'

# 5. Any quarter key is accepted (whole check gone).
mutate 5 "$RS" \
  's/if \(!isSentQuarter\(key, sent\) \|\| seen\.has\(key\)\) \{/if (false && seen.has(key as QuarterKey)) { \/\/ MUTATION-PR2-5/' \
  'MUTATION-PR2-5' src/__tests__/report-parsers.test.ts 'rejects a quarter key it did not send'

# 6. Report sections get the legacy 12k reasoning cap.
mutate 6 "$SI" \
  's/return isReportRequest\(section, promptSet\) \? REPORT_SECTION_REASONING_MAX_TOKENS : SECTION_REASONING_MAX_TOKENS;/return SECTION_REASONING_MAX_TOKENS; \/\/ MUTATION-PR2-6/' \
  'MUTATION-PR2-6' src/__tests__/report-timeline.test.ts 'caps reasoning at 6,000 tokens on every report section'

# 7. The date guard is unwired from current_period only.
mutate 7 "$SI" \
  's/results\.current_period = guarded\(results, parseCurrentPeriod\(json\), currentPeriodSlice\(chart\)\);/results.current_period = parseCurrentPeriod(json); \/\/ MUTATION-PR2-7/' \
  'MUTATION-PR2-7' src/__tests__/report-timeline.test.ts 'removes the invented month from every timeline section and counts each'

# 8. life_outlook leaks ONLY the transits sade_sati block (not gochara).
mutate 8 "$RS" \
  's/(as_of_month: reportAsOfMonth\(chart\),\n)(\s+domains: group\.flatMap)/$1    sade_sati: chart.predictive?.transits?.sade_sati, \/\/ MUTATION-PR2-8\n$2/' \
  'MUTATION-PR2-8' src/__tests__/report-slices.test.ts 'passes life_outlook_1 only its four domain forecasts plus their house-lord rows' \
  '"sade_sati"'

# 9. buildReportMessages sends the raw (time-sensitive) chart to natal sections.
# The natal leak has two independent layers: buildReportMessages strips the
# chart with stableNatalChart, AND buildReportNatalMessages drops dashas from
# whatever it gets. Breaking either one alone leaves the property intact (both
# single mutants are green: equivalent, not a hole), so the property break
# removes both. Two sites, both asserted.
mutate 9 "$SI" \
  's/const natal = sanitizeChartForLlm\(stableNatalChart\(input\.chart\), asOf\);/const natal = sanitizeChartForLlm(input.chart, asOf); \/\/ MUTATION-PR2-9/; s/const \{ predictive: _predictive, dashas: _dashas, as_of: _asOf, \.\.\.natal \} = chart;/const { predictive: _predictive, as_of: _asOf, ...natal } = chart; \/\/ MUTATION-PR2-9/' \
  'MUTATION-PR2-9' src/__tests__/report-messages.test.ts 'never puts dashas or predictive data in a natal message' \
  '"maha_dasha_sequence"' 2

# 10. Every host is treated as OpenRouter.
mutate 10 "$CL" \
  's/return config\.baseUrl\?\.startsWith\(OPENROUTER_API_BASE\) === true;/return true; \/\/ MUTATION-PR2-10/' \
  'MUTATION-PR2-10' src/__tests__/report-timeline.test.ts 'sends no provider field to a local or a non-OpenRouter endpoint'

# 11. The remote total time cap is removed.
mutate 11 "$SI" \
  's/return \{ totalMs: params\.sectionTimeoutMs \?\? REPORT_SECTION_TIMEOUT_MS, idleMs \};/return { idleMs }; \/\/ MUTATION-PR2-11/' \
  'MUTATION-PR2-11' src/__tests__/section-timeout.test.ts 'defaults: a remote section that keeps writing is cut at exactly 300 s (total cap)'

# 12. Local idle is armed at launch instead of at the first token.
mutate 12 "$ST" \
  's/let started = limits\.firstTokenMs === undefined;/let started = true; \/\/ MUTATION-PR2-12/' \
  'MUTATION-PR2-12' src/__tests__/section-timeout.test.ts 'local: a slow first token (queue / prefill) longer than the idle limit does not trip idle'

# 13. A non-empty quarter key that was not sent is accepted (repeat check kept).
mutate 13 "$RS" \
  's/if \(!isSentQuarter\(key, sent\) \|\| seen\.has\(key\)\) \{/if ((key === "" \&\& !isSentQuarter(key, sent)) || seen.has(key as QuarterKey)) { \/\/ MUTATION-PR2-13/' \
  'MUTATION-PR2-13' src/__tests__/report-parsers.test.ts 'rejects a quarter key it did not send'

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "tracked tree not clean after restoring mutations" >&2
  git status --porcelain --untracked-files=no >&2
  exit 1
fi
for marker in "${MARKERS[@]}"; do
  if grep -rqF "$marker" "$ROOT/frontend/packages/llm/src" "$ROOT/frontend/apps/web/e2e"; then
    echo "leftover mutation marker $marker in the tree" >&2
    exit 1
  fi
done

echo "logs: $LOG_DIR"
exit "$FAILED"
