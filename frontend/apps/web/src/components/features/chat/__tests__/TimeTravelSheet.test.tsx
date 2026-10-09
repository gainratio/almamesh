import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { chatAsOfProblem } from '@almamesh/store';

import '../../../../i18n/config';
import { TimeTravelSheet } from '../TimeTravelSheet';

const BOGOTA = {
  summary: { place_ref: 'city:202', label: 'Bogotá, Colombia', timezone: 'America/Bogota' },
  latitude: 4.711,
  longitude: -74.0721,
};

function renderSheet(overrides: Partial<Parameters<typeof TimeTravelSheet>[0]> = {}) {
  const onGo = vi.fn(async () => undefined);
  const lookupPlace = vi.fn(async () => ({ status: 'found' as const, place: BOGOTA }));
  render(
    <TimeTravelSheet open today="2026-10-09" birthYear={1990} dayAllowed onGo={onGo} onClose={vi.fn()} lookupPlace={lookupPlace} {...overrides} />,
  );
  return { onGo, lookupPlace };
}

const go = () => screen.getByTestId('time-travel-go') as HTMLButtonElement;

describe('TimeTravelSheet', () => {
  it('opens on Month with the current month and no "Where?"', () => {
    renderSheet();
    expect(screen.getByTestId('time-travel-tab-month').getAttribute('aria-selected')).toBe('true');
    expect((screen.getByTestId('time-travel-month') as HTMLSelectElement).value).toBe('10');
    expect(screen.queryByTestId('time-travel-where')).toBeNull();
  });

  it('Year 2027 → Go opens a pin for all of 2027; there is no "Where?"', async () => {
    const { onGo } = renderSheet();
    fireEvent.click(screen.getByTestId('time-travel-tab-year'));
    expect(screen.queryByTestId('time-travel-where')).toBeNull();
    fireEvent.change(screen.getByTestId('time-travel-year'), { target: { value: '2027' } });
    fireEvent.click(go());
    await waitFor(() => expect(onGo).toHaveBeenCalledWith({ start: '2027-01-01', end: '2027-12-31', granularity: 'year' }));
  });

  it('Day shows an empty, required "Where?" that searches only what the user types', async () => {
    const { onGo, lookupPlace } = renderSheet();
    fireEvent.click(screen.getByTestId('time-travel-tab-day'));
    expect((screen.getByTestId('time-travel-where-input') as HTMLInputElement).value).toBe('');
    expect(screen.getByTestId('time-travel-where-required')).toBeTruthy();
    expect(go().disabled).toBe(true);
    expect(lookupPlace).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('time-travel-day'), { target: { value: '2026-06-15' } });
    fireEvent.change(screen.getByTestId('time-travel-where-input'), { target: { value: 'Bogotá' } });
    await waitFor(() => expect(lookupPlace).toHaveBeenCalledWith('Bogotá'));
    fireEvent.click(await screen.findByTestId('time-travel-where-option-0'));
    expect(go().disabled).toBe(false);
    fireEvent.click(go());
    await waitFor(() =>
      expect(onGo).toHaveBeenCalledWith({
        start: '2026-06-15', end: '2026-06-15', granularity: 'day',
        place: { label: 'Bogotá, Colombia', timezone: 'America/Bogota', latitude: 4.711, longitude: -74.0721 },
      }),
    );
  });

  it('says so when no city matches', async () => {
    renderSheet({ lookupPlace: vi.fn(async () => ({ status: 'not_found' as const })) });
    fireEvent.click(screen.getByTestId('time-travel-tab-day'));
    fireEvent.change(screen.getByTestId('time-travel-where-input'), { target: { value: 'Atlantis' } });
    expect(await screen.findByTestId('time-travel-where-none')).toBeTruthy();
  });

  it('has no Day tab on a weak device', () => {
    renderSheet({ dayAllowed: false });
    expect(screen.queryByTestId('time-travel-tab-day')).toBeNull();
  });

  it('refuses a day before the birth year in plain words, without naming the birth date', async () => {
    renderSheet();
    fireEvent.click(screen.getByTestId('time-travel-tab-day'));
    fireEvent.change(screen.getByTestId('time-travel-day'), { target: { value: '1989-06-01' } });
    const message = screen.getByTestId('time-travel-before-birth').textContent ?? '';
    expect(message).toBe("That's before you were born. Pick a later period.");
    expect(go().disabled).toBe(true);
  });

  it('keeps the sheet open and says so when the pin could not be saved', async () => {
    const onClose = vi.fn();
    renderSheet({ onGo: vi.fn(async () => Promise.reject(new Error('Saving chat failed.'))), onClose });
    fireEvent.click(go());
    expect(await screen.findByTestId('time-travel-save-failed')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('emits only pins that pass the strict store validator', async () => {
    const { onGo } = renderSheet();
    fireEvent.click(go());
    await waitFor(() => expect(onGo).toHaveBeenCalled());
    const [pin] = onGo.mock.calls[0] as unknown as [unknown];
    expect(chatAsOfProblem(pin)).toBeUndefined();
  });

  it('is a labelled modal dialog that takes focus, closes on Escape and arrow-keys between tabs', () => {
    const onClose = vi.fn();
    renderSheet({ onClose });
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByTestId('time-travel-tab-month'));
    fireEvent.keyDown(screen.getByTestId('time-travel-tab-month'), { key: 'ArrowRight' });
    expect(screen.getByTestId('time-travel-tab-year').getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('prefills Change from the current pin', () => {
    renderSheet({ current: { start: '2027-01-01', end: '2027-12-31', granularity: 'year' } });
    expect(screen.getByTestId('time-travel-tab-year').getAttribute('aria-selected')).toBe('true');
    expect((screen.getByTestId('time-travel-year') as HTMLSelectElement).value).toBe('2027');
  });

  it('loads the city list lazily, from the offline lookup only (source contract)', () => {
    const source = readFileSync(resolve(__dirname, '../PlacePicker.tsx'), 'utf8');
    expect(source).toContain("import('../../../lib/geo/placeLookup')");
    expect(source).not.toMatch(/^import (?!type )[^\n]*from '\.\.\/\.\.\/\.\.\/lib\/geo\/(placeLookup|cityLookup)'/m);
    expect(source).not.toContain('searchCities(');
    expect(source).not.toContain('onlineGeocoder');
  });
});
