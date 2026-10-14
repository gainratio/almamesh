/**
 * Per-model loop metrics for the trip/today acceptance matrix (tool layer redesign 2026-10-14):
 * model requests, tool calls, calls valid on the first try, retries and error rows per question,
 * from the JSONL lines e2e/trip-acceptance.real.spec.ts writes. Lines written before these
 * fields existed count toward the pass rate but not the averages (unmeasured, never zero).
 */

const sum = (lines, field) => lines.reduce((total, line) => total + line[field], 0);
const perQuestion = (lines, field) => (lines.length === 0 ? null : sum(lines, field) / lines.length);

/** One row per model, in log order. */
export function modelMetrics(lines) {
  const models = [...new Set(lines.map((line) => line.model))];
  return models.map((model) => {
    const all = lines.filter((line) => line.model === model);
    const measured = all.filter((line) => typeof line.rounds === 'number');
    const calls = sum(measured, 'calls');
    return {
      model,
      questions: all.length,
      passed: all.filter((line) => line.pass).length,
      measured: measured.length,
      roundsPerQuestion: perQuestion(measured, 'rounds'),
      callsPerQuestion: perQuestion(measured, 'calls'),
      firstTryValidPct: calls === 0 ? null : (100 * sum(measured, 'validFirstTry')) / calls,
      retriesPerQuestion: perQuestion(measured, 'retries'),
      errorRowsPerQuestion: perQuestion(measured, 'errorRows'),
    };
  });
}

const fixed = (value, digits) => (value === null ? '-' : value.toFixed(digits));

/** The per-model table as Markdown. */
export function formatModelMetrics(metrics) {
  const header = ['model', 'pass', 'rounds/question', 'first-try-valid %', 'retries/question', 'error rows/question', 'calls/question'];
  const rows = metrics.map((row) => [
    row.model, `${row.passed}/${row.questions}`, fixed(row.roundsPerQuestion, 2), fixed(row.firstTryValidPct, 1),
    fixed(row.retriesPerQuestion, 2), fixed(row.errorRowsPerQuestion, 2), fixed(row.callsPerQuestion, 2),
  ]);
  return [header, ...rows].map((row) => `| ${row.join(' | ')} |`).join('\n');
}
