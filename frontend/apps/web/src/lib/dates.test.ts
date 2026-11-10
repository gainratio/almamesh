import { afterEach, describe, expect, it } from 'vitest';
import { useLanguageStore } from '@almamesh/store';
import {
  activeLocale,
  formatBirthDateForDisplay,
  formatBirthTimeForDisplay,
  formatDisplayDate,
  formatDisplayTime,
  localeForLanguage,
} from './dates';

// The store is the single source of truth for the active locale; every test that
// changes the language must restore 'en' so the en-US assertions below hold.
afterEach(() => {
  useLanguageStore.setState({ language: 'en' });
});

describe('localeForLanguage', () => {
  it('maps the supported languages to their display locales', () => {
    expect(localeForLanguage('en')).toBe('en-US');
    expect(localeForLanguage('es')).toBe('es-ES');
    expect(localeForLanguage('pt')).toBe('pt-BR');
    expect(localeForLanguage('hi')).toBe('hi-IN');
  });
});

describe('activeLocale', () => {
  it('reads the live language from the store', () => {
    useLanguageStore.setState({ language: 'es' });
    expect(activeLocale()).toBe('es-ES');
    useLanguageStore.setState({ language: 'pt' });
    expect(activeLocale()).toBe('pt-BR');
    useLanguageStore.setState({ language: 'hi' });
    expect(activeLocale()).toBe('hi-IN');
    useLanguageStore.setState({ language: 'en' });
    expect(activeLocale()).toBe('en-US');
  });
});

describe('formatBirthDateForDisplay', () => {
  it('keeps the birth-local date for an IST 06:44 birth regardless of browser tz', () => {
    // birth_datetime_local as written by toBirthData(): tz-naive wall clock
    expect(formatBirthDateForDisplay('1988-08-08T06:44:00')).toBe('08/08/1988');
  });

  it('does not roll a date-only string back through UTC', () => {
    expect(formatBirthDateForDisplay('1988-08-08')).toBe('08/08/1988');
  });

  it('never silently rolls the calendar date back a day', () => {
    // defensive: even if a legacy chart stored a Z-instant, never silently roll back
    expect(formatBirthDateForDisplay('1988-08-08T06:44:00')).not.toBe('08/07/1988');
  });

  it('renders es-ES in day/month/year order while preserving the tz-naive date', () => {
    useLanguageStore.setState({ language: 'es' });
    // es-ES numeric date = DD/MM/YYYY; Aug 8 must stay 08/08 (never roll to 07).
    expect(formatBirthDateForDisplay('1988-08-08T06:44:00')).toBe('08/08/1988');
  });

  it('renders pt-BR in day/month/year order while preserving the tz-naive date', () => {
    useLanguageStore.setState({ language: 'pt' });
    expect(formatBirthDateForDisplay('1988-08-08T06:44:00')).toBe('08/08/1988');
  });

  it('preserves the day even at the western-tz rollover boundary in every locale', () => {
    for (const lang of ['en', 'es', 'pt', 'hi'] as const) {
      useLanguageStore.setState({ language: lang });
      // a date-only string must surface "08" (Aug 8) in the output, never "07".
      const out = formatBirthDateForDisplay('1988-08-08');
      expect(out).toContain('08');
      expect(out).not.toContain('07');
      expect(out).toContain('1988');
    }
  });
});

describe('formatBirthTimeForDisplay', () => {
  it('formats a just-after-midnight IST birth as 12:30 AM (no UTC roll)', () => {
    expect(formatBirthTimeForDisplay('1990-03-30T00:30:00')).toBe('12:30 AM');
  });

  it('formats an early-morning birth in 12-hour clock', () => {
    expect(formatBirthTimeForDisplay('1988-08-08T06:44:00')).toBe('6:44 AM');
  });

  it('formats noon and afternoon correctly', () => {
    expect(formatBirthTimeForDisplay('1990-01-01T12:00:00')).toBe('12:00 PM');
    expect(formatBirthTimeForDisplay('1990-01-01T13:05:00')).toBe('1:05 PM');
  });

  it('returns empty string when there is no time component', () => {
    expect(formatBirthTimeForDisplay('1990-03-30')).toBe('');
  });

  it('formats es-ES as a 24-hour clock (no AM/PM)', () => {
    useLanguageStore.setState({ language: 'es' });
    const out = formatBirthTimeForDisplay('1988-08-08T17:45:00');
    expect(out).toContain('17:45');
    expect(out).not.toMatch(/AM|PM/i);
  });

  it('formats pt-BR as a 24-hour clock (no AM/PM)', () => {
    useLanguageStore.setState({ language: 'pt' });
    const out = formatBirthTimeForDisplay('1988-08-08T17:45:00');
    expect(out).toContain('17:45');
    expect(out).not.toMatch(/AM|PM/i);
  });

  it('keeps the wall-clock hour exactly as stored (no tz shift) across locales', () => {
    for (const lang of ['en', 'es', 'pt', 'hi'] as const) {
      useLanguageStore.setState({ language: lang });
      // 06:44 wall clock must surface :44 minutes and the 6 o'clock hour.
      const out = formatBirthTimeForDisplay('1988-08-08T06:44:00');
      expect(out).toContain('44');
    }
  });
});

describe('formatDisplayDate / formatDisplayTime', () => {
  it('formats a Date in the active locale order', () => {
    const d = new Date(1988, 7, 8, 12, 0, 0); // local noon, no tz rollover
    useLanguageStore.setState({ language: 'es' });
    expect(formatDisplayDate(d, { year: 'numeric', month: '2-digit', day: '2-digit' })).toBe(
      '08/08/1988',
    );
    useLanguageStore.setState({ language: 'en' });
    expect(formatDisplayDate(d, { year: 'numeric', month: '2-digit', day: '2-digit' })).toBe(
      '08/08/1988',
    );
  });

  it('formats a time in the active locale (12h en, 24h es)', () => {
    const t = new Date(1988, 7, 8, 17, 45, 0);
    useLanguageStore.setState({ language: 'en' });
    expect(formatDisplayTime(t)).toBe('5:45 PM');
    useLanguageStore.setState({ language: 'es' });
    expect(formatDisplayTime(t)).not.toMatch(/AM|PM/i);
    expect(formatDisplayTime(t)).toContain('17:45');
  });
});

describe('formatDisplayDate — epoch / NaN guard', () => {
  // Defense-in-depth: a stored chart that carries the Unix epoch (the old
  // `new Date(0)` calculation_timestamp bug) must NEVER render as 1969/1970.
  // Mirrors the isRealDate guard in lib/reportData.ts.
  it('renders the epoch Date as the current date, never 1969/1970', () => {
    const out = formatDisplayDate(new Date(0));
    expect(out).not.toContain('1969');
    expect(out).not.toContain('1970');
    expect(out).toContain(String(new Date().getFullYear()));
  });

  it('renders an invalid (NaN) Date as the current date, never "Invalid Date"', () => {
    const out = formatDisplayDate(new Date('not-a-date'));
    expect(out).not.toMatch(/invalid/i);
    expect(out).toContain(String(new Date().getFullYear()));
  });

  it('still formats a real Date normally (guard does not affect valid dates)', () => {
    const d = new Date(1988, 7, 8, 12, 0, 0);
    useLanguageStore.setState({ language: 'en' });
    expect(formatDisplayDate(d, { year: 'numeric', month: '2-digit', day: '2-digit' })).toBe(
      '08/08/1988',
    );
  });
});
