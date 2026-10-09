import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { useLanguageStore } from '@almamesh/store';
import type { StrengthCtx } from '@almamesh/shared-types';

import '../../../../i18n/config';
import { StrengthPanel } from '../StrengthPanel';
import { hasApproximatedComponents } from '../../../../lib/predictive';
import { ALL_SIGNS, SAV_BINDUS, STRENGTH_CTX } from '../../../../test/predictiveFixtures';

describe('StrengthPanel', () => {
  beforeEach(() => {
    useLanguageStore.setState({ language: 'en' });
  });

  it('shows the SAV grid with one cell per sign and the canonical 337 total', () => {
    render(<StrengthPanel strengthCtx={STRENGTH_CTX} />);
    expect(screen.getByTestId('sav-total').textContent).toContain('337');
    const grid = screen.getByTestId('sav-grid');
    for (const sign of ALL_SIGNS) {
      const label = sign.charAt(0).toUpperCase() + sign.slice(1);
      expect(within(grid).getByText(label)).toBeTruthy();
    }
    // A couple of verbatim bindu values.
    expect(within(grid).getAllByText(String(SAV_BINDUS.aries)).length).toBeGreaterThan(0);
  });

  it('shows per-planet BAV totals', () => {
    render(<StrengthPanel strengthCtx={STRENGTH_CTX} />);
    const card = screen.getByTestId('bav-card');
    expect(within(card).getByText(/39 bindus/)).toBeTruthy();
    expect(within(card).getByText(/56 bindus/)).toBeTruthy();
  });

  it('shows Shadbala rupas against the required minimum with verdict badges', () => {
    render(<StrengthPanel strengthCtx={STRENGTH_CTX} />);
    const table = screen.getByTestId('shadbala-table');
    // Two display decimals — never the engine's raw float (6.128260954302394).
    expect(within(table).getByText('6.13')).toBeTruthy();
    expect(within(table).getByText('4.80')).toBeTruthy();
    expect(table.textContent).not.toContain('6.128260954302394');
    expect(within(table).getByText('Meets minimum')).toBeTruthy();
    expect(within(table).getByText('Below minimum')).toBeTruthy();
  });

  it('surfaces approximated components honestly (footnote + sunrise basis)', () => {
    render(<StrengthPanel strengthCtx={STRENGTH_CTX} />);
    expect(screen.getByTestId('shadbala-approx-note')).toBeTruthy();
    expect(screen.getByText(/local sunrise at the birthplace/)).toBeTruthy();
  });

  it('hasApproximatedComponents detects any flagged component', () => {
    const saturn = STRENGTH_CTX.shadbala.planets.saturn;
    expect(saturn).toBeDefined();
    expect(hasApproximatedComponents(saturn!)).toBe(true);
  });
});

describe('StrengthPanel — the sunrise and weekday are the birthplace\'s', () => {
  beforeEach(() => {
    useLanguageStore.setState({ language: 'en' });
  });

  // Sydney, 2024-01-10: local sunrise 05:48 AEDT is 18:48 UTC on the 9th. The
  // engine awarded Varabala to Mercury (Wednesday).
  const saturn = STRENGTH_CTX.shadbala.planets.saturn!;
  const SYDNEY_CTX: StrengthCtx = {
    ...STRENGTH_CTX,
    sunrise_utc_iso: '2024-01-09T18:48:00+00:00',
    shadbala: {
      planets: {
        ...STRENGTH_CTX.shadbala.planets,
        mercury: {
          ...saturn,
          planet: 'mercury',
          kala: { ...saturn.kala, vara: { virupas: 45, citation: 'BPHS', approximated: false, note: null } },
        },
      },
    },
  };

  it('shows the sunrise on the birthplace calendar and clock, naming the zone', () => {
    render(<StrengthPanel strengthCtx={SYDNEY_CTX} birthTimeZone="Australia/Sydney" />);
    const basis = screen.getByTestId('strength-sunrise-basis').textContent ?? '';
    expect(basis).toMatch(/Jan 10, 2024/);
    expect(basis).toMatch(/5:48/);
    expect(basis).toMatch(/Australia\/Sydney/);
  });

  it('names the weekday lord the engine awarded Varabala to', () => {
    render(<StrengthPanel strengthCtx={SYDNEY_CTX} birthTimeZone="Australia/Sydney" />);
    expect(screen.getByTestId('strength-day-lord').textContent).toMatch(/Mercury/);
  });

  it('labels the sunrise as UTC when the birthplace zone is unknown, never the viewer zone', () => {
    render(<StrengthPanel strengthCtx={SYDNEY_CTX} />);
    const basis = screen.getByTestId('strength-sunrise-basis').textContent ?? '';
    expect(basis).toMatch(/Jan 09, 2024/);
    expect(basis).toMatch(/UTC/);
  });
});

