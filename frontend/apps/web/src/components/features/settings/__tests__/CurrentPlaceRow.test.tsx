import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getCurrentPlace, useProfilesStore, whenProfilesHydrated } from '@almamesh/store';

import '../../../../i18n/config';
import { installCityTestDatabase } from '../../../../lib/geo/__tests__/cityTestDb';
import { CurrentPlaceRow } from '../CurrentPlaceRow';

installCityTestDatabase();

const NOVATO = {
  summary: { place_ref: 'city:1', label: 'Novato, California, United States', timezone: 'America/Los_Angeles' },
  latitude: 38.10742,
  longitude: -122.5697,
  region: 'California, United States',
};
const NOVATO_PIN = { label: NOVATO.summary.label, timezone: 'America/Los_Angeles', latitude: 38.10742, longitude: -122.5697 };

const input = () => screen.getByTestId('current-place-input') as HTMLInputElement;
const stored = () => {
  const { profiles, activeProfileId } = useProfilesStore.getState();
  return getCurrentPlace(activeProfileId ? profiles[activeProfileId] : undefined);
};
const stubLookup = () => vi.fn(async () => ({ status: 'ambiguous' as const, candidates: [NOVATO] }));

// The real store hydrates from storage asynchronously; let that land before seeding it.
beforeAll(async () => {
  await whenProfilesHydrated();
});

beforeEach(() => {
  act(() => {
    useProfilesStore.setState({ profiles: {}, activeProfileId: null });
    useProfilesStore.getState().createProfile('Ada');
  });
});

afterEach(() => vi.restoreAllMocks());

describe('CurrentPlaceRow ("Where do you live now?")', () => {
  it('starts empty: one labelled box, one muted hint, nothing assumed', () => {
    render(<CurrentPlaceRow lookup={stubLookup()} />);
    expect(screen.getByLabelText('Where do you live now?')).toBe(input());
    expect(input().value).toBe('');
    expect(input().getAttribute('aria-describedby')).toBe('current-place-hint');
    expect(screen.getByTestId('current-place-hint').textContent).toBe('Optional. Stays on this device.');
    expect(screen.queryByTestId('current-place-clear')).toBeNull();
    expect(stored()).toBeUndefined();
  });

  it('picking a suggestion saves it to the person at once', async () => {
    render(<CurrentPlaceRow lookup={stubLookup()} />);
    fireEvent.change(input(), { target: { value: 'novato, ca' } });
    fireEvent.click(await screen.findByTestId('current-place-option-0'));
    expect(stored()).toEqual(NOVATO_PIN);
    expect(input().value).toBe(NOVATO_PIN.label);
    expect(screen.getByTestId('current-place-status').textContent).toBe('Saved');
    expect(screen.queryByTestId('current-place-option-0')).toBeNull();
  });

  it('keyboard: Enter picks the highlighted suggestion', async () => {
    render(<CurrentPlaceRow lookup={stubLookup()} />);
    fireEvent.change(input(), { target: { value: 'novato' } });
    await screen.findByTestId('current-place-option-0');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(stored()).toEqual(NOVATO_PIN);
  });

  it('typing alone saves nothing', async () => {
    const lookup = stubLookup();
    render(<CurrentPlaceRow lookup={lookup} />);
    fireEvent.change(input(), { target: { value: 'novato, ca' } });
    await screen.findByTestId('current-place-option-0');
    expect(stored()).toBeUndefined();
  });

  it('shows a place already set, and Clear removes it', () => {
    act(() => {
      const id = useProfilesStore.getState().activeProfileId!;
      useProfilesStore.getState().setCurrentPlace(id, NOVATO_PIN);
    });
    render(<CurrentPlaceRow lookup={stubLookup()} />);
    expect(input().value).toBe(NOVATO_PIN.label);
    fireEvent.click(screen.getByTestId('current-place-clear'));
    expect(stored()).toBeUndefined();
    expect(input().value).toBe('');
    expect(screen.queryByTestId('current-place-clear')).toBeNull();
  });

  it('editing the text of a saved place keeps it until another is picked or it is cleared', async () => {
    act(() => {
      const id = useProfilesStore.getState().activeProfileId!;
      useProfilesStore.getState().setCurrentPlace(id, NOVATO_PIN);
    });
    render(<CurrentPlaceRow lookup={stubLookup()} />);
    fireEvent.change(input(), { target: { value: 'nov' } });
    expect(stored()).toEqual(NOVATO_PIN);
  });

  it('renders nothing without an active person', () => {
    // Braces: the persisted setState returns its write promise, which act would await forever.
    act(() => {
      useProfilesStore.setState({ profiles: {}, activeProfileId: null });
    });
    const { container } = render(<CurrentPlaceRow lookup={stubLookup()} />);
    expect(container.firstChild).toBeNull();
  });

  it('privacy: searching the on-device list and saving make no network request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(<CurrentPlaceRow />);
    fireEvent.change(input(), { target: { value: 'novato, ca' } });
    fireEvent.click(await screen.findByTestId('current-place-option-0', {}, { timeout: 5_000 }));
    await waitFor(() => expect(stored()?.label).toBe('Novato, California, United States'));
    expect(stored()?.timezone).toBe('America/Los_Angeles');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
