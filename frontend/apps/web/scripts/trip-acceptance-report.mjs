#!/usr/bin/env node
/**
 * The pass table for the trip/today acceptance matrix (e2e/trip-acceptance.real.spec.ts):
 * reads its JSONL log and prints passes/runs per question x model, then every miss.
 * Exit 1 unless every cell is 100%.
 *
 * Run:  node scripts/trip-acceptance-report.mjs [test-results/trip-acceptance.jsonl]
 */
import { readFileSync } from 'node:fs';

const path = process.argv[2] ?? 'test-results/trip-acceptance.jsonl';
const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const models = [...new Set(lines.map((line) => line.model))];
const questions = [...new Set(lines.map((line) => line.question))];
let perfect = lines.length > 0;
const header = ['question', ...models];
const rows = questions.map((question) => [question, ...models.map((model) => {
  const cell = lines.filter((line) => line.question === question && line.model === model);
  const passed = cell.filter((line) => line.pass).length;
  if (cell.length === 0 || passed !== cell.length) perfect = false;
  return cell.length === 0 ? '-' : `${passed}/${cell.length}`;
})]);
for (const row of [header, ...rows]) console.log(`| ${row.join(' | ')} |`);
for (const line of lines.filter((entry) => !entry.pass)) {
  console.log(`\nFAIL ${line.model} run ${line.run} ${line.question}: ${line.misses.join('; ')}`);
}
process.exit(perfect ? 0 : 1);
