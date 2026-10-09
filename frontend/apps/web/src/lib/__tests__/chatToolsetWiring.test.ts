import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Both chat surfaces build their tools through ONE builder and pass no day
// zone, so they cannot disagree on "today" again (spec open question 1).
const pages = ['Dashboard.tsx', 'MeshEdge.tsx'].map((name) => ({
  name,
  source: readFileSync(resolve(__dirname, '../../pages', name), 'utf8'),
}));

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

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
    // Step C test seams: the device tier and the place reader come from the builder.
    expect(source).not.toContain('periodSkyAllowed');
    expect(source).not.toContain('placeFromRef');
  });

  it('names the place tool by its constant, not a literal', () => {
    expect(source).not.toMatch(/['"]resolve_place['"]/);
    expect(source).toContain('RESOLVE_PLACE_TOOL_NAME');
  });

  it('forwards the thread pin to the toolset and the prompt, and bounds the sheet by birth year', () => {
    const code = stripComments(source);
    // Each assertion is scoped to its own call site, so a comment or the other
    // branch cannot satisfy it.
    expect(code).toMatch(/buildChatToolset\(\{[^}]*?\.\.\.\(asOf \? \{ pinned: asOf \} : \{\}\),[^}]*?\}\)/s);
    expect(code).toMatch(/toolset\.prepare\(question, \{[^]*?pinnedStatus: asOf \? t\('chat:time_travel\.status_working'[^]*?\}\);/);
    expect(code).toMatch(/RESOLVE_PLACE_TOOL_NAME\),\s*prepared\.pinned,\s*\);/);
    expect(code).toContain('birthYear={birthYearOf(');
    expect(code).not.toContain('pinnedPlaceReader(');
  });

  it('handleAskQuestionStream takes asOf last and passes it as the last argument to the LLM generator', () => {
    const code = stripComments(source);
    const handler = code.slice(code.indexOf('const handleAskQuestionStream'));
    expect(handler).toMatch(/onAgentStatus\?: \(label: string \| null\) => void,\s*asOf\?: ChatThreadAsOf,\s*\)/);
    expect(handler).toMatch(/of ask(?:Mesh|Local)Llm\(\s*question,[^)]*?onAgentStatus,\s*asOf,\s*\)\)/);
  });

  it('the LLM generator takes asOf after onAgentStatus', () => {
    const code = stripComments(source);
    expect(code).toMatch(/const ask(?:Mesh|Local)Llm = async function\* \([^)]*?onAgentStatus\?: \(label: string \| null\) => void,\s*asOf\?: ChatThreadAsOf,\s*\)/);
  });
});
