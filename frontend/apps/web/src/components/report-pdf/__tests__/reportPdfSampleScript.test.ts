// @vitest-environment node
/**
 * `bun run report:pdf:sample` is the eye-inspection harness for the PDF report.
 * It runs under plain Node + tsx (no Vite), so any report-pdf module that pulls
 * a Vite-only import (`?worker`, the engine runtime) breaks it — silently, since
 * nobody runs it in CI. This test runs the real script on the committed
 * Bengaluru reference chart, so the unit gate goes red the moment it rots.
 * It spawns `node` (never Bun): fontkit renders blank glyphs under Bun.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const APP_ROOT = resolve(__dirname, '../../../..');
const SCRIPT = resolve(APP_ROOT, 'scripts/render-report-pdf.mjs');
const REFERENCE_CHART = resolve(
  APP_ROOT,
  '../../packages/llm/bench/fixtures/chart-bengaluru-1988.json',
);

describe('report:pdf:sample', () => {
  let outDir = '';
  afterEach(() => {
    if (outDir !== '') rmSync(outDir, { recursive: true, force: true });
  });

  it('renders the full comprehensive report to a real PDF under plain Node', () => {
    outDir = mkdtempSync(join(tmpdir(), 'report-pdf-sample-'));
    const run = spawnSync('node', ['--import', 'tsx', SCRIPT], {
      cwd: APP_ROOT,
      encoding: 'utf8',
      env: { ...process.env, REPORT_CHART_FILE: REFERENCE_CHART, REPORT_OUT_DIR: outDir },
      timeout: 90_000,
    });
    expect(run.stderr).not.toMatch(/SyntaxError|ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION/);
    expect(run.status, run.stderr).toBe(0);
    const pdf = readFileSync(join(outDir, 'sample-report.pdf'));
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // The full comprehensive report is dozens of pages; a stub would be tiny.
    expect(pdf.length).toBeGreaterThan(100_000);
  }, 120_000);
});
