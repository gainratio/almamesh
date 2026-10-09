/**
 * Onboarding Store - Zustand state for onboarding flow (in-memory, no persistence)
 *
 * Spec 036 (Cache Consolidation): Removed persist middleware.
 * Onboarding status is fetched from API endpoint /users/me/onboarding-status.
 * Each step triggers an optional save callback for incremental backend saves.
 */

import { create, StateCreator } from 'zustand';
import type { TimeConfidence } from '@almamesh/constants';
import { safeError } from '@almamesh/shared-types';
import { type DstFold, resolveLocalTime } from './adapters/localBirthTime';

/**
 * Format a Date as YYYY-MM-DD in LOCAL timezone (not UTC)
 * IMPORTANT: Do NOT use toISOString().split('T')[0] as it converts to UTC
 * which can shift dates by a day depending on timezone
 */
function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Callback type for saving onboarding progress after each step.
 * This is called after each step completion for incremental backend saves.
 */
export type OnboardingSaveCallback = (data: OnboardingData, step: number) => Promise<void>;

/** How the entered local birth time maps onto real instants. */
export type LocalTimeStatus = 'incomplete' | 'unique' | 'nonexistent' | 'ambiguous';

/** The placeholder clock an unknown birth time is computed at (the UI promises noon). */
export const UNKNOWN_TIME_CLOCK = '12:00';

/**
 * The clock the chart is computed for: noon when the time is unknown (never a
 * stale typed value), else the entered time.
 */
function effectiveClock(data: OnboardingData): string {
  return data.timeConfidence === 'unknown' ? UNKNOWN_TIME_CLOCK : data.birthTime;
}

function localTimeStatusOf(data: OnboardingData): LocalTimeStatus {
  const clock = effectiveClock(data);
  if (!data.birthDate || clock.length < 4 || !data.timezone) return 'incomplete';
  try {
    return resolveLocalTime(formatLocalDate(data.birthDate), clock, data.timezone).kind;
  } catch {
    return 'incomplete'; // malformed clock or unknown zone: other checks own that
  }
}

function isResolvedLocalTime(status: LocalTimeStatus, fold: DstFold | undefined): boolean {
  if (status === 'nonexistent') return false;
  return status !== 'ambiguous' || fold !== undefined;
}

export interface OnboardingData {
  // Step 1: Name
  name: string;

  // Step 2: Birth Date
  birthDate: Date | null;

  // Step 3: Birth Time
  birthTime: string; // HH:MM format
  timeConfidence: TimeConfidence;
  /**
   * Which occurrence of a DST fall-back hour the birth was in. Set only by the
   * user's explicit choice; cleared whenever date, time or place changes.
   */
  dstFold?: DstFold;

  // Step 4: Birth Location
  city: string;
  state: string;
  country: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;

  // Step 5: Preferences (optional)
  interests: string[];

  // Rectification (if time unknown)
  needsRectification: boolean;
  rectificationSessionId?: string;
}

export interface OnboardingStore {
  // State
  currentStep: number;
  data: OnboardingData;
  isLoading: boolean;
  error: string | null;
  isSaving: boolean;
  lastSavedStep: number;

  // Save callback (set by platform-specific code)
  _saveCallback: OnboardingSaveCallback | null;
  setSaveCallback: (callback: OnboardingSaveCallback | null) => void;

  // Navigation
  nextStep: () => void;
  prevStep: () => void;
  goToStep: (step: number) => void;

  // Data updates with optional save
  setName: (name: string) => void;
  setBirthDate: (date: Date) => void;
  setBirthTime: (time: string, confidence: TimeConfidence) => void;
  setDstFold: (fold: DstFold) => void;
  /** Whether the entered local time maps to one, zero or two instants. */
  localTimeStatus: () => LocalTimeStatus;
  setLocation: (location: {
    city: string;
    state: string;
    country: string;
    latitude?: number;
    longitude?: number;
    timezone?: string;
  }) => void;
  setInterests: (interests: string[]) => void;
  setRectificationSession: (sessionId: string) => void;

  // Incremental save - call after each step completion
  saveProgress: () => Promise<void>;

  // Load saved progress (for resume functionality)
  loadProgress: (data: Partial<OnboardingData>, step: number) => void;

  // Utils
  reset: () => void;
  setError: (error: string | null) => void;
  setLoading: (loading: boolean) => void;
  isStepValid: (step: number) => boolean;
  getFormattedBirthData: () => {
    name: string;
    date: string;
    time: string;
    latitude: number;
    longitude: number;
    location_name?: string;
    timezone?: string;
    is_primary?: boolean;
  } | null;
}

const initialData: OnboardingData = {
  name: '',
  birthDate: null,
  birthTime: '',
  timeConfidence: 'exact',
  city: '',
  state: '',
  country: '',
  interests: [],
  needsRectification: false,
};

/**
 * Onboarding store state creator
 * Supports incremental save callbacks for backend sync.
 */
export const onboardingStoreCreator: StateCreator<OnboardingStore> = (set, get) => ({
  // Initial state
  currentStep: 1,
  data: initialData,
  isLoading: false,
  error: null,
  isSaving: false,
  lastSavedStep: 0,

  // Save callback management
  _saveCallback: null,
  setSaveCallback: (callback) => set({ _saveCallback: callback }),

  // Navigation - now triggers save on step advance
  nextStep: () => {
    const { currentStep, isStepValid, saveProgress } = get();
    if (isStepValid(currentStep)) {
      set({ currentStep: currentStep + 1, error: null });
      // Fire and forget save - don't block navigation
      saveProgress().catch((err) => {
        safeError('onboarding.progress_save_failed', err);
      });
    }
  },

  prevStep: () => {
    const { currentStep } = get();
    if (currentStep > 1) {
      set({ currentStep: currentStep - 1, error: null });
    }
  },

  goToStep: (step: number) => {
    set({ currentStep: step, error: null });
  },

  // Data updates
  setName: (name: string) => {
    set((state) => ({
      data: { ...state.data, name },
      error: null,
    }));
  },

  setBirthDate: (date: Date) => {
    set((state) => ({
      data: { ...state.data, birthDate: date, dstFold: undefined },
      error: null,
    }));
  },

  setBirthTime: (time: string, confidence: TimeConfidence) => {
    const needsRectification = confidence === 'unknown';
    set((state) => ({
      data: {
        ...state.data,
        birthTime: time,
        timeConfidence: confidence,
        needsRectification,
        dstFold: undefined,
      },
      error: null,
    }));
  },

  setLocation: (location) => {
    set((state) => ({
      data: { ...state.data, ...location, dstFold: undefined },
      error: null,
    }));
  },

  setDstFold: (fold: DstFold) => {
    set((state) => ({ data: { ...state.data, dstFold: fold }, error: null }));
  },

  localTimeStatus: () => localTimeStatusOf(get().data),

  setInterests: (interests: string[]) => {
    set((state) => ({
      data: { ...state.data, interests },
      error: null,
    }));
  },

  setRectificationSession: (sessionId: string) => {
    set((state) => ({
      data: { ...state.data, rectificationSessionId: sessionId },
    }));
  },

  // Incremental save to backend
  saveProgress: async () => {
    const { _saveCallback, data, currentStep, isSaving, lastSavedStep } = get();

    // Skip if no callback, already saving, or already saved this step
    if (!_saveCallback || isSaving || currentStep <= lastSavedStep) {
      return;
    }

    set({ isSaving: true });

    try {
      await _saveCallback(data, currentStep);
      set({ lastSavedStep: currentStep, isSaving: false });
    } catch (error) {
      safeError('onboarding.save_failed', error);
      set({ isSaving: false });
      // Don't throw - save failures shouldn't block onboarding
    }
  },

  // Load saved progress for resume functionality
  loadProgress: (savedData: Partial<OnboardingData>, step: number) => {
    set((state) => ({
      data: { ...state.data, ...savedData },
      currentStep: step,
      lastSavedStep: step - 1, // Mark previous steps as saved
    }));
  },

  // Utils
  reset: () => {
    set({
      currentStep: 1,
      data: initialData,
      isLoading: false,
      error: null,
      isSaving: false,
      lastSavedStep: 0,
    });
  },

  setError: (error: string | null) => set({ error }),

  setLoading: (loading: boolean) => set({ isLoading: loading }),

  isStepValid: (step: number) => {
    const { data } = get();

    // Step numbers follow the FLOW ORDER (Onboarding's STEP_KEYS):
    // 1=name, 2=birth-date, 3=birth-LOCATION, 4=birth-TIME, 5=life-events.
    // Onboarding syncs its local step key FROM `currentStep`, so a stale
    // numbering here made nextStep() validate the (empty) time when leaving
    // the location step, stranding the store one step behind the UI — the
    // first Continue on the time step then rubber-banded the UI back (the
    // "swallowed" first click). Keep this switch aligned with STEP_KEYS.
    switch (step) {
      case 1:
        return data.name.trim().length >= 1;
      case 2:
        return data.birthDate !== null;
      case 3:
        return data.city.trim().length >= 1;
      case 4:
        // Time is valid if provided, or if user selected "unknown" — and a
        // provided time must name exactly one instant: a DST-gap time is
        // refused, and a repeated (fall-back) time needs the user's choice.
        // An unknown time is computed at noon, which gets the same DST check.
        if (effectiveClock(data).length < 4) return false;
        return isResolvedLocalTime(localTimeStatusOf(data), data.dstFold);
      case 5:
        return true; // Life events are optional
      default:
        return false;
    }
  },

  getFormattedBirthData: () => {
    const { data } = get();

    if (!data.birthDate || !data.latitude || !data.longitude) {
      return null;
    }

    // Format date as YYYY-MM-DD in local timezone
    const date = formatLocalDate(data.birthDate);

    // Unknown -> noon, exactly as the confidence note promises; a time typed
    // before switching to "unknown" is never sent.
    const time = effectiveClock(data) || UNKNOWN_TIME_CLOCK;

    // Build location_name from city, state, country
    const locationParts = [data.city, data.state, data.country].filter(Boolean);
    const location_name = locationParts.length > 0 ? locationParts.join(', ') : undefined;

    return {
      name: data.name,
      date,
      time,
      latitude: data.latitude,
      longitude: data.longitude,
      location_name,
      timezone: data.timezone,
      is_primary: true, // First chart during onboarding is the primary chart
    };
  },
});

/**
 * Onboarding store (in-memory only, no persistence)
 *
 * Spec 036 (Cache Consolidation): Removed persistence.
 * Onboarding status is fetched from API endpoint.
 */
export const useOnboardingStore = create<OnboardingStore>()(onboardingStoreCreator);
