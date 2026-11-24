import { beforeEach, describe, expect, it } from 'vitest';
import {
  AYANAMSA_PREFERENCE_KEY,
  DEFAULT_AYANAMSA,
  hydrateAyanamsaPreference,
  isSupportedAyanamsa,
  portablePreferenceStorage,
  resetSessionStateForTests,
  SUPPORTED_AYANAMSAS,
  useAyanamsaStore,
} from './index';

describe('useAyanamsaStore', () => {
  beforeEach(() => {
    resetSessionStateForTests();
    useAyanamsaStore.setState({ ayanamsa: DEFAULT_AYANAMSA });
  });

  it('defaults to LAHIRI and validates all 5 supported conventions', () => {
    expect(useAyanamsaStore.getState().ayanamsa).toBe('LAHIRI');
    expect(SUPPORTED_AYANAMSAS).toEqual([
      'LAHIRI',
      'TRUE_CHITRA',
      'RAMAN',
      'KP',
      'FAGAN_BRADLEY',
    ]);
    for (const a of SUPPORTED_AYANAMSAS) {
      expect(isSupportedAyanamsa(a)).toBe(true);
    }
    expect(isSupportedAyanamsa('UNKNOWN')).toBe(false);
  });

  it('persists and rehydrates non-default ayanamsa preferences', async () => {
    useAyanamsaStore.getState().setAyanamsa('KP');
    expect(useAyanamsaStore.getState().ayanamsa).toBe('KP');

    await portablePreferenceStorage.setItem(
      AYANAMSA_PREFERENCE_KEY,
      JSON.stringify({ ayanamsa: 'RAMAN' }),
    );
    const hydrated = await hydrateAyanamsaPreference();
    expect(hydrated).toBe('RAMAN');
    expect(useAyanamsaStore.getState().ayanamsa).toBe('RAMAN');
  });

  it('falls back to LAHIRI on corrupt stored preference', async () => {
    await portablePreferenceStorage.setItem(AYANAMSA_PREFERENCE_KEY, '{not-json');
    const hydrated = await hydrateAyanamsaPreference();
    expect(hydrated).toBe('LAHIRI');
  });
});
