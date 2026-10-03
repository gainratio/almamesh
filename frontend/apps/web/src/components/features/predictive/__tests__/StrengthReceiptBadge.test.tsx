/**
 * StrengthReceiptBadge / StrengthReceiptPanel — the on-screen, user-verifiable
 * face of a sealed domain-strength receipt. Until now a receipt was only
 * verified silently on the PDF export path; these views surface the SAME
 * tamper-evidence check on screen.
 *
 * Receipts are minted with the REAL `@almamesh/browser` signer + REAL
 * `@gainratio/avow` keys — never a hand-rolled fake signature — so the badge runs
 * the exact fail-closed verification a real visitor's device runs. The covenant
 * check is load-bearing: the panel must render the calibrated BAND/tier and
 * never a fabricated percentage.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { generateSeedHex, publicKeyHex } from '@gainratio/avow';
import { signDomainStrength } from '@almamesh/browser';
import type { DomainStrengthReceipt, StrengthSummary } from '@almamesh/browser/types';
import { useLanguageStore } from '@almamesh/store';

import '../../../../i18n/config';
import { StrengthReceiptBadge, StrengthReceiptPanel } from '../StrengthReceiptBadge';

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

async function realReceipt(
  domain = 'career',
  overrides: Partial<StrengthSummary> = {},
): Promise<{ receipt: DomainStrengthReceipt; key: string }> {
  const seed = generateSeedHex();
  const key = await publicKeyHex(seed);
  const receipt = await signDomainStrength(domain, summary(overrides), seed);
  return { receipt, key };
}

describe('StrengthReceiptBadge', () => {
  beforeEach(() => {
    useLanguageStore.setState({ language: 'en' });
  });

  it('renders VERIFIED for a genuine receipt checked against its true signer', async () => {
    const { receipt, key } = await realReceipt();

    render(<StrengthReceiptBadge receipt={receipt} expectedPublicKey={key} />);

    const pill = await screen.findByText('Verified');
    // Accessible without color: a live status region carrying icon + word.
    const region = pill.closest('[role="status"]');
    expect(region).not.toBeNull();
    expect(region?.getAttribute('data-status')).toBe('verified');
  });

  it('renders NOT-VERIFIED (untrusted signer) when the pinned key did not seal it', async () => {
    const { receipt } = await realReceipt();
    const otherKey = await publicKeyHex(generateSeedHex());

    render(<StrengthReceiptBadge receipt={receipt} expectedPublicKey={otherKey} />);

    const pill = await screen.findByText(/untrusted signer/i);
    expect(pill.closest('[role="status"]')?.getAttribute('data-status')).toBe('wrong-key');
  });

  it('renders NOT-VERIFIED (tampered) when the headline % was mutated after sealing', async () => {
    const { receipt, key } = await realReceipt();
    const tampered: DomainStrengthReceipt = {
      ...receipt,
      payload: { ...receipt.payload, summary: { ...receipt.payload.summary, strength_pct: 999 } },
    };

    render(<StrengthReceiptBadge receipt={tampered} expectedPublicKey={key} />);

    const pill = await screen.findByText(/tampered or invalid/i);
    expect(pill.closest('[role="status"]')?.getAttribute('data-status')).toBe('invalid');
  });
});

describe('StrengthReceiptPanel — covenant: band/tier, never a fabricated %', () => {
  beforeEach(() => {
    useLanguageStore.setState({ language: 'en' });
  });

  it('surfaces the calibrated band + tier and never a raw strength percentage', async () => {
    const { receipt, key } = await realReceipt('career', { band: 'strong', strength_pct: 82.5 });

    render(<StrengthReceiptPanel receipt={receipt} expectedPublicKey={key} />);

    await screen.findByText('Verified');
    const panel = screen.getByTestId('domain-receipt-panel-career');
    // The calibrated band is shown (localized label), verbatim from summary.band.
    expect(panel.textContent).toContain('Strong');
    // The no-fake-precision covenant: no engine percentage is surfaced here.
    expect(panel.textContent).not.toContain('82.5');
    expect(panel.textContent).not.toMatch(/\d+(\.\d+)?\s*%/);
  });
});

// ===========================================================================
// The SKIN contract.
//
// `@gainratio/receipt-ui` is a deliberately unstyled Lego: it publishes markup
// with stable BEM hooks and NO stylesheet, so every consumer paints it in its
// own design system. AlmaMesh had never supplied that skin, so the flagship
// trust surface shipped to almamesh.com as a raw <dl> — an unstyled stack of
// "Algorithm / Ed25519 / Signer key / 9c08d6…" lines.
//
// These assertions are the regression guard for that. They go RED if the skin
// is deleted, if it stops being imported (built-but-not-wired), or if a
// receipt-ui upgrade renames a hook out from under it — the three ways the
// panel can silently go back to raw text while every other test stays green.
// ===========================================================================

/**
 * Where the seam lives, relative to whichever directory vitest was started in
 * (the app, the frontend workspace, or the repo root).
 *
 * Deliberately NOT derived from `import.meta.url`: under vitest that is a
 * pipeline URL, not a `file:` URL, and resolving it landed on THIS file — which
 * happens to quote the import string these assertions look for, so the guard
 * passed while reading the wrong file. Resolve from the cwd and fail loudly.
 */
const SEAM_DIRS = [
  'src/components/features/predictive',
  'apps/web/src/components/features/predictive',
  'frontend/apps/web/src/components/features/predictive',
] as const;

function readSeamFile(name: string): string {
  const tried = SEAM_DIRS.map((dir) => resolve(process.cwd(), dir, name));
  const found = tried.find((candidate) => existsSync(candidate));
  if (found === undefined) throw new Error(`cannot read ${name}; tried:\n${tried.join('\n')}`);
  return readFileSync(found, 'utf8');
}

/** Every `receipt-*` hook the vendored component actually emits, for this DOM. */
function receiptHooksIn(root: HTMLElement): string[] {
  const seen = new Set<string>();
  for (const el of root.querySelectorAll<HTMLElement>('[class]')) {
    for (const cls of el.classList) if (cls.startsWith('receipt-')) seen.add(cls);
  }
  return [...seen].sort();
}

/** Every `receipt-*` class the skin defines a rule for. */
function hooksStyledBy(css: string): Set<string> {
  return new Set([...css.matchAll(/\.(receipt-[\w-]+)/g)].map((m) => m[1] as string));
}

describe('StrengthReceiptPanel — the Observatory skin for the unstyled receipt-ui Lego', () => {
  beforeEach(() => {
    useLanguageStore.setState({ language: 'en' });
  });

  it('is WIRED: the seam imports the skin, so the bundle actually carries it', () => {
    // A stylesheet nobody imports is built, not shipped — and that is
    // indistinguishable from no stylesheet at all on the live site.
    expect(readSeamFile('StrengthReceiptBadge.tsx')).toContain("import './StrengthReceiptBadge.css'");
  });

  it('styles every hook the vendored panel emits', async () => {
    const { receipt, key } = await realReceipt('career', { band: 'strong' });

    const { container } = render(
      <StrengthReceiptPanel receipt={receipt} expectedPublicKey={key} />,
    );
    await screen.findByText('Verified');

    const emitted = receiptHooksIn(container);
    const styled = hooksStyledBy(readSeamFile('StrengthReceiptBadge.css'));

    // Non-vacuous: the panel emits a known-nonempty set of hooks.
    expect(emitted).toContain('receipt-panel');
    expect(emitted.length).toBeGreaterThanOrEqual(5);
    expect(emitted.filter((hook) => !styled.has(hook))).toEqual([]);
  });

  it('styles all four verdict states, not just the happy one', () => {
    // `checking`, `invalid` and `wrong-key` are one-at-a-time DOM states, so a
    // rendered-DOM sweep can never cover them — assert on the skin directly.
    const css = readSeamFile('StrengthReceiptBadge.css');
    for (const status of ['verified', 'invalid', 'wrong-key']) {
      expect(css).toMatch(new RegExp(`\\[data-status=['"]${status}['"]\\]`));
    }
    // `checking` inherits the neutral base rule rather than getting its own.
    expect(css).toMatch(/\.receipt-status\s*\{/);
  });

  it('gives the panel a VISIBLE localized heading, not only an aria-label', async () => {
    const { receipt, key } = await realReceipt();

    render(<StrengthReceiptPanel receipt={receipt} expectedPublicKey={key} />);
    await screen.findByText('Verified');

    // The vendored section carries `aria-label="Signed receipt"`, which a
    // sighted visitor never sees; on screen the panel arrived with no label at
    // all. The heading is ours, localized, and rendered.
    expect(screen.getByRole('heading', { name: 'Signed receipt' })).toBeTruthy();
  });
});
