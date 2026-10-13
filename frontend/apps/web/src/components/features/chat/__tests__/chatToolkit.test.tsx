import { render, screen, fireEvent } from '@testing-library/react';
import type { AgentTool } from '@almamesh/llm';
import { describe, expect, it, vi } from 'vitest';

import '../../../../i18n/config';
import { CHAT_TOOL_CATALOG, ToolCallRow, agentToolsOf, buildChatToolkit, toolListOf } from '../chatToolkit';

function tool(name: string, execute: AgentTool['execute'] = () => ({ ok: name })): AgentTool {
  return { name, description: `${name} description`, parameters: { type: 'object', properties: {}, additionalProperties: false }, execute };
}
const TRIP_TOOLS = ['get_natal_summary', 'get_trip_context', 'get_timing', 'resolve_place', 'time_travel'].map((name) => tool(name));

describe('the chat toolkit is the one registry for the model and the UI', () => {
  it('registers every bound tool with its description, JSON schema and a renderer', () => {
    const toolkit = buildChatToolkit(TRIP_TOOLS);
    expect(Object.keys(toolkit)).toEqual(TRIP_TOOLS.map((t) => t.name));
    for (const t of TRIP_TOOLS) {
      expect(toolkit[t.name]).toMatchObject({ type: 'frontend', description: t.description, parameters: t.parameters });
      expect(toolkit[t.name]?.render).toBeTypeOf('function');
    }
  });

  it('the agent loop reads its tools from the toolkit: same names and schemas, the bound handler runs', async () => {
    const execute = vi.fn(() => ({ place: 'Singapore' }));
    const toolkit = buildChatToolkit([tool('get_trip_context', execute), tool('get_timing')]);
    const agentTools = agentToolsOf(toolkit);
    expect(agentTools.map((t) => [t.name, t.description, t.parameters])).toEqual(
      Object.entries(toolkit).map(([name, entry]) => [name, entry.description, entry.parameters]));
    const context = { now: new Date(0), signal: new AbortController().signal };
    expect(await agentTools[0]!.execute({}, context)).toEqual({ place: 'Singapore' });
    expect(execute).toHaveBeenCalledWith({}, context);
  });

  it('a tool the catalog does not list is in neither the toolkit nor the model list', () => {
    const toolkit = buildChatToolkit([...TRIP_TOOLS, tool('rogue_tool')]);
    expect(Object.keys(toolkit)).not.toContain('rogue_tool');
    expect(agentToolsOf(toolkit).map((t) => t.name)).not.toContain('rogue_tool');
  });

  it('the visible Tools list names each registered tool in plain words', () => {
    const list = toolListOf(buildChatToolkit(TRIP_TOOLS), (key) => key);
    expect(list.map((row) => row.name)).toEqual(TRIP_TOOLS.map((t) => t.name));
    expect(list.map((row) => row.label)).toEqual(TRIP_TOOLS.map((t) => CHAT_TOOL_CATALOG[t.name]!.labelKey));
  });
});

describe('a tool-call row shows what the AI pulled', () => {
  it('names the lookup with its section, place and period, and expands to the args and result', () => {
    const result = { period: { label: 'May 2019' }, places: [{ label: 'Singapore' }], data: { maha: [{ lord: 'jupiter' }] } };
    render(<ToolCallRow toolName="get_timing" toolCallId="c1" args={{ section: 'transits' }} argsText='{"section":"transits"}' result={result} status={{ type: 'complete' }} />);
    const row = screen.getByTestId('chat-tool-call');
    expect(row.getAttribute('data-tool-name')).toBe('get_timing');
    expect(row.textContent).toContain('transits');
    expect(row.textContent).toContain('Singapore');
    fireEvent.click(screen.getByText(/Looked up/));
    expect(screen.getByTestId('chat-tool-call-args').textContent).toContain('"section": "transits"');
    expect(screen.getByTestId('chat-tool-call-result').textContent).toContain('jupiter');
  });

  it('a failed call says so', () => {
    render(<ToolCallRow toolName="get_timing" toolCallId="c2" args={{}} argsText="{}" result={{ code: 'tool_failed' }} isError status={{ type: 'complete' }} />);
    expect(screen.getByTestId('chat-tool-call').getAttribute('data-status')).toBe('error');
  });
});

describe('tool-call row edges', () => {
  it('summarises a month-long period by its month when it has no label, and an unknown tool by its name', () => {
    render(<ToolCallRow toolName="mystery_tool" toolCallId="c3" args={{}} argsText="{}" result={{ period: { start: '2019-05-01', end: '2019-05-31' }, place: { label: 'Singapore' } }} status={{ type: 'complete' }} />);
    const row = screen.getByTestId('chat-tool-call');
    expect(row.textContent).toContain('mystery_tool');
    expect(row.textContent).toContain('Singapore · May 2019');
  });

  it('a row with no result still renders', () => {
    render(<ToolCallRow toolName="get_timing" toolCallId="c4" args={{ section: 'dashas' }} argsText="" result={undefined} status={{ type: 'running' }} />);
    expect(screen.getByTestId('chat-tool-call').getAttribute('data-status')).toBe('complete');
  });
});

describe('tool-call rows read like a sentence and stay collapsed (2026-10-13)', () => {
  it('a trip-context row: "Looked up trip period & place · Singapore · May 2019", collapsed, no raw JSON until opened', () => {
    render(<ToolCallRow toolName="get_trip_context" toolCallId="t1" args={{}} argsText="{}"
      result={{ period: { label: 'May 2019' }, place: { label: 'Singapore', timezone: 'Asia/Singapore' } }} status={{ type: 'complete' }} />);
    const row = screen.getByTestId('chat-tool-call');
    expect(row.hasAttribute('open')).toBe(false);
    expect(screen.getByTestId('chat-tool-call-summary').textContent).toBe('Looked up trip period & place · Singapore · May 2019');
    expect(screen.queryByTestId('chat-tool-call-result')).toBeNull();
    fireEvent.click(screen.getByTestId('chat-tool-call-summary'));
    expect(screen.getByTestId('chat-tool-call-result').textContent).toContain('Asia/Singapore');
  });

  it('a timing row names its section and the month it read', () => {
    render(<ToolCallRow toolName="get_timing" toolCallId="t2" args={{ section: 'transits' }} argsText=""
      result={{ period: { start: '2019-05-01', end: '2019-05-31', days: 31, basis: 'period' }, places: [{ label: 'Singapore' }] }} status={{ type: 'complete' }} />);
    expect(screen.getByTestId('chat-tool-call-summary').textContent).toBe('Looked up transits · Singapore · May 2019');
  });

  it('a natal row has no place or period', () => {
    render(<ToolCallRow toolName="get_natal_summary" toolCallId="t3" args={{}} argsText="" result={{ lagna: { sign: 'Leo' } }} status={{ type: 'complete' }} />);
    expect(screen.getByTestId('chat-tool-call-summary').textContent).toBe('Looked up natal chart');
  });
});

describe('tool-call row periods as people say them', () => {
  it.each([
    [{ start: '2019-01-01', end: '2019-12-31' }, 'Looked up dashas · 2019'],
    [{ start: '2019-05-04', end: '2019-05-04' }, 'Looked up dashas · May 4, 2019'],
    [{ start: '2019-05-04', end: '2019-06-10' }, 'Looked up dashas · 2019-05-04 – 2019-06-10'],
  ])('%j', (period, expected) => {
    render(<ToolCallRow toolName="get_timing" toolCallId="p" args={{ section: 'dashas' }} argsText="" result={{ period }} status={{ type: 'complete' }} />);
    expect(screen.getByTestId('chat-tool-call-summary').textContent).toBe(expected);
  });
});

describe('the period reading tools (spec 2026-10-13)', () => {
  it('both are in the catalog, so the model and the Tools list get them', () => {
    const toolkit = buildChatToolkit([tool('get_period_reading'), tool('get_period_detail')]);
    expect(Object.keys(toolkit)).toEqual(['get_period_reading', 'get_period_detail']);
    expect(toolListOf(toolkit, (key) => key).map((row) => row.label)).toEqual(['tools.get_period_reading', 'tools.get_period_detail']);
  });

  it('a reading row: "Looked up the period reading · Singapore · May 2019"', () => {
    render(<ToolCallRow toolName="get_period_reading" toolCallId="r1" args={{}} argsText="{}"
      result={{ period: { label: 'May 2019' }, place: { label: 'Singapore', timezone: 'Asia/Singapore' }, dashas: {} }} status={{ type: 'complete' }} />);
    expect(screen.getByTestId('chat-tool-call-summary').textContent).toBe('Looked up the period reading · Singapore · May 2019');
    expect(screen.getByTestId('chat-tool-call').getAttribute('data-status')).toBe('complete');
  });

  it('a today reading has no place label and still reads as a sentence', () => {
    render(<ToolCallRow toolName="get_period_reading" toolCallId="r2" args={{}} argsText="{}"
      result={{ period: { label: 'October 13, 2026' }, place: { label: null, timezone: 'America/Los_Angeles' } }} status={{ type: 'complete' }} />);
    expect(screen.getByTestId('chat-tool-call-summary').textContent).toBe('Looked up the period reading · October 13, 2026');
  });

  it('a detail row names its section', () => {
    render(<ToolCallRow toolName="get_period_detail" toolCallId="d1" args={{ section: 'lord', key: 'saturn' }} argsText=""
      result={{ period: { label: 'May 2019' }, place: { label: 'Singapore' }, section: 'lord', facts: {} }} status={{ type: 'complete' }} />);
    expect(screen.getByTestId('chat-tool-call-summary').textContent).toBe('Looked up a running lord · Singapore · May 2019');
  });

  it('an unavailable reading is shown as a failed lookup, not a success', () => {
    render(<ToolCallRow toolName="get_period_reading" toolCallId="r3" args={{}} argsText="{}"
      result={{ period: { label: 'May 2019' }, place: { label: 'Singapore' }, available: false, reason: 'timeout' }} status={{ type: 'complete' }} />);
    expect(screen.getByTestId('chat-tool-call').getAttribute('data-status')).toBe('error');
    expect(screen.getByTestId('chat-tool-call-summary').textContent).toBe('Could not look up the period reading · Singapore · May 2019');
  });
});
