import { expect } from 'vitest';

import { viewerTodayDay } from '../lib/chatAgentTools';
import type { ChatToolset } from '../lib/chatToolset';
import { TIMING_TOOL_NAME } from '../lib/timingTool';

/** 20:00 UTC: already the next calendar day in Asia/Kolkata, still today in UTC and the Americas. */
export const SPLIT_DAY_NOW = new Date('2026-03-08T20:00:00.000Z');

/**
 * Pin a page's chat "today" to the viewer zone (spec open question 1, decided).
 * The precondition proves the test can tell the two zones apart on this machine.
 */
export async function expectToolsetReadsViewerToday(toolset: ChatToolset, birthZone: string): Promise<void> {
  const viewerDay = viewerTodayDay(SPLIT_DAY_NOW);
  const birthDay = viewerTodayDay(SPLIT_DAY_NOW, birthZone);
  expect(viewerDay, 'run this test in a zone west of UTC+04:00 so the days differ').not.toBe(birthDay);
  const timing = toolset.tools.find((tool) => tool.name === TIMING_TOOL_NAME);
  if (!timing) throw new Error(`${TIMING_TOOL_NAME} is missing`);
  const result = (await timing.execute(
    { section: 'dashas' },
    { now: SPLIT_DAY_NOW, signal: new AbortController().signal },
  )) as { period: { start: string } };
  expect(result.period.start).toBe(viewerDay);
}
