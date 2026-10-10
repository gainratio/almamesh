/**
 * The banner wraps on narrow screens (380 px). A "·" separator must never start
 * a line: each one stays glued (no-break space) to the item before it.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import '../../../../i18n/config';
import { TimeTravelBanner } from '../TimeTravelBanner';

const DAY_IN_BOGOTA = {
  start: '2026-06-15',
  end: '2026-06-15',
  granularity: 'day',
  place: { label: 'Bogotá, Colombia', timezone: 'America/Bogota', latitude: 4.6097, longitude: -74.0817 },
} as const;

/** A line can break before a "·" when it starts a wrapping item or follows a breakable space. */
const BREAK_BEFORE_SEPARATOR = /^[ \t\n]*·|[ \t\n]·/;

/** Every piece a wrapping (flex-wrap) row can put at the start of a line. */
function wrappingItems(root: HTMLElement): HTMLElement[] {
  const rows = [root, ...root.querySelectorAll<HTMLElement>('*')].filter((el) => el.classList.contains('flex-wrap'));
  return rows.flatMap((row) => [...row.children] as HTMLElement[]);
}

function renderBanner(language: string): HTMLElement {
  render(<TimeTravelBanner asOf={DAY_IN_BOGOTA} language={language} onChange={() => {}} onBack={() => {}} />);
  return screen.getByTestId('time-travel-banner');
}

const MARCH_2019 = { start: '2019-03-01', end: '2019-03-31', granularity: 'month' } as const;

describe('TimeTravelBanner', () => {
  it('takes a testid prefix and its own "about" line for the Dashboard', async () => {
    const { default: i18n } = await import('../../../../i18n/config');
    await i18n.changeLanguage('en');
    render(<TimeTravelBanner asOf={MARCH_2019} language="en" onChange={() => {}} onBack={() => {}}
      testIdPrefix="dashboard-time-travel" about="the cards below are about this moment" />);
    expect(screen.getByTestId('dashboard-time-travel-banner').textContent).toContain('the cards below are about this moment');
    expect(screen.getByTestId('dashboard-time-travel-title').textContent?.replace(/\s+/g, ' ')).toBe('Time travel · March 2019');
    expect(screen.getByTestId('dashboard-time-travel-change')).toBeTruthy();
    expect(screen.getByTestId('dashboard-time-travel-back')).toBeTruthy();
    expect(screen.queryByTestId('time-travel-banner')).toBeNull();
  });

  it.each(['en', 'es', 'pt'])('never lets a separator start a line (%s)', async (language) => {
    const { default: i18n } = await import('../../../../i18n/config');
    await i18n.changeLanguage(language);
    const banner = renderBanner(language);

    const items = wrappingItems(banner);
    expect(items.length).toBeGreaterThan(2);
    expect(items.map((item) => item.textContent ?? '').filter((text) => BREAK_BEFORE_SEPARATOR.test(text))).toEqual([]);
    await i18n.changeLanguage('en');
  });

  it('keeps the title, the place and the period note', () => {
    const banner = renderBanner('en');
    expect(screen.getByTestId('time-travel-title').textContent?.replace(/\u00a0/g, ' ')).toBe('Time travel · June 15, 2026');
    expect(banner.textContent).toContain('Bogotá, Colombia');
    expect(banner.textContent).toContain('answers are about this period');
  });
});
