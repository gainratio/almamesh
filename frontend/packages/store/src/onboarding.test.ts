/**
 * Onboarding store — step-order regression.
 *
 * CONTEXT: the UI flow order is name(1) → birth-date(2) → birth-LOCATION(3)
 * → birth-TIME(4) → life-events(5) (Onboarding's STEP_KEYS), and Onboarding
 * syncs its local step key FROM the store's `currentStep` via an effect.
 * `isStepValid` still encoded the pre-reorder numbering (3=time, 4=city),
 * so `nextStep()` leaving the LOCATION step validated the (empty) TIME and
 * silently refused to increment — the store lagged one step behind the UI.
 * The first Continue on the birth-time step then incremented the store to 4
 * and the sync effect yanked the UI straight back to birth-time: the user's
 * first click after typing the time appeared "swallowed" and needed a retry.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';

import { onboardingStoreCreator, type OnboardingStore } from './onboarding';

describe('onboarding store — step validation follows the flow order', () => {
  let store: ReturnType<typeof createStore<OnboardingStore>>;

  beforeEach(() => {
    store = createStore<OnboardingStore>(onboardingStoreCreator);
  });

  it('validates steps in flow order: 1=name, 2=date, 3=location, 4=time', () => {
    const s = store.getState();
    s.setName('Test Native');
    s.setBirthDate(new Date(1990, 0, 15));
    s.setLocation({ city: 'New York', state: 'NY', country: 'US' });
    // No birth time yet: location (3) is valid, time (4) is not.
    expect(store.getState().isStepValid(3)).toBe(true);
    expect(store.getState().isStepValid(4)).toBe(false);

    store.getState().setBirthTime('10:30', 'exact');
    expect(store.getState().isStepValid(4)).toBe(true);
  });

  it('unknown time confidence satisfies the time step (4) without a time', () => {
    expect(store.getState().isStepValid(4)).toBe(false);
    store.getState().setBirthTime('', 'unknown');
    expect(store.getState().isStepValid(4)).toBe(true);
  });

  it('nextStep() walks the whole flow without stalling (the swallowed-Continue regression)', () => {
    const s = store.getState();
    expect(store.getState().currentStep).toBe(1);

    s.setName('Test Native');
    store.getState().nextStep(); // leave name
    expect(store.getState().currentStep).toBe(2);

    s.setBirthDate(new Date(1990, 0, 15));
    store.getState().nextStep(); // leave birth-date
    expect(store.getState().currentStep).toBe(3);

    // Leave LOCATION with NO time entered yet — this is where the old
    // numbering stalled the store (it validated the empty time instead of
    // the city), making the store lag the UI by one step.
    s.setLocation({ city: 'New York', state: 'NY', country: 'US' });
    store.getState().nextStep();
    expect(store.getState().currentStep).toBe(4);

    // First advance off the TIME step must land in one call.
    store.getState().setBirthTime('10:30', 'exact');
    store.getState().nextStep();
    expect(store.getState().currentStep).toBe(5);
  });
});

describe('onboarding store — daylight-saving edges block the time step until resolved', () => {
  let store: ReturnType<typeof createStore<OnboardingStore>>;
  const LA = { city: 'Los Angeles', state: 'CA', country: 'US', latitude: 34.05, longitude: -118.24, timezone: 'America/Los_Angeles' };

  beforeEach(() => {
    store = createStore<OnboardingStore>(onboardingStoreCreator);
    store.getState().setName('Test Native');
    store.getState().setLocation(LA);
  });

  it('rejects a time that never existed (spring-forward gap)', () => {
    store.getState().setBirthDate(new Date(2024, 2, 10));
    store.getState().setBirthTime('02:30', 'exact');
    expect(store.getState().localTimeStatus()).toBe('nonexistent');
    expect(store.getState().isStepValid(4)).toBe(false);
  });

  it('requires a choice for a time that happened twice, then accepts it', () => {
    store.getState().setBirthDate(new Date(2024, 10, 3));
    store.getState().setBirthTime('01:30', 'exact');
    expect(store.getState().localTimeStatus()).toBe('ambiguous');
    expect(store.getState().isStepValid(4)).toBe(false);
    store.getState().setDstFold('later');
    expect(store.getState().isStepValid(4)).toBe(true);
    expect(store.getState().data.dstFold).toBe('later');
  });

  it('drops a stale choice when the time changes', () => {
    store.getState().setBirthDate(new Date(2024, 10, 3));
    store.getState().setBirthTime('01:30', 'exact');
    store.getState().setDstFold('earlier');
    store.getState().setBirthTime('01:45', 'exact');
    expect(store.getState().data.dstFold).toBeUndefined();
    expect(store.getState().isStepValid(4)).toBe(false);
  });

  it('accepts an ordinary time', () => {
    store.getState().setBirthDate(new Date(2024, 0, 10));
    store.getState().setBirthTime('20:00', 'exact');
    expect(store.getState().localTimeStatus()).toBe('unique');
    expect(store.getState().isStepValid(4)).toBe(true);
  });
});
