import { viewerTimeZone } from './analysisInstant';
import { predictiveReferenceInstant } from './predictive';

/**
 * Today's calendar day in the viewer's (device) zone: the one "today" every
 * page reads, and the zone every "As of" on screen is printed in.
 */
export function viewerTodayDay(now: Date, timeZone: string = viewerTimeZone()): string {
  return predictiveReferenceInstant(now, timeZone).slice(0, 10);
}
