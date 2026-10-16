import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { chatAsOfProblem, useProfilesStore } from '@almamesh/store';

import '../../../../i18n/config';
import { TimeTravelSheet } from '../TimeTravelSheet';

/** 2026-10-13: the birth place is a suggestion the person confirms; a test that relies on it taps it. */
function confirmSuggestedPlace(): void {
  const suggestion = screen.queryByTestId('time-travel-where-suggestion');
  if (suggestion) fireEvent.click(suggestion);
}

const CHENNAI = {
  city: 'Chennai', state: 'Tamil Nadu', country: 'India', latitude: 13.08, longitude: 80.27, timezone: 'Asia/Kolkata',
  location_name: 'Chennai, Tamil Nadu, India',
};
const BIRTH_PLACE = { label: 'Chennai, Tamil Nadu, India', timezone: 'Asia/Kolkata', latitude: 13.08, longitude: 80.27 };
const SINGAPORE = { label: 'Singapore', timezone: 'Asia/Singapore', latitude: 1.29, longitude: 103.85 };
const SF = { label: 'San Francisco, United States', timezone: 'America/Los_Angeles', latitude: 37.77, longitude: -122.42 };
const PINS = [
  { as_of: { start: '2019-05-01', end: '2019-05-31', granularity: 'month' as const, place: SINGAPORE }, updated_at: '2026-10-01T00:00:00Z' },
  { as_of: { start: '2027-01-01', end: '2027-01-31', granularity: 'month' as const, place: SF }, updated_at: '2026-10-02T00:00:00Z' },
];

const BOGOTA = {
  summary: { place_ref: 'city:202', label: 'Bogotá, Colombia', timezone: 'America/Bogota' },
  latitude: 4.711,
  longitude: -74.0721,
};

function renderSheet(overrides: Partial<Parameters<typeof TimeTravelSheet>[0]> = {}) {
  const onGo = vi.fn(async () => undefined);
  const lookupPlace = vi.fn(async () => ({ status: 'found' as const, place: BOGOTA }));
  const view = render(
    <TimeTravelSheet open today="2026-10-09" birthYear={1990} dayAllowed birthLocation={CHENNAI} onGo={onGo} onClose={vi.fn()} lookupPlace={lookupPlace} {...overrides} />,
  );
  return { onGo, lookupPlace, rerender: view.rerender };
}

async function pickBogota() {
  fireEvent.change(screen.getByTestId('time-travel-where-input'), { target: { value: 'Bogotá' } });
  fireEvent.click(await screen.findByTestId('time-travel-where-option-0'));
}

const go = () => screen.getByTestId('time-travel-go') as HTMLButtonElement;
const whereValue = () => (screen.getByTestId('time-travel-where-input') as HTMLInputElement).value;

describe('TimeTravelSheet', () => {
  it('shows the intro it is given, else the chat copy', () => {
    const view = renderSheet({ intro: 'Custom words.' });
    expect(screen.getByTestId('time-travel-sheet').textContent).toContain('Custom words.');
    expect(screen.getByTestId('time-travel-sheet').textContent).not.toContain('new chat');
    view.rerender(<TimeTravelSheet open today="2026-10-09" birthYear={1990} dayAllowed onGo={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByTestId('time-travel-sheet').textContent).toContain('new chat');
  });

  // Contract reversed 2026-10-13 (Harish's trip came out as his birth place, silently): with no
  // earlier trip, "Where?" is empty and asks where they lived, offering the birth place to CONFIRM.
  it('opens on Month; with no earlier trip it asks where they were living and offers the birth place to confirm', () => {
    renderSheet();
    expect(screen.getByTestId('time-travel-tab-month').getAttribute('aria-selected')).toBe('true');
    expect((screen.getByTestId('time-travel-month') as HTMLSelectElement).value).toBe('10');
    expect(screen.getByTestId('time-travel-where')).toBeTruthy();
    expect(whereValue()).toBe('');
    expect(screen.getByTestId('time-travel-where-question').textContent).toBe('Where were you living then?');
    expect(screen.getByTestId('time-travel-where-suggestion').textContent).toBe('Use Chennai, Tamil Nadu, India (your birth place)');
    expect(screen.queryByTestId('time-travel-where-prefilled')).toBeNull();
    expect(go().disabled).toBe(true);
  });

  it('confirming the birth-place suggestion fills "Where?" and enables Go', () => {
    renderSheet();
    fireEvent.click(screen.getByTestId('time-travel-where-suggestion'));
    expect(whereValue()).toBe('Chennai, Tamil Nadu, India');
    expect(screen.queryByTestId('time-travel-where-suggestion')).toBeNull();
    expect(go().disabled).toBe(false);
  });

  // Contract reversed (plan 2026-10-13 §2): a Year pin carries its place.
  it('Year 2027 → Go opens a pin for all of 2027 at the confirmed place', async () => {
    const { onGo } = renderSheet();
    fireEvent.click(screen.getByTestId('time-travel-tab-year'));
    expect(screen.getByTestId('time-travel-where')).toBeTruthy();
    fireEvent.change(screen.getByTestId('time-travel-year'), { target: { value: '2027' } });
    fireEvent.click(screen.getByTestId('time-travel-where-suggestion'));
    confirmSuggestedPlace();
    fireEvent.click(go());
    await waitFor(() => expect(onGo).toHaveBeenCalledWith({ start: '2027-01-01', end: '2027-12-31', granularity: 'year', place: BIRTH_PLACE }));
  });

  it('keeps Go disabled on Month and Year until there is a place', async () => {
    renderSheet({ birthLocation: undefined });
    expect(whereValue()).toBe('');
    expect(screen.getByTestId('time-travel-where-required').textContent).toBe('Pick where you were (or will be) at that time.');
    expect(screen.queryByTestId('time-travel-where-prefilled')).toBeNull();
    expect(go().disabled).toBe(true);
    fireEvent.click(screen.getByTestId('time-travel-tab-year'));
    expect(go().disabled).toBe(true);
    await pickBogota();
    expect(go().disabled).toBe(false);
  });

  it('prefills the place of the pin nearest the chosen date, and follows the date', async () => {
    const { onGo } = renderSheet({ pins: PINS });
    fireEvent.change(screen.getByTestId('time-travel-month-year'), { target: { value: '2019' } });
    fireEvent.change(screen.getByTestId('time-travel-month'), { target: { value: '08' } });
    expect(whereValue()).toBe('Singapore');
    fireEvent.change(screen.getByTestId('time-travel-month-year'), { target: { value: '2028' } });
    expect(whereValue()).toBe('San Francisco, United States');
    confirmSuggestedPlace();
    fireEvent.click(go());
    await waitFor(() => expect(onGo).toHaveBeenCalledWith({ start: '2028-08-01', end: '2028-08-31', granularity: 'month', place: SF }));
  });

  it('keeps a place the user picked when the date changes', async () => {
    const { onGo } = renderSheet({ pins: PINS });
    await pickBogota();
    fireEvent.change(screen.getByTestId('time-travel-month-year'), { target: { value: '2019' } });
    fireEvent.change(screen.getByTestId('time-travel-month'), { target: { value: '05' } });
    expect(whereValue()).toBe('Bogotá, Colombia');
    expect(screen.queryByTestId('time-travel-where-prefilled')).toBeNull();
    confirmSuggestedPlace();
    fireEvent.click(go());
    await waitFor(() => expect(onGo).toHaveBeenCalledWith(expect.objectContaining({ place: expect.objectContaining({ label: 'Bogotá, Colombia' }) })));
  });

  it('does not refill a place the user cleared', () => {
    renderSheet({ pins: PINS });
    fireEvent.change(screen.getByTestId('time-travel-where-input'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('time-travel-month-year'), { target: { value: '2019' } });
    expect(whereValue()).toBe('');
    expect(go().disabled).toBe(true);
  });

  // Contract narrowed (plan 2026-10-13 §2): Day starts empty only when there is no pin or birth place to prefill.
  it('Day shows an empty, required "Where?" (nothing to prefill) that searches only what the user types', async () => {
    const { onGo, lookupPlace } = renderSheet({ birthLocation: undefined });
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
    confirmSuggestedPlace();
    fireEvent.click(go());
    await waitFor(() =>
      expect(onGo).toHaveBeenCalledWith({
        start: '2026-06-15', end: '2026-06-15', granularity: 'day',
        place: { label: 'Bogotá, Colombia', timezone: 'America/Bogota', latitude: 4.711, longitude: -74.0721 },
      }),
    );
  });

  // Contract reversed 2026-10-13: the birth place is never a silent default, on Day either.
  it('Day with no nearer pin offers the birth place as a suggestion, not a prefill', () => {
    renderSheet();
    fireEvent.click(screen.getByTestId('time-travel-tab-day'));
    expect(whereValue()).toBe('');
    expect(screen.getByTestId('time-travel-where-suggestion')).toBeTruthy();
    expect(go().disabled).toBe(true);
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
    confirmSuggestedPlace();
    fireEvent.click(go());
    expect(await screen.findByTestId('time-travel-save-failed')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('emits only pins that pass the strict store validator (a Month pin with its place)', async () => {
    const { onGo } = renderSheet();
    confirmSuggestedPlace();
    fireEvent.click(go());
    await waitFor(() => expect(onGo).toHaveBeenCalled());
    const [pin] = onGo.mock.calls[0] as unknown as [unknown];
    expect(chatAsOfProblem(pin)).toBeUndefined();
  });

  it('emits a Day pin with a place that passes the strict store validator', async () => {
    const { onGo } = renderSheet();
    fireEvent.click(screen.getByTestId('time-travel-tab-day'));
    await pickBogota();
    confirmSuggestedPlace();
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

  it('keeps Go disabled for a typed Day outside the sheet years', async () => {
    renderSheet({ birthYear: undefined });
    fireEvent.click(screen.getByTestId('time-travel-tab-day'));
    await pickBogota();
    for (const day of ['2060-05-01', '1850-01-01', '0001-01-01']) {
      fireEvent.change(screen.getByTestId('time-travel-day'), { target: { value: day } });
      expect(go().disabled).toBe(true);
    }
    fireEvent.change(screen.getByTestId('time-travel-day'), { target: { value: '2052-12-31' } });
    expect(go().disabled).toBe(false);
    fireEvent.change(screen.getByTestId('time-travel-day'), { target: { value: '1900-01-01' } });
    expect(go().disabled).toBe(false);
  });

  it('refuses 1989-12-31 but allows 1990-01-01 for a 1990 birth year', async () => {
    renderSheet();
    fireEvent.click(screen.getByTestId('time-travel-tab-day'));
    await pickBogota();
    fireEvent.change(screen.getByTestId('time-travel-day'), { target: { value: '1989-12-31' } });
    expect(screen.getByTestId('time-travel-before-birth')).toBeTruthy();
    expect(go().disabled).toBe(true);
    fireEvent.change(screen.getByTestId('time-travel-day'), { target: { value: '1990-01-01' } });
    expect(screen.queryByTestId('time-travel-before-birth')).toBeNull();
    expect(go().disabled).toBe(false);
  });

  it('wraps Tab at the end and Shift+Tab at the start of the sheet', () => {
    renderSheet();
    confirmSuggestedPlace(); // Go is the last focusable control once a place is set.
    const dialog = screen.getByRole('dialog');
    const cancel = screen.getByTestId('time-travel-go');
    cancel.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByTestId('time-travel-tab-month'));
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByTestId('time-travel-go'));
  });

  it('distinguishes an unavailable lookup from no matches and retries the same query', async () => {
    const lookupPlace = vi.fn()
      .mockRejectedValueOnce(new Error('city list failed'))
      .mockResolvedValueOnce({ status: 'found', place: BOGOTA });
    renderSheet({ lookupPlace });
    fireEvent.click(screen.getByTestId('time-travel-tab-day'));
    fireEvent.change(screen.getByTestId('time-travel-where-input'), { target: { value: 'Bogotá' } });
    expect(await screen.findByTestId('time-travel-where-failed')).toBeTruthy();
    expect(screen.queryByTestId('time-travel-where-none')).toBeNull();
    fireEvent.click(screen.getByTestId('time-travel-where-retry'));
    expect((await screen.findByTestId('time-travel-where-option-0')).textContent).toContain('Bogotá');
    expect(lookupPlace.mock.calls).toEqual([['Bogotá'], ['Bogotá']]);
    expect(screen.queryByTestId('time-travel-where-failed')).toBeNull();
  });

  it('clears stale "none found" when the query is cleared', async () => {
    renderSheet({ lookupPlace: vi.fn(async () => ({ status: 'not_found' as const })) });
    fireEvent.click(screen.getByTestId('time-travel-tab-day'));
    fireEvent.change(screen.getByTestId('time-travel-where-input'), { target: { value: 'Atlantis' } });
    await screen.findByTestId('time-travel-where-none');
    fireEvent.change(screen.getByTestId('time-travel-where-input'), { target: { value: 'A' } });
    await waitFor(() => expect(screen.queryByTestId('time-travel-where-none')).toBeNull());
  });

  it('ignores Escape while saving and clears the save error on reopen', async () => {
    let release: () => void = () => undefined;
    const onGo = vi.fn(() => new Promise<void>((resolveGo) => { release = resolveGo; }));
    const onClose = vi.fn();
    renderSheet({ onGo, onClose });
    confirmSuggestedPlace();
    fireEvent.click(go());
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    release();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('clears an old save error when the sheet reopens', async () => {
    const onGo = vi.fn(async () => Promise.reject(new Error('x')));
    const view = renderSheet({ onGo });
    confirmSuggestedPlace();
    fireEvent.click(go());
    await screen.findByTestId('time-travel-save-failed');
    view.rerender(<TimeTravelSheet open={false} today="2026-10-09" onGo={onGo} onClose={vi.fn()} />);
    view.rerender(<TimeTravelSheet open today="2026-10-09" dayAllowed onGo={onGo} onClose={vi.fn()} />);
    expect(screen.queryByTestId('time-travel-save-failed')).toBeNull();
  });

  it('joins tabs to a tabpanel', () => {
    renderSheet();
    const tab = screen.getByTestId('time-travel-tab-month');
    const panel = screen.getByRole('tabpanel');
    expect(tab.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('aria-labelledby')).toBe(tab.id);
  });

  it('prefills Change from the current pin', () => {
    renderSheet({ current: { start: '2027-01-01', end: '2027-12-31', granularity: 'year' } });
    expect(screen.getByTestId('time-travel-tab-year').getAttribute('aria-selected')).toBe('true');
    expect((screen.getByTestId('time-travel-year') as HTMLSelectElement).value).toBe('2027');
  });

  it('keeps the picked value when Change fails, even if the pin identity flips and rolls back', async () => {
    const pin = { start: '2027-01-01', end: '2027-12-31', granularity: 'year' as const };
    let rerenderWith: (current: typeof pin) => void = () => undefined;
    const onGo = vi.fn(async () => {
      rerenderWith({ ...pin, start: '2030-01-01', end: '2030-12-31' });
      rerenderWith({ ...pin });
      throw new Error('Saving chat failed.');
    });
    const view = renderSheet({ current: pin, onGo });
    rerenderWith = (current) => view.rerender(
      <TimeTravelSheet open today="2026-10-09" birthYear={1990} dayAllowed current={current} onGo={onGo} onClose={vi.fn()} />,
    );
    fireEvent.change(screen.getByTestId('time-travel-year'), { target: { value: '2030' } });
    confirmSuggestedPlace();
    fireEvent.click(go());
    expect(await screen.findByTestId('time-travel-save-failed')).toBeTruthy();
    expect((screen.getByTestId('time-travel-year') as HTMLSelectElement).value).toBe('2030');
  });

  it('Change says the next answers in this chat will be about the new period', () => {
    renderSheet({ current: { start: '2027-01-01', end: '2027-12-31', granularity: 'year' } });
    expect(screen.getByText('Pick a new period. This chat\'s next answers will be about it.')).toBeTruthy();
    expect(screen.queryByText(/in the new chat/)).toBeNull();
  });

  it('starts Change on the nearest allowed year for an imported pin outside the list', () => {
    const view = renderSheet({ current: { start: '2099-01-01', end: '2099-12-31', granularity: 'year' } });
    expect((screen.getByTestId('time-travel-year') as HTMLSelectElement).value).toBe('2052');
    const before = { start: '1950-03-01', end: '1950-03-31', granularity: 'month' as const };
    view.rerender(<TimeTravelSheet open={false} today="2026-10-09" birthYear={2000} dayAllowed current={before} onGo={vi.fn()} onClose={vi.fn()} />);
    view.rerender(<TimeTravelSheet open today="2026-10-09" birthYear={2000} dayAllowed current={before} onGo={vi.fn()} onClose={vi.fn()} />);
    expect((screen.getByTestId('time-travel-month-year') as HTMLSelectElement).value).toBe('2000');
  });

  it('Go saves the clamped year the select shows', async () => {
    const { onGo } = renderSheet({ current: { start: '2099-01-01', end: '2099-12-31', granularity: 'year' } });
    fireEvent.click(screen.getByTestId('time-travel-where-suggestion'));
    confirmSuggestedPlace();
    fireEvent.click(go());
    await waitFor(() => expect(onGo).toHaveBeenCalledWith({ start: '2052-01-01', end: '2052-12-31', granularity: 'year', place: BIRTH_PLACE }));
  });

  it('loads the city list lazily, from the offline lookup only (source contract)', () => {
    const source = readFileSync(resolve(__dirname, '../PlacePicker.tsx'), 'utf8');
    expect(source).toContain("import('../../../lib/geo/placeLookup')");
    expect(source).not.toMatch(/^import (?!type )[^\n]*from '\.\.\/\.\.\/\.\.\/lib\/geo\/(placeLookup|cityLookup)'/m);
    expect(source).not.toContain('searchCities(');
    expect(source).not.toContain('onlineGeocoder');
  });
});

describe('TimeTravelSheet: where you live now', () => {
  const NOVATO_PIN = { label: 'Novato, California, United States', timezone: 'America/Los_Angeles', latitude: 38.10742, longitude: -122.5697 };

  function livingIn(place: typeof NOVATO_PIN | undefined): void {
    act(() => {
      useProfilesStore.setState({ profiles: {}, activeProfileId: null });
      const id = useProfilesStore.getState().createProfile('Ada');
      if (place) useProfilesStore.getState().setCurrentPlace(id, place);
    });
  }

  afterEach(() => livingIn(undefined));

  it('unset: only the birth place is offered, exactly as before', () => {
    livingIn(undefined);
    renderSheet();
    expect(screen.queryByTestId('time-travel-where-home')).toBeNull();
    expect(screen.getByTestId('time-travel-where-suggestion')).toBeTruthy();
  });

  it('set: offers it as a one-click suggestion next to the birth place, never pre-filled', () => {
    livingIn(NOVATO_PIN);
    renderSheet();
    expect(whereValue()).toBe('');
    expect(screen.getByTestId('time-travel-where-home').textContent).toBe('Use Novato, California, United States (where you live now)');
    expect(screen.getByTestId('time-travel-where-suggestion')).toBeTruthy();
    expect(go().disabled).toBe(true);
  });

  it('one click on it fills "Where?" with that place and enables Go', async () => {
    livingIn(NOVATO_PIN);
    const { onGo } = renderSheet();
    fireEvent.click(screen.getByTestId('time-travel-where-home'));
    expect(whereValue()).toBe(NOVATO_PIN.label);
    expect(screen.queryByTestId('time-travel-where-home')).toBeNull();
    fireEvent.click(go());
    await waitFor(() => expect(onGo).toHaveBeenCalledWith(expect.objectContaining({ place: NOVATO_PIN })));
  });

  it('when home is the birth place, it is offered once', () => {
    livingIn(BIRTH_PLACE);
    renderSheet();
    expect(screen.getByTestId('time-travel-where-home')).toBeTruthy();
    expect(screen.queryByTestId('time-travel-where-suggestion')).toBeNull();
  });

  it('an earlier trip still prefills; the home suggestion steps aside', () => {
    livingIn(NOVATO_PIN);
    renderSheet({ pins: PINS });
    expect(whereValue()).toBe('San Francisco, United States');
    expect(screen.queryByTestId('time-travel-where-home')).toBeNull();
  });
});
