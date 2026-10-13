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
