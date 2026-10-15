/**
 * The node parity harness (integration/parity.mjs) must compute the natal chart
 * the same way the CPython golden does. The golden is the STAMPED chart
 * (engine output + snapshot) since 12b9592d; a harness that calls the bare
 * engine mismatches every natal fixture at the `snapshot` key.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../../../../..');
const read = (path: string): string => readFileSync(resolve(repoRoot, path), 'utf8');

/** The body of a top-level Python `def name(...)`, up to the next unindented line. */
function pythonFunctionBody(source: string, name: string): string {
  const match = source.match(new RegExp(`^def ${name}\\([^)]*\\)[^:]*:\\n([\\s\\S]*?)(?=\\n\\S|$(?![\\s\\S]))`, 'm'));
  if (!match) throw new Error(`def ${name} not found`);
  return match[1];
}

/** The chart function a Python body returns: `return fn(` or `ctx = fn(`. */
function chartCall(body: string): string {
  const match = body.match(/^\s*(?:return|ctx =)\s+(\w+)\(/m);
  if (!match) throw new Error('no chart call found');
  return match[1];
}

describe('node parity harness', () => {
  it('computes natal charts with the function that builds the golden', () => {
    const golden = chartCall(pythonFunctionBody(read('backend/tests/test_chart_golden.py'), '_chart_for'));
    const harness = chartCall(
      pythonFunctionBody(read('frontend/packages/browser/integration/parity.mjs'), '_parity_chart'),
    );
    expect(golden).toBe('compute_stamped_chart');
    expect(harness).toBe(golden);
  });
});
