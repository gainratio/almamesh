import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { useChatStore } from '@almamesh/store';
import { hydrateLlmSettings, openRouterPreset, writeLlmSettings, type AgentTool } from '@almamesh/llm';
import type { ComponentProps } from 'react';

vi.mock('../../../../lib/storeSaved', () => ({ waitForStoreSaved: vi.fn(async () => undefined) }));

import '../../../../i18n/config';
import { ChatPanel, type ChatTripKit } from '../ChatPanel';
import { __resetMemoryForTest, __setMemoryForTest } from '../../../../lib/chatMemory';
import type { TripContext } from '../../../../lib/tripContext';

type AskFn = NonNullable<ComponentProps<typeof ChatPanel>['onAskQuestionStream']>;
const SINGAPORE = { label: 'Singapore', timezone: 'Asia/Singapore', latitude: 1.29, longitude: 103.85 };
const MAY_2019_SG = { start: '2019-05-01', end: '2019-05-31', granularity: 'month', place: SINGAPORE } as const;
const tool = (name: string): AgentTool => ({ name, description: name, parameters: { type: 'object', properties: {} }, execute: () => ({}) });
const TRIP_TOOLS = ['get_natal_summary', 'get_trip_context', 'get_timing', 'resolve_place', 'time_travel'].map(tool);
const TODAY_TOOLS = ['get_current_datetime', 'get_chart_facts', 'get_timing'].map(tool);
const TRIP: TripContext = {
  period: { start: '2019-05-01', end: '2019-05-31', granularity: 'month', tense: 'past', label: 'May 2019' },
  place: { label: 'Singapore', timezone: 'Asia/Singapore', source: 'trip', display: 'Singapore' },
  today: '2026-10-13',
  natal: { lagna: { sign: 'scorpio', nakshatra: 'anuradha', pada: 1, sign_lord: 'mars' }, moon: null, planets: [], yogas: [] },
  dashas: { maha: [{ lord: 'saturn', start_month: '2017-01', end_month: '2036-01' }],
    antar: [{ maha_lord: 'saturn', lord: 'saturn', start_month: '2017-01', end_month: '2019-05' }, { maha_lord: 'saturn', lord: 'mercury', start_month: '2019-05', end_month: '2021-09' }], notes: [] },
};
const KIT: ChatTripKit = { toolsFor: (asOf) => (asOf ? TRIP_TOOLS : TODAY_TOOLS), tripFor: (asOf) => (asOf ? TRIP : undefined) };

function renderPanel(onAsk = vi.fn<AskFn>(async () => ({ answer: 'ok' }))) {
  writeLlmSettings(openRouterPreset('sk-or-v1-0000-synthetic-test-key', 'test-org/test-model'));
  render(
    <MemoryRouter>
      <ChatPanel personName="Marco" profileId="p1" chartId="c1" viewMode="layman" birthYear={1990} onAskQuestionStream={onAsk} chatKit={KIT} />
    </MemoryRouter>,
  );
  return onAsk;
}

beforeEach(() => {
  hydrateLlmSettings(null);
  useChatStore.setState({ threads: {}, messages: {}, summaries: {} });
  __setMemoryForTest({
    indexMessage: vi.fn().mockResolvedValue(undefined), retrieve: vi.fn().mockResolvedValue([]),
    deleteForProfile: vi.fn().mockResolvedValue(undefined), deleteForThread: vi.fn().mockResolvedValue(undefined), clear: vi.fn().mockResolvedValue(undefined),
  });
});
afterEach(() => {
  hydrateLlmSettings(null);
  useChatStore.setState({ threads: {}, messages: {}, summaries: {} });
  __resetMemoryForTest();
});

describe('a trip thread shows what grounds it', () => {
  it('the context card names the period, the place and the dasha', () => {
    useChatStore.getState().startThread('p1', 'c1', MAY_2019_SG);
    renderPanel();
    const card = screen.getByTestId('trip-context-card');
    expect(card.textContent).toContain('May 2019');
    expect(card.textContent).toContain('Singapore');
    expect(card.textContent).toContain('Saturn–Saturn → Saturn–Mercury');
  });

  it('a today thread has no context card', () => {
    useChatStore.getState().startThread('p1', 'c1');
    renderPanel();
    expect(screen.queryByTestId('trip-context-card')).toBeNull();
  });

  it('the Tools chip lists exactly the tools registered for this thread', () => {
    useChatStore.getState().startThread('p1', 'c1', MAY_2019_SG);
    renderPanel();
    fireEvent.click(screen.getByTestId('chat-tools-button'));
    const rows = within(screen.getByTestId('chat-tools-list')).getAllByRole('listitem');
    expect(rows.map((row) => row.getAttribute('data-tool-name'))).toEqual(TRIP_TOOLS.map((t) => t.name));
    expect(rows[0]?.textContent).toBe('Natal summary');
  });

  it('renders a row for each persisted tool call, then the answer', () => {
    const id = useChatStore.getState().startThread('p1', 'c1', MAY_2019_SG);
    useChatStore.getState().appendMessage(id, 'user', 'How was work?');
    useChatStore.getState().appendMessage(id, 'assistant', 'Steady.', { parts: [
      { type: 'tool-call', toolCallId: 'a', toolName: 'get_trip_context', args: {}, status: 'complete', result: { period: { label: 'May 2019' }, place: { label: 'Singapore' } } },
      { type: 'tool-call', toolCallId: 'b', toolName: 'get_timing', args: { section: 'dashas' }, status: 'complete', result: { data: {} } },
      { type: 'text', text: 'Steady.' },
    ] });
    renderPanel();
    const rows = screen.getAllByTestId('chat-tool-call');
    expect(rows.map((row) => row.getAttribute('data-tool-name'))).toEqual(['get_trip_context', 'get_timing']);
    expect(rows[0]?.textContent).toContain('Singapore');
    expect(screen.getByText('Steady.')).toBeTruthy();
  });
});

describe('the thread list', () => {
  it('lists Today first, then the trips, and switching keeps each thread its own messages', async () => {
    const today = useChatStore.getState().startThread('p1', 'c1');
    useChatStore.getState().appendMessage(today, 'user', 'Today question');
    const trip = useChatStore.getState().startThread('p1', 'c1', MAY_2019_SG);
    useChatStore.getState().renameThread(trip, '⏳ May 2019 · Singapore');
    useChatStore.getState().appendMessage(trip, 'user', 'Trip question');
    renderPanel();
    fireEvent.click(screen.getByTestId('chat-threads-button'));
    const list = screen.getByTestId('chat-thread-list');
    expect(within(list).getByTestId('chat-thread-group-today')).toBeTruthy();
    const items = within(list).getAllByTestId('chat-thread-item');
    expect(items.map((item) => item.getAttribute('data-thread-id'))).toEqual([today, trip]);
    expect(items[1]?.textContent).toContain('⏳ May 2019 · Singapore');
    fireEvent.click(within(items[0]!).getByRole('button'));
    const viewport = () => within(screen.getByTestId('chat-viewport'));
    await waitFor(() => expect(viewport().getByText('Today question')).toBeTruthy());
    expect(viewport().queryByText('Trip question')).toBeNull();
    fireEvent.click(screen.getByTestId('chat-threads-button'));
    fireEvent.click(within(screen.getAllByTestId('chat-thread-item')[1]!).getByRole('button'));
    await waitFor(() => expect(viewport().getByText('Trip question')).toBeTruthy());
    expect(viewport().queryByText('Today question')).toBeNull();
    expect(screen.getByTestId('chat-thread-title').textContent).toBe('⏳ May 2019 · Singapore');
  });
});
