/**
 * useLagnaPreview — a debounced, NON-DESTRUCTIVE Ascendant (Lagna) preview.
 *
 * As the user adjusts the rectified birth time in Settings, this hook computes
 * the resulting lagna on the SHARED in-browser engine (the same `ChartEngine`
 * the dashboard + regeneration use — never a second Pyodide worker) and returns
 * just the sign + degree + nakshatra for display. It is preview-only: it does
 * NOT emit `birth-info-changed`, save a chart, or persist anything. It exists so
 * a user can SEE that a few minutes flips their rising sign before committing.
 */

import { useEffect, useRef, useState } from 'react';

import type { ChartEngine } from '@almamesh/browser';
import { type LocalBirthInput, newChartReferenceInstant, toBirthInput } from '@almamesh/store';

/** The minimal lagna read-out the preview renders. */
export interface LagnaPreview {
  /** Engine Title-Case sign name, e.g. "Aquarius". */
  readonly sign: string;
  /** Degrees within the sign (0..30). */
  readonly signDegrees: number;
  /** Engine nakshatra name. */
  readonly nakshatra: string;
}

export type LagnaPreviewState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly lagna: LagnaPreview }
  | { readonly status: 'error' }
  | { readonly status: 'unavailable' };

const DEBOUNCE_MS = 300;

/** Stable key over the inputs that change the lagna; re-runs only when it moves. */
function previewKey(input: LocalBirthInput | null, retryAttempt: number): string {
  if (input === null) {
    return '';
  }
  const clock = input.rectifiedTime ?? input.time;
  return `${input.date}T${clock}|${input.timezone}|${input.dstFold ?? ''}|${input.latitude}|${input.longitude}|${retryAttempt}`;
}

interface KeyedPreviewState {
  readonly key: string;
  readonly engine: ChartEngine | null;
  readonly engineError: Error | null;
  readonly value: LagnaPreviewState;
}

/**
 * Debounce `input` ~300ms and compute its lagna on `engine`. Returns the current
 * preview state. Passing `input: null` (incomplete form) yields `idle`; a null
 * engine that has not errored yields `unavailable`.
 */
export function useLagnaPreview(
  engine: ChartEngine | null,
  engineError: Error | null,
  input: LocalBirthInput | null,
  retryAttempt = 0,
): LagnaPreviewState {
  const [result, setResult] = useState<KeyedPreviewState>({
    key: '',
    engine: null,
    engineError: null,
    value: { status: 'idle' },
  });
  const key = previewKey(input, retryAttempt);
  const keyedInputRef = useRef({ key, input });
  if (keyedInputRef.current.key !== key) {
    keyedInputRef.current = { key, input };
  }
  const keyedInput = keyedInputRef.current.input;
  const resultIsCurrent =
    result.key === key && result.engine === engine && result.engineError === engineError;
  const state: LagnaPreviewState = resultIsCurrent
    ? result.value
    : key === ''
      ? { status: 'idle' }
      : engineError !== null || engine === null
        ? { status: 'unavailable' }
        : { status: 'loading' };

  useEffect(() => {
    const setCurrent = (value: LagnaPreviewState) => {
      setResult({ key, engine, engineError, value });
    };
    if (keyedInput === null || key === '') {
      setCurrent({ status: 'idle' });
      return;
    }
    if (engineError !== null || engine === null) {
      setCurrent({ status: 'unavailable' });
      return;
    }

    let cancelled = false;
    setCurrent({ status: 'loading' });
    const timer = setTimeout(() => {
      void (async () => {
        try {
          // Preview-only and never stored, but the engine still takes the
          // instant as an input rather than reaching for a clock. The preview
          // reads only `chart.lagna`, which is pure birth data, so the instant
          // it happens to be given does not move anything on screen.
          const chart = await engine.generateChart(
            toBirthInput(keyedInput, newChartReferenceInstant()),
          );
          if (cancelled) {
            return;
          }
          setCurrent({
            status: 'ready',
            lagna: {
              sign: chart.lagna.sign,
              signDegrees: chart.lagna.sign_degrees,
              nakshatra: chart.lagna.nakshatra,
            },
          });
        } catch {
          if (!cancelled) {
            setCurrent({ status: 'error' });
          }
        }
      })();
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [engine, engineError, key, keyedInput]);

  return state;
}
