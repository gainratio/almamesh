import { expect } from 'vitest';

import { viewerTimeZone } from '../lib/analysisInstant';
import { viewerTodayDay } from '../lib/chatAgentTools';
import type { ChatToolset } from '../lib/chatToolset';
import { TIMING_TOOL_NAME } from '../lib/timingTool';

/** 20:00 UTC: already the next calendar day in Asia/Kolkata, still today in UTC and the Americas. */
export const SPLIT_DAY_NOW = new Date('2026-03-08T20:00:00.000Z');

/**
 * Pin a page's chat "today" to the viewer zone (spec open question 1, decided).
 * The viewer day comes from `viewerTimeZone()`, the same seam the builder reads,
 * so a page test that mocks that zone (as both page tests do) is TZ-independent.
 * The precondition proves the test can tell the two zones apart.
 */
export async function expectToolsetReadsViewerToday(toolset: ChatToolset, birthZone: string): Promise<void> {
  const viewerDay = viewerTodayDay(SPLIT_DAY_NOW, viewerTimeZone());
  const birthDay = viewerTodayDay(SPLIT_DAY_NOW, birthZone);
  expect(viewerDay, 'the viewer zone must be west of UTC+04:00 so the days differ').not.toBe(birthDay);
  const timing = toolset.tools.find((tool) => tool.name === TIMING_TOOL_NAME);
  if (!timing) throw new Error(`${TIMING_TOOL_NAME} is missing`);
  const result = (await timing.execute(
    { section: 'dashas' },
    { now: SPLIT_DAY_NOW, signal: new AbortController().signal },
  )) as { period: { start: string } };
  expect(result.period.start).toBe(viewerDay);
}
