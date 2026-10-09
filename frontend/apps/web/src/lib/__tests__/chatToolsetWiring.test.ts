import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Both chat surfaces build their tools through ONE builder and pass no day
// zone, so they cannot disagree on "today" again (spec open question 1).
const pages = ['Dashboard.tsx', 'MeshEdge.tsx'].map((name) => ({
  name,
  source: readFileSync(resolve(__dirname, '../../pages', name), 'utf8'),
}));

describe.each(pages)('$name chat wiring', ({ source }) => {
  it('builds its tools with buildChatToolset', () => {
    expect(source).toContain('buildChatToolset(');
  });

  it('does not build tools, run the router, wait for the engine, or pick a day zone itself', () => {
    expect(source).not.toContain('createChatAgentTools(');
    expect(source).not.toContain('createPeriodChartLoader(');
    expect(source).not.toContain('ensureCurrentPlanetaryContext(');
    expect(source).not.toContain('requiresCurrentPlanetaryContext(');
    expect(source).not.toContain('shouldPreRunToday(');
    expect(source).not.toContain('viewerTodayDay(');
    expect(source).not.toContain('whenReady()');
    expect(source).not.toContain('viewerZone');
  });
});
