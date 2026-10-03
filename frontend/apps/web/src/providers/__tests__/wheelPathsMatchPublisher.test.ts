/**
 * Bind the SPA's wheel READ-list to the publisher's wheel SET.
 *
 * WHY this exists (the scar): `readRuntimeConfig().wheelPaths` tells the engine
 * which files to pull out of the signed bundle. The publisher decides what is
 * actually IN that bundle — it vendors every `backend/offline_wheels/*.whl` plus
 * the built almamesh wheel. Those are two halves of ONE contract with nothing
 * holding them together.
 *
 * They drifted: when the `avow`/`rfc8785` wheels were dropped from the publisher
 * (strength receipts are signed in TypeScript now, so the Python engine ships no
 * crypto), this list kept asking for them. The bundle sync SUCCEEDED — 552 chunks,
 * correct manifest hash — and then the very next read failed closed with
 * `file wheels/rfc8785-0.1.4-py3-none-any.whl not in manifest`. The engine boot
 * aborted before the Pyodide worker was even spawned, so the NATAL chart broke at
 * onboarding, surfacing as the generic `CHART_GEN_001` error screen.
 *
 * Every unit gate was green. Only the 3-minute real-onboarding e2e caught it.
 * This test makes the same drift fail in milliseconds, at the right layer.
 */

import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { readRuntimeConfig } from '../AlmaMeshRuntimeProvider';

const HERE = dirname(fileURLToPath(import.meta.url));
// repo-root/backend/offline_wheels — the publisher's vendored-wheel source of truth
// (see backend/src/almamesh/edge/bundle.py: gather_offline_wheels globs this dir).
const OFFLINE_WHEELS = resolve(HERE, '../../../../../../backend/offline_wheels');

/** The vendored wheels the publisher will put in the bundle, as bundle paths. */
function publishedVendoredWheels(): string[] {
  return readdirSync(OFFLINE_WHEELS)
    .filter((name) => name.endsWith('.whl'))
    .map((name) => `wheels/${name}`)
    .sort();
}

describe('wheelPaths matches what the publisher actually bundles', () => {
  it('finds the publisher’s vendored wheels (non-vacuity)', () => {
    // If this ever reads an empty dir the whole test would pass vacuously.
    expect(publishedVendoredWheels().length).toBeGreaterThanOrEqual(3);
  });

  it('requests EVERY vendored wheel the publisher ships, and no others', () => {
    const requested = readRuntimeConfig()
      .wheelPaths.filter((path) => !path.includes('almamesh-'))
      .slice()
      .sort();

    expect(requested).toEqual(publishedVendoredWheels());
  });

  it('requests the almamesh engine wheel, last (install order is leaf-first)', () => {
    const paths = readRuntimeConfig().wheelPaths;
    const almamesh = paths.filter((path) => path.includes('almamesh-'));

    expect(almamesh).toHaveLength(1);
    expect(paths.at(-1)).toBe(almamesh[0]);
  });

  it('asks for no crypto wheels — the Python engine is crypto-free', () => {
    // Receipts are signed in TypeScript (@gainratio/avow). If a wheel chain ever
    // comes back into this list, it must come back into the publisher too.
    const joined = readRuntimeConfig().wheelPaths.join(' ');

    expect(joined).not.toContain('avow');
    expect(joined).not.toContain('rfc8785');
    expect(joined).not.toContain('pynacl');
  });
});
