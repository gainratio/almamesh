/**
 * Canonical dasha boundary day formatting shared by the prompt builder,
 * the evidence validator, and the screen/PDF renderers.
 */

import { viewerTimeZone } from '../analysisInstant';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function resolveTimeZone(explicit?: string): string {
  const candidate = explicit || viewerTimeZone() || 'UTC';
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: candidate });
    return candidate;
  } catch {
    return 'UTC';
  }
}

/**
 * Format an engine dasha boundary ISO string as `YYYY-MM-DD` in `timeZone`
 * (defaulting to `viewerTimeZone()`), matching the Transits timeline, Life
 * Domains, and Section VIII Observation/Evidence lines. Date-only strings
 * (`YYYY-MM-DD`) preserve their written calendar day verbatim.
 */
export function formatDashaBoundaryDay(value: string, timeZone?: string): string {
  if (DATE_ONLY.test(value)) {
    return value;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value.slice(0, 10);
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      calendar: 'iso8601',
      timeZone: resolveTimeZone(timeZone),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(parsed)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Parent dasha factor ids of a nested `dasha:antar:*` or `dasha:pratyantar:*` id. */
export function parentDashaFactorIds(id: string): readonly string[] {
  if (id.startsWith('dasha:pratyantar:')) {
    const parts = id.slice('dasha:pratyantar:'.length).split('/');
    if (parts.length === 3 && parts[0] && parts[1]) {
      return [`dasha:maha:${parts[0]}`, `dasha:antar:${parts[0]}/${parts[1]}`];
    }
  }
  if (id.startsWith('dasha:antar:')) {
    const parts = id.slice('dasha:antar:'.length).split('/');
    if (parts.length === 2 && parts[0]) {
      return [`dasha:maha:${parts[0]}`];
    }
  }
  return [];
}
