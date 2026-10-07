/**
 * The chart-local "today" as a `predictiveReferenceInstant` (UTC midnight of the
 * calendar day in `timeZone`). The ONE place the UI reads the wall clock for a
 * day; it re-renders when that day turns over, even on an idle page.
 */
import { useEffect, useState } from 'react';

import { predictiveReferenceInstant } from '../lib/predictive';

/** Milliseconds until the chart timezone's calendar day changes. */
function untilNextReferenceDay(now: number, timeZone: string): number {
  const current = predictiveReferenceInstant(new Date(now), timeZone);
  let low = now;
  let high = now + 30 * 60 * 60 * 1_000;
  while (high - low > 1_000) {
    const middle = Math.floor((low + high) / 2);
    if (predictiveReferenceInstant(new Date(middle), timeZone) === current) low = middle;
    else high = middle;
  }
  return high - now;
}

/** A chart-local daily reference that updates even when the page stays idle. */
export function useDailyReferenceInstant(timeZone: string): string {
  const [reference, setReference] = useState(() => predictiveReferenceInstant(new Date(), timeZone));
  useEffect(() => {
    const currentReference = predictiveReferenceInstant(new Date(), timeZone);
    if (reference !== currentReference) {
      setReference(currentReference);
      return;
    }
    const timer = setTimeout(
      () => setReference(predictiveReferenceInstant(new Date(), timeZone)),
      untilNextReferenceDay(Date.now(), timeZone) + 1,
    );
    return () => clearTimeout(timer);
  }, [reference, timeZone]);
  return reference;
}
