import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import i18next from 'i18next';
import { useLanguageStore } from '@almamesh/store';
import type { TransitCtx } from '@almamesh/shared-types';

import '../../../../i18n/config';
import { TransitsPanel } from '../TransitsPanel';
import { TRANSIT_CTX } from '../../../../test/predictiveFixtures';

describe('TransitsPanel', () => {
  beforeEach(async () => {
    useLanguageStore.setState({ language: 'en' });
    await i18next.changeLanguage('en');
  });

  it('renders the gochara table with localized graha/sign names and houses', () => {
    render(<TransitsPanel transitCtx={TRANSIT_CTX} />);
    const table = screen.getByTestId('gochara-table');
    expect(within(table).getByText('Saturn')).toBeTruthy();
    expect(within(table).getByText('Pisces')).toBeTruthy();
    expect(within(table).getByText('Jupiter')).toBeTruthy();
    // Houses from Moon / Lagna rendered verbatim.
    expect(within(table).getByText('House 3')).toBeTruthy();
    // Retrograde motion labelled.
    expect(within(table).getByText('Retrograde')).toBeTruthy();
  });

  it.each([
    ['en', 'House 1'],
    ['es', 'Casa 1'],
    ['pt', 'Casa 1'],
  ] as const)(
    'keeps Saturn in house 1 from the accepted Pisces Lagna in %s',
    async (language, houseLabel) => {
      useLanguageStore.setState({ language });
      await i18next.changeLanguage(language);
      const { unmount } = render(<TransitsPanel transitCtx={TRANSIT_CTX} />);

      const table = screen.getByTestId('gochara-table');
      const saturnRow = within(table)
        .getByText(language === 'en' ? 'Saturn' : 'Saturno')
        .closest('tr');
      expect(saturnRow).not.toBeNull();
      expect(within(saturnRow as HTMLElement).getByText(houseLabel)).toBeTruthy();
      unmount();
    },
  );

  it('shows the Sade Sati phase, activity badge and dated cycle', () => {
    render(<TransitsPanel transitCtx={TRANSIT_CTX} />);
    expect(screen.getByTestId('sade-sati-active').textContent).toBe('Active');
    expect(screen.getByTestId('sade-sati-phase').textContent).toContain('Peak');
    const cycle = screen.getByTestId('sade-sati-cycle');
    expect(within(cycle).getAllByText(/Saturn in/)).toHaveLength(3);
    // Locale-aware dates (en → "Jan 17, 2023" style), never raw ISO.
    expect(cycle.textContent).toContain('2023');
    expect(cycle.textContent).not.toContain('2023-01-17T');
  });

  it('lists slow hits with their natal points and exact dates', () => {
    render(<TransitsPanel transitCtx={TRANSIT_CTX} />);
    const card = screen.getByTestId('slow-hits-card');
    expect(within(card).getByText(/Saturn → natal Saturn/)).toBeTruthy();
    expect(within(card).getByText(/Jupiter → natal Moon/)).toBeTruthy();
  });

  it('renders the fusion read with reinforcing/afflicting lists and severity', () => {
    render(<TransitsPanel transitCtx={TRANSIT_CTX} />);
    const card = screen.getByTestId('fusion-card');
    expect(within(card).getByText('Saturn')).toBeTruthy();
    expect(within(card).getByText('Mercury')).toBeTruthy();
    expect(within(card).getByText('Jupiter')).toBeTruthy(); // reinforcing
    expect(within(card).getByText('Mars')).toBeTruthy(); // afflicting
    expect(within(card).getByText('-0.5')).toBeTruthy(); // net weight verbatim
  });

  it('renders the 12-month timeline chronologically with human event copy', () => {
    render(<TransitsPanel transitCtx={TRANSIT_CTX} />);
    const timeline = screen.getByTestId('transit-timeline');
    expect(within(timeline).getByText('Jupiter enters Cancer')).toBeTruthy();
    expect(within(timeline).getByText(/Mercury → Ketu/)).toBeTruthy();
  });

  it('renders Rahu and Ketu changing sign at the same instant as two rows, without a key warning', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const base = { ...TRANSIT_CTX.timeline.events[0], kind: 'sign_ingress', from_lord: null, to_lord: null } as const;
    const ctx: TransitCtx = {
      ...TRANSIT_CTX,
      timeline: {
        ...TRANSIT_CTX.timeline,
        events: [
          { ...base, date: '2026-12-03', graha: 'rahu', from_sign: 'aquarius', to_sign: 'capricorn', descriptor: 'rahu.ingress.capricorn' },
          { ...base, date: '2026-12-03', graha: 'ketu', from_sign: 'leo', to_sign: 'cancer', descriptor: 'ketu.ingress.cancer' },
        ],
      },
    };
    render(<TransitsPanel transitCtx={ctx} />);
    expect(screen.getByText('Rahu enters Capricorn')).toBeTruthy();
    expect(screen.getByText('Ketu enters Cancer')).toBeTruthy();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
