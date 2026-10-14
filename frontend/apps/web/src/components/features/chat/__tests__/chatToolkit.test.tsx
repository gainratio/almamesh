import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import '../../../../i18n/config';
import { CHAT_TOOL_CATALOG, CHAT_TOOLKIT, ToolCallRow, toolListOf } from '../chatToolkit';

const READING = { period: { label: 'May 2019', start: '2019-05-01', end: '2019-05-31' }, place: { label: 'Singapore', timezone: 'Asia/Singapore' }, dashas: { maha: [{ lord: 'jupiter' }] } };

describe('the chat toolkit registers the two tools the model has', () => {
  it('read_period and travel, each render-only with a row renderer (the tool loop runs them)', () => {
    expect(Object.keys(CHAT_TOOLKIT)).toEqual(['read_period', 'travel']);
    for (const name of ['read_period', 'travel']) {
      expect(CHAT_TOOLKIT[name]).toMatchObject({ type: 'backend' });
      expect(CHAT_TOOLKIT[name]?.render).toBeTypeOf('function');
      expect(CHAT_TOOLKIT[name]).not.toHaveProperty('execute');
    }
  });

  it('the visible Tools list names each tool in plain words, in every language', () => {
    expect(toolListOf(CHAT_TOOLKIT, (key) => key)).toEqual([
      { name: 'read_period', label: CHAT_TOOL_CATALOG.read_period!.labelKey },
      { name: 'travel', label: CHAT_TOOL_CATALOG.travel!.labelKey },
    ]);
  });
});

describe('a tool-call row shows what the AI pulled', () => {
  it('a reading row: "Looked up the period reading · May 2019 · Singapore", collapsed until opened', () => {
    render(<ToolCallRow toolName="read_period" toolCallId="r1" args={{ start: '2019-05' }} argsText="" result={READING} status={{ type: 'complete' }} />);
    const row = screen.getByTestId('chat-tool-call');
    expect(row.getAttribute('data-tool-name')).toBe('read_period');
    expect(row.getAttribute('data-status')).toBe('complete');
    // When before where: a narrow row truncates the place (the thread header names it), never the period.
    expect(screen.getByTestId('chat-tool-call-summary').textContent).toBe('Looked up the period reading · May 2019 · Singapore');
    expect(screen.getByTestId('chat-tool-call-summary').getAttribute('title')).toBe('Looked up the period reading · May 2019 · Singapore');
    expect(screen.queryByTestId('chat-tool-call-result')).toBeNull();
    fireEvent.click(screen.getByTestId('chat-tool-call-summary'));
    expect(screen.getByTestId('chat-tool-call-args').textContent).toContain('"start": "2019-05"');
    expect(screen.getByTestId('chat-tool-call-result').textContent).toContain('jupiter');
  });

  it('a today reading has no place label and still reads as a sentence', () => {
    render(<ToolCallRow toolName="read_period" toolCallId="r2" args={{}} argsText="" result={{ period: { label: 'October 14, 2026' }, place: { timezone: 'America/Los_Angeles' } }} status={{ type: 'complete' }} />);
    expect(screen.getByTestId('chat-tool-call-summary').textContent).toBe('Looked up the period reading · October 14, 2026');
  });

  it('a travel row names the move, its place and its period', () => {
    render(<ToolCallRow toolName="travel" toolCallId="t1" args={{ to: '2019-05', place: 'Pune' }} argsText=""
      result={{ status: 'queued', action: 'travel', period_label: 'May 2019', place_label: 'Pune, India', time_zone: 'Asia/Kolkata' }} status={{ type: 'complete' }} />);
    expect(screen.getByTestId('chat-tool-call-summary').textContent).toBe('Looked up a move in time · May 2019 · Pune, India');
  });

  it('an unavailable reading is a failed lookup, not a success', () => {
    render(<ToolCallRow toolName="read_period" toolCallId="r3" args={{}} argsText="" result={{ ...READING, available: false, reason: 'timeout' }} status={{ type: 'complete' }} />);
    expect(screen.getByTestId('chat-tool-call').getAttribute('data-status')).toBe('error');
    expect(screen.getByTestId('chat-tool-call-summary').textContent).toBe('Could not look up the period reading · May 2019 · Singapore');
  });

  it('a thrown call is an error row', () => {
    render(<ToolCallRow toolName="read_period" toolCallId="r4" args={{}} argsText="" result="read_period timed out after 150000 ms" isError status={{ type: 'complete' }} />);
    expect(screen.getByTestId('chat-tool-call').getAttribute('data-status')).toBe('error');
  });

  it('a question put back to the user (needs_place, a place to pick) completed: it is not an error', () => {
    render(<ToolCallRow toolName="read_period" toolCallId="r5" args={{}} argsText="" result={{ status: 'needs_place', ask: 'Ask where the user was that day.' }} status={{ type: 'complete' }} />);
    expect(screen.getByTestId('chat-tool-call').getAttribute('data-status')).toBe('complete');
  });
});

describe('a skipped call is a neutral row, never an error (P1 fix 4)', () => {
  const skipped = 'This turn already read enough; answer from the readings above.';

  it('says Skipped, is marked skipped, and does not say it failed', () => {
    render(<ToolCallRow toolName="read_period" toolCallId="s1" args={{}} argsText="" result={skipped} artifact={{ status: 'skipped' }} status={{ type: 'complete' }} />);
    expect(screen.getByTestId('chat-tool-call').getAttribute('data-status')).toBe('skipped');
    expect(screen.getByTestId('chat-tool-call-summary').textContent).toBe('Skipped the period reading');
  });

  it('speaks Spanish and Portuguese too', async () => {
    const { default: i18n } = await import('../../../../i18n/config');
    try {
      for (const [language, expected] of [['es', 'Omitió la lectura del periodo'], ['pt', 'Ignorou a leitura do período']] as const) {
        await i18n.changeLanguage(language);
        const { unmount } = render(<ToolCallRow toolName="read_period" toolCallId="s3" args={{}} argsText="" result={skipped}
          artifact={{ status: 'skipped' }} status={{ type: 'complete' }} />);
        expect(screen.getByTestId('chat-tool-call-summary').textContent).toContain(expected);
        unmount();
      }
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});

describe('tool-call row edges', () => {
  it('summarises a month-long period by its month when it has no label, and an unknown tool by its name', () => {
    render(<ToolCallRow toolName="mystery_tool" toolCallId="c3" args={{}} argsText="{}" result={{ period: { start: '2019-05-01', end: '2019-05-31' }, place: { label: 'Singapore' } }} status={{ type: 'complete' }} />);
    const row = screen.getByTestId('chat-tool-call');
    expect(row.textContent).toContain('mystery_tool');
    expect(row.textContent).toContain('May 2019 · Singapore');
  });

  it('a row with no result still renders', () => {
    render(<ToolCallRow toolName="read_period" toolCallId="c4" args={{}} argsText="" result={undefined} status={{ type: 'running' }} />);
    expect(screen.getByTestId('chat-tool-call').getAttribute('data-status')).toBe('complete');
  });

  it.each([
    [{ start: '2019-01-01', end: '2019-12-31' }, 'Looked up the period reading · 2019'],
    [{ start: '2019-05-04', end: '2019-05-04' }, 'Looked up the period reading · May 4, 2019'],
    [{ start: '2019-05-04', end: '2019-06-10' }, 'Looked up the period reading · 2019-05-04 – 2019-06-10'],
  ])('a period as people say it: %j', (period, expected) => {
    render(<ToolCallRow toolName="read_period" toolCallId="p" args={{}} argsText="" result={{ period }} status={{ type: 'complete' }} />);
    expect(screen.getByTestId('chat-tool-call-summary').textContent).toBe(expected);
  });
});

describe('rows persisted before the tool redesign still read in plain words', () => {
  const row = (toolName: string, result: unknown, isError?: boolean) => {
    render(<ToolCallRow toolName={toolName} toolCallId="old" args={{}} argsText="" result={result} isError={isError} status={{ type: 'complete' }} />);
    return { summary: screen.getByTestId('chat-tool-call-summary').textContent, status: screen.getByTestId('chat-tool-call').getAttribute('data-status') };
  };

  it.each([
    ['get_timing', 'the period reading'],
    ['get_period_reading', 'the period reading'],
    ['get_period_detail', 'the period reading'],
    ['get_trip_context', 'the period reading'],
    ['resolve_place', 'a place'],
    ['time_travel', 'a move in time'],
    ['get_natal_summary', 'chart facts'],
    ['get_chart_facts', 'chart facts'],
    ['get_current_datetime', 'chart facts'],
  ])('%s shows %s, never its raw name', (name, subject) => {
    const { summary } = row(name, { ok: true });
    expect(summary).toBe(`Looked up ${subject}`);
    expect(summary).not.toContain('get_');
  });

  it('an old {code} or {error} result is a failure, not a complete row', () => {
    expect(row('resolve_place', { code: 'not_found' }).status).toBe('error');
    cleanup();
    expect(row('get_timing', { error: 'no chart' }).status).toBe('error');
    cleanup();
    expect(row('time_travel', { available: false }).status).toBe('error');
    cleanup();
    expect(row('get_period_reading', { ok: true }).status).toBe('complete');
  });

  it('a new read_period ask that carries a code stays complete', () => {
    expect(row('read_period', { code: 'place_not_chosen', available: true }).status).toBe('complete');
  });
});
