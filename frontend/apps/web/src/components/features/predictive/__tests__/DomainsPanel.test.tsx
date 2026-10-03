import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { generateSeedHex, publicKeyHex } from '@gainratio/avow';
import { signDomainStrength } from '@almamesh/browser';
import type { StrengthSummary } from '@almamesh/browser/types';
import { useLanguageStore } from '@almamesh/store';
import type { DomainsCtx, StrengthAssayData } from '@almamesh/shared-types';

import i18n from '../../../../i18n/config';
import { DomainsPanel, DOMAIN_ORDER } from '../DomainsPanel';
import { DOMAINS_CTX } from '../../../../test/predictiveFixtures';

function receiptSummary(overrides: Partial<StrengthSummary> = {}): StrengthSummary {
  return {
    key_graha: 'saturn',
    key_graha_rupas: 7.5,
    key_graha_meets_minimum: true,
    sav_bindus: 31,
    band: 'moderate',
    shadbala_pct: 60,
    sav_pct: 55,
    strength_pct: 55,
    strength_tier: 'model',
    approximated: true,
    note: 'fixture',
    ...overrides,
  } as StrengthSummary;
}

const CAREER_ASSAY: StrengthAssayData = {
  schema: 'assay.result/v1',
  method: { id: 'minimum', version: 'almamesh.domain-strength.v1' },
  score: 0.5357,
  interval: null,
  clamp: 'reject',
  intercept: null,
  weight_total: null,
  components: [
    {
      id: 'shadbala_pct',
      raw: 82.5,
      normalized: 0.825,
      declared_weight: null,
      operation: 'add',
      coefficient: 1,
      contribution: 0.825,
      contribution_interval: null,
    },
    {
      id: 'sav_pct',
      raw: 53.57,
      normalized: 0.5357,
      declared_weight: null,
      operation: 'add',
      coefficient: 1,
      contribution: 0.5357,
      contribution_interval: null,
    },
  ],
  inputs_hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  selected_component_id: 'sav_pct',
};

const DOMAINS_WITH_ASSAY: DomainsCtx = {
  ...DOMAINS_CTX,
  forecasts: {
    ...DOMAINS_CTX.forecasts,
    career: { ...DOMAINS_CTX.forecasts.career, strength_assay: CAREER_ASSAY },
  },
};

describe('DomainsPanel', () => {
  beforeEach(async () => {
    useLanguageStore.setState({ language: 'en' });
    await i18n.changeLanguage('en');
  });

  it('renders one card per life domain (all seven)', () => {
    render(<DomainsPanel domainsCtx={DOMAINS_CTX} />);
    expect(DOMAIN_ORDER).toHaveLength(7);
    for (const domain of DOMAIN_ORDER) {
      expect(screen.getByTestId(`domain-card-${domain}`)).toBeTruthy();
    }
  });

  it('shows the engine strength band and key-graha line per domain', () => {
    render(<DomainsPanel domainsCtx={DOMAINS_CTX} />);
    const career = screen.getByTestId('domain-card-career');
    expect(within(career).getByTestId('band-strong').textContent).toBe('Strong');
    // Formatted to two decimals — never the engine's raw 6.128260954302394.
    expect(within(career).getByText(/6\.13 rūpas/)).toBeTruthy();
    expect(career.textContent).not.toContain('6.128260954302394');
    // The health fixture is the weak band — rendered honestly, not hidden.
    const health = screen.getByTestId('domain-card-health');
    expect(within(health).getByTestId('band-weak').textContent).toBe('Weak');
  });

  it('shows the current emphasis: dasha activation, Sade Sati and transit tone', () => {
    render(<DomainsPanel domainsCtx={DOMAINS_CTX} />);
    const career = screen.getByTestId('domain-emphasis-career');
    expect(career.textContent).toContain('maha · antar');
    expect(career.textContent).toContain('Saturn');
    expect(career.textContent).toContain('Under Sade Sati');
    // The emphasis heuristic is flagged approximate — visible, not hidden.
    expect(career.textContent).toContain('≈');
    // A domain NOT activated by the dasha says so plainly.
    const family = screen.getByTestId('domain-emphasis-family');
    expect(family.textContent).toContain('Not emphasized by the running daśā');
  });

  it('lists upcoming timed windows with locale dates and sources', () => {
    render(<DomainsPanel domainsCtx={DOMAINS_CTX} />);
    const windows = screen.getByTestId('domain-windows-career');
    expect(windows.textContent).toContain('Jupiter enters Cancer');
    expect(windows.textContent).toContain('2026');
    expect(windows.textContent).not.toContain('2026-10-26'); // human date, not raw ISO
    expect(windows.textContent).toContain('(transit)');
    expect(windows.textContent).toContain('(daśā)');
  });

  it('reveals the house/karaka/varga working behind a disclosure', () => {
    render(<DomainsPanel domainsCtx={DOMAINS_CTX} />);
    const career = screen.getByTestId('domain-card-career');
    const toggle = within(career).getByRole('button', { expanded: false });
    fireEvent.click(toggle);
    expect(within(career).getByText(/House 10/)).toBeTruthy();
    expect(within(career).getByText(/Kārakas/)).toBeTruthy();
  });

  it('renders no receipt badge when no receipts/signer are provided (unchanged)', () => {
    render(<DomainsPanel domainsCtx={DOMAINS_CTX} />);
    for (const domain of DOMAIN_ORDER) {
      expect(screen.queryByTestId(`domain-receipt-${domain}`)).toBeNull();
    }
  });

  it('renders sibling Assay calculation and Avow verification panels with separate claims', () => {
    render(<DomainsPanel domainsCtx={DOMAINS_WITH_ASSAY} />);

    const evidence = screen.getByTestId('domain-strength-evidence-career');
    expect(within(evidence).getByRole('heading', { name: 'How calculated — Assay' })).toBeTruthy();
    expect(within(evidence).getByText('82.50%')).toBeTruthy();
    expect(within(evidence).getByText('53.57%', { selector: '[data-assay-result]' })).toBeTruthy();
    expect(evidence.textContent).toContain('lower of the two');
    expect(within(evidence).getByRole('heading', { name: 'What verified — Avow' })).toBeTruthy();
    expect(within(evidence).getByText('Unavailable')).toBeTruthy();
    expect(evidence.textContent).toContain('integrity since this engine boot');
    expect(evidence.textContent).toContain('not correctness or identity');
  });

  it.each([
    ['es', 'Cómo se calculó — Assay', 'Qué se verificó — Avow'],
    ['pt', 'Como foi calculado — Assay', 'O que foi verificado — Avow'],
  ] as const)('localizes both evidence-panel headings in %s', async (language, assay, avow) => {
    useLanguageStore.setState({ language });
    await i18n.changeLanguage(language);

    render(<DomainsPanel domainsCtx={DOMAINS_WITH_ASSAY} />);

    expect(screen.getAllByRole('heading', { name: assay })).toHaveLength(7);
    expect(screen.getAllByRole('heading', { name: avow })).toHaveLength(7);
  });

  it('surfaces a per-domain VERIFIED receipt badge only for domains that have a receipt', async () => {
    const seed = generateSeedHex();
    const key = await publicKeyHex(seed);
    const receipts = {
      career: await signDomainStrength(
        'career',
        DOMAINS_CTX.forecasts.career.strength_summary as StrengthSummary,
        seed,
      ),
      health: await signDomainStrength(
        'health',
        DOMAINS_CTX.forecasts.health.strength_summary as StrengthSummary,
        seed,
      ),
    };

    const olderDomains = {
      ...DOMAINS_CTX,
      forecasts: Object.fromEntries(
        Object.entries(DOMAINS_CTX.forecasts).map(([domain, forecast]) => {
          const { strength_assay: _assay, ...withoutAssay } = forecast;
          return [domain, withoutAssay];
        }),
      ),
    } as DomainsCtx;

    render(<DomainsPanel domainsCtx={olderDomains} receipts={receipts} signerPublicKey={key} />);

    // A domain WITH a receipt shows a per-domain badge that verifies on screen —
    // fail-closed, icon+text (not colour alone) via the shared receipt view.
    for (const domain of ['career', 'health']) {
      const badge = await screen.findByTestId(`domain-receipt-${domain}`);
      expect(await within(badge).findByText('Verified')).toBeTruthy();
      expect(within(badge).getByRole('status').getAttribute('data-status')).toBe('verified');
    }
    // Domains WITHOUT a receipt render exactly as before — no badge.
    expect(screen.queryByTestId('domain-receipt-family')).toBeNull();
    expect(screen.queryByTestId('domain-receipt-finances')).toBeNull();
  });

  it('fails Avow when a genuine same-boot receipt belongs to a different visible summary', async () => {
    const seed = generateSeedHex();
    const key = await publicKeyHex(seed);
    const stale = await signDomainStrength('career', receiptSummary(), seed);

    render(
      <DomainsPanel
        domainsCtx={DOMAINS_WITH_ASSAY}
        receipts={{ career: stale }}
        signerPublicKey={key}
      />,
    );

    const avow = screen.getByTestId('domain-avow-career');
    expect(await within(avow).findByText('Failed')).toBeTruthy();
    expect(avow.getAttribute('data-status')).toBe('failed');
  });

  it('fails closed and withholds altered Assay figures beside a genuine signed summary', async () => {
    const seed = generateSeedHex();
    const key = await publicKeyHex(seed);
    const summary = DOMAINS_WITH_ASSAY.forecasts.career.strength_summary;
    const receipt = await signDomainStrength('career', summary as StrengthSummary, seed);
    const alteredDomains: DomainsCtx = {
      ...DOMAINS_WITH_ASSAY,
      forecasts: {
        ...DOMAINS_WITH_ASSAY.forecasts,
        career: {
          ...DOMAINS_WITH_ASSAY.forecasts.career,
          strength_assay: {
            ...CAREER_ASSAY,
            components: CAREER_ASSAY.components.map((component) =>
              component.id === CAREER_ASSAY.selected_component_id
                ? { ...component, raw: 99 }
                : component,
            ),
          },
        },
      },
    };

    render(
      <DomainsPanel
        domainsCtx={alteredDomains}
        receipts={{ career: receipt }}
        signerPublicKey={key}
      />,
    );

    const evidence = screen.getByTestId('domain-strength-evidence-career');
    expect(await within(evidence).findByText('Failed')).toBeTruthy();
    expect(evidence.textContent).not.toContain('99.00%');
    expect(evidence.textContent).not.toContain('82.50%');
    expect(evidence.textContent).toContain('withheld');
  });

  it('shows Avow as Failed when a present receipt no longer verifies', async () => {
    const seed = generateSeedHex();
    const key = await publicKeyHex(seed);
    const receipt = await signDomainStrength('career', receiptSummary(), seed);
    const tampered = {
      ...receipt,
      payload: {
        ...receipt.payload,
        summary: { ...receipt.payload.summary, strength_pct: 99 },
      },
    };

    render(
      <DomainsPanel
        domainsCtx={DOMAINS_WITH_ASSAY}
        receipts={{ career: tampered }}
        signerPublicKey={key}
      />,
    );

    const avow = screen.getByTestId('domain-avow-career');
    expect(await within(avow).findByText('Failed')).toBeTruthy();
    expect(avow.getAttribute('data-status')).toBe('failed');
  });
});
