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
    expect(source).not.toContain('toolOverrides');
  });

  // Contract reversed 2026-10-13 (period reading): a today question no longer pre-runs timing facts into
  // the prompt; it must call get_period_reading. The page only appends a dates clarification when asked.
  it('appends no pre-computed timing facts, only the toolset clarification note', () => {
    const code = stripComments(source);
    expect(code).not.toContain('VERIFIED LOCAL TIMING');
    expect(code).not.toContain('timingFacts');
    expect(code).not.toContain('currentContextUnavailable');
    expect(code).not.toMatch(/Do not guess life events/);
    expect(code).toContain("if (prepared.clarification) {\n      const [system, ...rest] = messages;\n      messages = [{ ...system, content: `${system.content ?? ''}\\n\\n${prepared.clarification.note}` }, ...rest];");
  });

  it('names the place tool by its constant, not a literal', () => {
    expect(source).not.toMatch(/['"]resolve_place['"]/);
    expect(source).toContain('RESOLVE_PLACE_TOOL_NAME');
  });

  // Contract reversed 2026-10-13: a trip no longer warms its period before the model runs, so the
  // page passes no localized pinnedStatus to prepare (plan cuddly-wandering-cocoa, section 3).
  it('forwards the thread pin to the toolset and the prompt, passes no pinned status, and bounds the sheet by birth year', () => {
    const code = stripComments(source);
    // Each assertion is scoped to its own call site, so a comment or the other
    // branch cannot satisfy it.
    expect(code).toMatch(/buildChatToolset\(\{[^}]*?\.\.\.\(asOf \? \{ pinned: asOf \} : \{\}\),[^}]*?\}\)/s);
    expect(code).toMatch(/toolset\.prepare\(question, \{\s*now,\s*signal,\s*onStatus: \(label\) => onAgentStatus\?\.\(label\),\s*\}\);/);
    expect(code).not.toContain('pinnedStatus');
    expect(code).toMatch(/RESOLVE_PLACE_TOOL_NAME\),\s*prepared\.pinned,\s*\);/);
    expect(code).toContain('birthYear={birthYearOf(');
    expect(code).not.toContain('pinnedPlaceReader(');
  });

  // Contract reversed 2026-10-13: the handler now also forwards a tool-call recorder after onTravel.
  it('forwards the thread pin, the per-turn movement recorder and the tool-call recorder to the LLM generator', () => {
    const code = stripComments(source);
    const handler = code.slice(code.indexOf('const handleAskQuestionStream'));
    expect(handler).toMatch(/onAgentStatus\?: \(label: string \| null\) => void,\s*asOf\?: ChatThreadAsOf,\s*onTravel\?:[^,]+TravelRecorder,\s*onToolCall\?:[^,]+AgentToolCallRecord\) => void,\s*\)/);
    expect(handler).toMatch(/of ask(?:Mesh|Local)Llm\(\s*question,[^)]*?onAgentStatus,\s*asOf,\s*onTravel,\s*onToolCall,\s*\)\)/);
  });

  // Contract reversed 2026-10-13: the generator's last param is now the tool-call recorder, after onTravel.
  it('the LLM generator takes the movement recorder after the thread pin, then the tool-call recorder', () => {
    const code = stripComments(source);
    expect(code).toMatch(/const ask(?:Mesh|Local)Llm = async function\* \([^)]*?onAgentStatus\?: \(label: string \| null\) => void,\s*asOf\?: ChatThreadAsOf,\s*onTravel\?:[^,]+TravelRecorder,\s*onToolCall\?:[^,]+AgentToolCallRecord\) => void,\s*\)/);
  });

  it("forwards the trip's first-round tool choice, grounding tool, required tools and tool-call recorder to streamAgentChat", () => {
    const code = stripComments(source);
    const call = code.slice(code.indexOf('yield* streamAgentChat({'));
    expect(call).toMatch(/^yield\* streamAgentChat\(\{[^]*?firstRoundToolChoice: prepared\.toolChoice,\s*\.\.\.\(prepared\.groundingTool \? \{ groundingToolName: prepared\.groundingTool \} : \{\}\),\s*\.\.\.\(prepared\.requiredTools \? \{ requiredToolNames: prepared\.requiredTools \} : \{\}\),\s*\.\.\.\(prepared\.groundingCalls \? \{ groundingCalls: prepared\.groundingCalls \} : \{\}\),\s*\.\.\.\(onToolCall \? \{ onToolCall \} : \{\}\),/);
  });
});
