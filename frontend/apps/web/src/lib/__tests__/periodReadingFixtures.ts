/**
 * The period-reading fixtures (DELHI_BIRTH): testdata/period-reading/*.json at
 * the repo root, shared with the backend. A file is either the bare
 * `period_reading` object or a wrapper that carries it under that key.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PeriodReadingContext } from '@almamesh/browser/types';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(HERE, '../../../../../../testdata/period-reading');

/** The backend goldens (p1-be), DELHI_BIRTH: Year 2019, May 2019, Jan 2027, Day 2019-09-15. */
export type PeriodReadingFixture = 'delhi-2019-year' | 'delhi-2019-05' | 'delhi-2027-01' | 'delhi-2019-09-15-day';

export function periodReadingFixture(name: PeriodReadingFixture): PeriodReadingContext {
  const value = JSON.parse(readFileSync(resolve(DIR, `${name}.json`), 'utf8')) as Record<string, unknown>;
  return (value.period_reading ?? value) as PeriodReadingContext;
}

/** DELHI_BIRTH (e2e/interpretation.helpers.ts): what must never reach a tool result. */
export const DELHI_BIRTH_LEAKS = ['1990-01-15', '12:00:00', '17:30', '28.6139', '77.209', 'datetime_utc', 'latitude', 'longitude'] as const;
