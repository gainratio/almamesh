import i18n from '../../../../i18n/config';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { toTransitCtx } from '@almamesh/store';

import { SKY_CHART } from '../../../../lib/__tests__/timingFixtures';
import { FOUNDER_DASHAS } from '../../../../test/dashaFixtures';
import { formatPinLabel } from '../../../../lib/timeTravelSheet';
import { DashboardMomentCard } from '../DashboardMomentCard';

const MARCH_2025 = { start: '2025-03-01', end: '2025-03-31', granularity: 'month' } as const;
// Crosses the Venus -> Sun antar boundary (2027-01-31) inside the Saturn maha.
const YEAR_2027 = { start: '2027-01-01', end: '2027-12-31', granularity: 'year' } as const;

function text(testId: string): string {
  return screen.getByTestId(testId).textContent ?? '';
}

describe('DashboardMomentCard', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('shows the maha and antar at the moment, from the chart dasha list', () => {
    render(<DashboardMomentCard asOf={MARCH_2025} dashas={FOUNDER_DASHAS} birthYear={1980}
      sky={{ kind: 'dashas-only' }} onRetry={() => {}} language="en" />);
    expect(text('time-travel-moment-maha')).toContain('Saturn');
    expect(text('time-travel-moment-antar')).toContain('Venus');
  });

  it('a year that crosses an antar boundary shows both lords, in order', () => {
    render(<DashboardMomentCard asOf={YEAR_2027} dashas={FOUNDER_DASHAS} birthYear={1980}
      sky={{ kind: 'dashas-only' }} onRetry={() => {}} language="en" />);
    expect(text('time-travel-moment-maha')).toBe('Saturn');
    expect(text('time-travel-moment-antar')).toBe('Venus → Sun');
  });

  it('with no dasha list, shows a dash rather than a guess', () => {
    render(<DashboardMomentCard asOf={MARCH_2025} dashas={undefined} birthYear={undefined}
      sky={{ kind: 'dashas-only' }} onRetry={() => {}} language="en" />);
    expect(text('time-travel-moment-maha')).toBe('—');
    expect(text('time-travel-moment-antar')).toBe('—');
  });

  it('on a weak device, says dashas only (no transits table)', () => {
    render(<DashboardMomentCard asOf={MARCH_2025} dashas={FOUNDER_DASHAS} birthYear={1980}
      sky={{ kind: 'dashas-only' }} onRetry={() => {}} language="en" />);
    expect(text('time-travel-moment-dashas-only')).toContain('dashas only');
    expect(screen.queryByTestId('time-travel-moment-transits')).toBeNull();
  });

  it('while working, names the period in the progress line', () => {
    render(<DashboardMomentCard asOf={MARCH_2025} dashas={FOUNDER_DASHAS} birthYear={1980}
      sky={{ kind: 'working' }} onRetry={() => {}} language="en" />);
    expect(text('time-travel-moment-working').replace(/\s+/g, ' ')).toContain('Working out the sky for March 2025');
  });

  it('a failed compute says so once, offers a Try again button, and the button retries', () => {
    const onRetry = vi.fn();
    render(<DashboardMomentCard asOf={MARCH_2025} dashas={FOUNDER_DASHAS} birthYear={1980}
      sky={{ kind: 'failed' }} onRetry={onRetry} language="en" />);
    const failed = screen.getByTestId('time-travel-moment-failed');
    expect(failed.getAttribute('role')).toBe('alert');
    const button = within(failed).getByRole('button', { name: 'Try again' });
    // The message alone, without the button's label: no second "Try again." sentence.
    const message = (failed.textContent ?? '').replace(button.textContent ?? '', '').trim();
    expect(message).toBe("Couldn't work out the sky for this moment.");
    fireEvent.click(button);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['en', "Couldn't work out the sky for this moment."],
    ['es', 'No se pudo calcular el cielo para este momento.'],
    ['pt', 'Não foi possível calcular o céu para este momento.'],
  ] as const)('the failed line has no trailing "try again" sentence (%s)', async (language, expected) => {
    await i18n.changeLanguage(language);
    expect(i18n.t('dashboard:time_travel.failed')).toBe(expected);
    await i18n.changeLanguage('en');
  });

  it('reads as then, not now: the title is "At that moment"', () => {
    render(<DashboardMomentCard asOf={MARCH_2025} dashas={FOUNDER_DASHAS} birthYear={1980}
      sky={{ kind: 'dashas-only' }} onRetry={() => {}} language="en" />);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('At that moment');
  });

  it.each([
    ['es', 'En ese momento'],
    ['pt', 'Naquele momento'],
  ] as const)('the title reads as then in %s', async (language, expected) => {
    await i18n.changeLanguage(language);
    expect(i18n.t('dashboard:time_travel.moment_title')).toBe(expected);
    await i18n.changeLanguage('en');
  });

  it("the transits section carries no \"Current Sky\" heading of its own", () => {
    const transits = toTransitCtx(SKY_CHART.transit_context);
    if (!transits) throw new Error('fixture has no transits');
    render(<DashboardMomentCard asOf={MARCH_2025} dashas={FOUNDER_DASHAS} birthYear={1980}
      sky={{ kind: 'ready', transits }} onRetry={() => {}} language="en" />);
    const transitsText = text('time-travel-moment-transits');
    expect(transitsText).not.toContain('Current Sky');
    expect(transitsText).not.toContain("today's sky");
    expect(transitsText).not.toMatch(/currently/);
    expect(screen.getByTestId('gochara-table')).not.toBeNull();
  });

  it('one polite live region carries only the short status line, working to ready', () => {
    const transits = toTransitCtx(SKY_CHART.transit_context);
    if (!transits) throw new Error('fixture has no transits');
    const props = { asOf: MARCH_2025, dashas: FOUNDER_DASHAS, birthYear: 1980, onRetry: () => {}, language: 'en' };
    const { rerender } = render(<DashboardMomentCard {...props} sky={{ kind: 'working' }} />);
    const region = screen.getByTestId('time-travel-moment-status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.contains(screen.getByTestId('time-travel-moment-working'))).toBe(true);
    rerender(<DashboardMomentCard {...props} sky={{ kind: 'ready', transits }} />);
    expect(screen.getByTestId('time-travel-moment-status')).toBe(region);
    // A one-line "ready" announcement; the table itself is never inside the live region.
    expect((region.textContent ?? '').replace(/\s+/g, ' ')).toBe('The sky for March 2025 is ready.');
    expect(region.contains(screen.getByTestId('gochara-table'))).toBe(false);
    expect(region.contains(screen.getByTestId('time-travel-moment-transits'))).toBe(false);
  });

  it('a failure is an alert outside the polite region', () => {
    render(<DashboardMomentCard asOf={MARCH_2025} dashas={FOUNDER_DASHAS} birthYear={1980}
      sky={{ kind: 'failed' }} onRetry={() => {}} language="en" />);
    const region = screen.getByTestId('time-travel-moment-status');
    expect(region.contains(screen.getByTestId('time-travel-moment-failed'))).toBe(false);
  });

  it.each([
    ['es', 'El cielo de marzo de 2025 está listo.'],
    ['pt', 'O céu de março de 2025 está pronto.'],
  ] as const)('the ready line is translated (%s)', async (language, expected) => {
    await i18n.changeLanguage(language);
    expect(i18n.t('dashboard:time_travel.sky_ready', { period: formatPinLabel(MARCH_2025, language) })).toBe(expected);
  });

  it('the progress line is the chat\'s own "working" string (one copy, es)', async () => {
    await i18n.changeLanguage('es');
    render(<DashboardMomentCard asOf={MARCH_2025} dashas={FOUNDER_DASHAS} birthYear={1980}
      sky={{ kind: 'working' }} onRetry={() => {}} language="es" />);
    const expected = i18n.t('chat:time_travel.status_working', { period: formatPinLabel(MARCH_2025, 'es') });
    expect(text('time-travel-moment-working').replace(/\s+/g, ' ')).toBe(expected.replace(/\s+/g, ' '));
    expect(i18n.exists('dashboard:time_travel.working')).toBe(false);
    await i18n.changeLanguage('en');
  });

  it('when the sky is ready, shows the transits table and no progress line', () => {
    const transits = toTransitCtx(SKY_CHART.transit_context);
    if (!transits) throw new Error('fixture has no transits');
    render(<DashboardMomentCard asOf={MARCH_2025} dashas={FOUNDER_DASHAS} birthYear={1980}
      sky={{ kind: 'ready', transits }} onRetry={() => {}} language="en" />);
    expect(text('time-travel-moment-transits')).toContain('Planets in the sky then');
    expect(screen.queryByTestId('time-travel-moment-working')).toBeNull();
  });
});
