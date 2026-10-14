/**
 * Per-model loop metrics for the trip/today acceptance matrix (tool layer redesign 2026-10-14):
 * model requests, tool calls, first-try validity split into tool calls (read_period, travel) and
 * answers (the first answer submission accepted), retries, answer retries and error rows per
 * question, from the JSONL lines e2e/trip-acceptance.real.spec.ts writes. Lines written before a
 * field existed count toward the pass rate but not that field's averages (unmeasured, never zero).
 */

const sum = (lines, field) => lines.reduce((total, line) => total + line[field], 0);
const perQuestion = (lines, field) => (lines.length === 0 ? null : sum(lines, field) / lines.length);
const pct = (part, whole) => (whole === 0 ? null : (100 * part) / whole);

/** One row per model, in log order. */
export function modelMetrics(lines) {
  const models = [...new Set(lines.map((line) => line.model))];
  return models.map((model) => {
    const all = lines.filter((line) => line.model === model);
    const measured = all.filter((line) => typeof line.rounds === 'number');
    const split = measured.filter((line) => typeof line.toolCalls === 'number');
    return {
      model,
      questions: all.length,
      passed: all.filter((line) => line.pass).length,
      measured: measured.length,
      split: split.length,
      roundsPerQuestion: perQuestion(measured, 'rounds'),
      toolCallsPerQuestion: perQuestion(split, 'toolCalls'),
      toolFirstTryValidPct: pct(sum(split, 'toolValidFirstTry'), sum(split, 'toolCalls')),
      answerFirstTryValidPct: pct(sum(split, 'answerValidFirstTry'), split.length),
      retriesPerQuestion: perQuestion(measured, 'retries'),
      answerRetriesPerQuestion: perQuestion(split, 'answerRetries'),
      errorRowsPerQuestion: perQuestion(measured, 'errorRows'),
    };
  });
}

const fixed = (value, digits) => (value === null ? '-' : value.toFixed(digits));

/** The per-model table as Markdown. */
export function formatModelMetrics(metrics) {
  const header = [
    'model', 'pass', 'rounds/question', 'tool first-try-valid %', 'answer first-try-valid %', 'retries/question',
    'answer retries/question', 'error rows/question', 'tool calls/question',
  ];
  const rows = metrics.map((row) => [
    row.model, `${row.passed}/${row.questions}`, fixed(row.roundsPerQuestion, 2), fixed(row.toolFirstTryValidPct, 1),
    fixed(row.answerFirstTryValidPct, 1), fixed(row.retriesPerQuestion, 2), fixed(row.answerRetriesPerQuestion, 2),
    fixed(row.errorRowsPerQuestion, 2), fixed(row.toolCallsPerQuestion, 2),
  ]);
  return [header, ...rows].map((row) => `| ${row.join(' | ')} |`).join('\n');
}
