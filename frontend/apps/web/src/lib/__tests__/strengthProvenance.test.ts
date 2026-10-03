/**
 * strengthProvenance — verifies EVERY sealed domain-strength receipt against
 * the pinned per-boot signer, in isolation: one bad receipt must never abort
 * verification of the others, and the function must never throw. Receipts are
 * built with the REAL `@almamesh/browser` signer (`signDomainStrength`) and
 * REAL `@gainratio/avow` keys — never a hand-rolled fake signature — so these
 * tests exercise the exact byte-compatible envelope the Worker mints.
 */

import { describe, expect, it } from 'vitest';
import { generateSeedHex, publicKeyHex } from '@gainratio/avow';
import { signDomainStrength } from '@almamesh/browser';
import type { DomainStrengthReceipt, StrengthSummary } from '@almamesh/browser/types';

import { verifyStrengthProvenance } from '../strengthProvenance';

function summary(overrides: Partial<StrengthSummary> = {}): StrengthSummary {
  return {
    key_graha: 'saturn',
    key_graha_rupas: 7.5,
    key_graha_meets_minimum: true,
    sav_bindus: 31,
    band: 'moderate',
    shadbala_pct: 60,
    sav_pct: 55.357142857142854,
    strength_pct: 55.357142857142854,
    strength_tier: 'model',
    approximated: true,
    note: 'test fixture',
    ...overrides,
  } as StrengthSummary;
}

/** Seal one receipt per domain under `seedHex`, keyed by domain name. */
async function receiptsFor(
  domains: readonly string[],
  seedHex: string,
): Promise<Record<string, DomainStrengthReceipt>> {
  const entries = await Promise.all(
    domains.map(
      async (domain, index) =>
        [domain, await signDomainStrength(domain, summary({ sav_bindus: 20 + index }), seedHex)] as const,
    ),
  );
  return Object.fromEntries(entries);
}

describe('verifyStrengthProvenance', () => {
  it('returns empty verified/failed for an empty receipts map, without throwing', async () => {
    const result = await verifyStrengthProvenance({}, 'some-signer-key');

    expect(result.verified.size).toBe(0);
    expect(result.failed).toEqual([]);
    expect(result.signerPublicKey).toBe('some-signer-key');
  });

  it('verifies every domain when all receipts are genuine and match the signer', async () => {
    const seed = generateSeedHex();
    const key = await publicKeyHex(seed);
    const receipts = await receiptsFor(['career', 'finances', 'health'], seed);

    const result = await verifyStrengthProvenance(receipts, key);

    expect([...result.verified].sort()).toEqual(['career', 'finances', 'health']);
    expect(result.failed).toEqual([]);
  });

  it('isolates a single tampered receipt into failed — the others still verify', async () => {
    const seed = generateSeedHex();
    const key = await publicKeyHex(seed);
    const receipts = await receiptsFor(['career', 'finances', 'health'], seed);
    // Mutate the headline percentage after sealing — the exact tamper case a
    // receipt exists to catch.
    const tampered: Record<string, DomainStrengthReceipt> = {
      ...receipts,
      finances: {
        ...receipts.finances,
        payload: {
          ...receipts.finances.payload,
          summary: { ...receipts.finances.payload.summary, strength_pct: 999 },
        },
      },
    };

    const result = await verifyStrengthProvenance(tampered, key);

    expect(result.failed).toEqual(['finances']);
    expect([...result.verified].sort()).toEqual(['career', 'health']);
  });

  it('fails a genuine receipt when it does not match the summary being exported', async () => {
    const seed = generateSeedHex();
    const key = await publicKeyHex(seed);
    const receipts = await receiptsFor(['career'], seed);
    const current = {
      career: summary({ sav_bindus: 20, strength_pct: 99 }),
    };

    const result = await verifyStrengthProvenance(receipts, key, current);

    expect(result.verified.size).toBe(0);
    expect(result.failed).toEqual(['career']);
  });

  it('fails every domain when checked against a signer key that did not seal them', async () => {
    const seed = generateSeedHex();
    const receipts = await receiptsFor(['career', 'finances'], seed);
    const wrongKey = await publicKeyHex(generateSeedHex());

    const result = await verifyStrengthProvenance(receipts, wrongKey);

    expect(result.verified.size).toBe(0);
    expect([...result.failed].sort()).toEqual(['career', 'finances']);
  });

  it('never throws, even against a malformed signer key', async () => {
    const receipts = await receiptsFor(['career'], generateSeedHex());

    await expect(verifyStrengthProvenance(receipts, 'not-a-real-key')).resolves.toEqual({
      verified: new Set(),
      failed: ['career'],
      signerPublicKey: 'not-a-real-key',
    });
  });
});
