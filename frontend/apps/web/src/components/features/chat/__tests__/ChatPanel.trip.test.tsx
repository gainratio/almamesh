import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { useChartLibraryStore, useChatStore, type StoredChart } from '@almamesh/store';
import { hydrateLlmSettings, openRouterPreset, writeLlmSettings } from '@almamesh/llm';

vi.mock('../../../../lib/storeSaved', () => ({ waitForStoreSaved: vi.fn(async () => undefined) }));

// The card's trip context is built in the panel from the chart and the pin (tripContext.ts has its own tests).
const tripMock = vi.hoisted(() => ({ tripContext: vi.fn() }));
vi.mock('../../../../lib/tripContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/tripContext')>()),
  tripContext: tripMock.tripContext,
}));

import '../../../../i18n/config';
import { ChatPanel, type ChatAsk } from '../ChatPanel';
import { __resetMemoryForTest, __setMemoryForTest } from '../../../../lib/chatMemory';
import type { TripContext } from '../../../../lib/tripContext';

const SINGAPORE = { label: 'Singapore', timezone: 'Asia/Singapore', latitude: 1.29, longitude: 103.85 };
const MAY_2019_SG = { start: '2019-05-01', end: '2019-05-31', granularity: 'month', place: SINGAPORE } as const;
const STORED = { chart_id: 'c1', profile_id: 'p1', sidereal_chart: { lagna: {}, planets: {}, houses: {}, yogas: [] }, birth_data: {} } as unknown as StoredChart;
const TRIP: TripContext = {
  period: { start: '2019-05-01', end: '2019-05-31', granularity: 'month', tense: 'past', label: 'May 2019', short: 'May 2019' },
  place: { label: 'Singapore', timezone: 'Asia/Singapore', source: 'trip', display: 'Singapore' },
  today: '2026-10-13',
  natal: { lagna: { sign: 'scorpio', nakshatra: 'anuradha', pada: 1, sign_lord: 'mars' }, moon: null, planets: [], yogas: [] },
  dashas: { maha: [{ lord: 'saturn', start_month: '2017-01', end_month: '2036-01' }],
    antar: [{ maha_lord: 'saturn', lord: 'saturn', start_month: '2017-01', end_month: '2019-05' }, { maha_lord: 'saturn', lord: 'mercury', start_month: '2019-05', end_month: '2021-09' }], notes: [] },
};
function renderPanel(onAsk = vi.fn<ChatAsk>(async () => 'ok')) {
  writeLlmSettings(openRouterPreset('sk-or-v1-0000-synthetic-test-key', 'test-org/test-model'));
  render(
    <MemoryRouter>
      <ChatPanel personName="Marco" profileId="p1" chartId="c1" viewMode="layman" birthYear={1990} onAskQuestionStream={onAsk} />
    </MemoryRouter>,
  );
  return onAsk;
}

beforeEach(() => {
  hydrateLlmSettings(null);
  tripMock.tripContext.mockReset().mockReturnValue(TRIP);
  useChartLibraryStore.setState({ charts: { c1: STORED }, hydrated: true });
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
  // Contract changed 2026-10-13 (review): ONE period header row; the card shows only facts.
  it('one header row names the trip and holds Change, Back to today and Tools; the period is shown once', () => {
    useChatStore.getState().startThread('p1', 'c1', MAY_2019_SG);
    renderPanel();
    const header = screen.getByTestId('chat-thread-header');
    expect(within(header).getByTestId('chat-thread-title').textContent).toBe('⏳ May 2019 · Singapore');
    expect(within(header).getByTestId('time-travel-change')).toBeTruthy();
    expect(within(header).getByTestId('time-travel-back')).toBeTruthy();
    expect(within(header).getByTestId('chat-tools-button')).toBeTruthy();
    expect(screen.getAllByText(/May 2019/)).toHaveLength(1);
  });

  it('the context card shows the dasha, not the period or the place again', () => {
    useChatStore.getState().startThread('p1', 'c1', MAY_2019_SG);
    renderPanel();
    const card = screen.getByTestId('trip-context-card');
    expect(card.textContent).toContain('Saturn–Saturn → Saturn–Mercury');
    expect(card.textContent).not.toMatch(/May 2019|Singapore/);
  });

  it('once the AI has read the transits, the card lists the key ones', () => {
    const id = useChatStore.getState().startThread('p1', 'c1', MAY_2019_SG);
    useChatStore.getState().appendMessage(id, 'user', 'How was work?');
    useChatStore.getState().appendMessage(id, 'assistant', 'Steady.', { parts: [
      { type: 'tool-call', toolCallId: 'a', toolName: 'read_period', args: { start: '2019-05' }, status: 'complete',
        result: { sky: [{ graha: 'saturn', sign: 'sagittarius' }, { graha: 'jupiter', sign: 'scorpio' }, { graha: 'jupiter', sign: 'sagittarius' }, { graha: 'moon', sign: 'aries' }] } },
      { type: 'text', text: 'Steady.' },
    ] });
    renderPanel();
    expect(screen.getByTestId('trip-context-transits').textContent).toBe('Transits: Saturn in Sagittarius · Jupiter in Scorpio');
  });

  it('a today thread has no context card', () => {
    useChatStore.getState().startThread('p1', 'c1');
    renderPanel();
    expect(screen.queryByTestId('trip-context-card')).toBeNull();
  });

  it('the Tools chip lists the two tools the model has, in plain words', () => {
    useChatStore.getState().startThread('p1', 'c1', MAY_2019_SG);
    renderPanel();
    fireEvent.click(screen.getByTestId('chat-tools-button'));
    const rows = within(screen.getByTestId('chat-tools-list')).getAllByRole('listitem');
    expect(rows.map((row) => row.getAttribute('data-tool-name'))).toEqual(['read_period', 'travel']);
    expect(rows.map((row) => row.textContent)).toEqual(['Read a period: dashas, lords, sky, themes, dated windows', 'Travel to another time']);
  });

  it('the card is built from the stored chart and the trip pin', () => {
    useChatStore.getState().startThread('p1', 'c1', MAY_2019_SG);
    renderPanel();
    expect(tripMock.tripContext).toHaveBeenCalledWith(expect.objectContaining({ chart: STORED.sidereal_chart, asOf: expect.objectContaining({ start: '2019-05-01' }), language: 'en' }));
  });

  it('renders a row for each persisted tool call, then the answer', () => {
    const id = useChatStore.getState().startThread('p1', 'c1', MAY_2019_SG);
    useChatStore.getState().appendMessage(id, 'user', 'How was work?');
    useChatStore.getState().appendMessage(id, 'assistant', 'Steady.', { parts: [
      { type: 'tool-call', toolCallId: 'a', toolName: 'read_period', args: { start: '2019-05' }, status: 'complete', result: { period: { label: 'May 2019' }, place: { label: 'Singapore' } } },
      { type: 'tool-call', toolCallId: 'b', toolName: 'travel', args: { to: 'today', place: null }, status: 'complete', result: { status: 'queued', action: 'back_to_today' } },
      { type: 'text', text: 'Steady.' },
    ] });
    renderPanel();
    const rows = screen.getAllByTestId('chat-tool-call');
    expect(rows.map((row) => row.getAttribute('data-tool-name'))).toEqual(['read_period', 'travel']);
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

describe('starter chips', () => {
  it('wrap onto new lines instead of scrolling sideways', () => {
    useChatStore.getState().startThread('p1', 'c1');
    renderPanel();
    const row = screen.getAllByTestId('chat-suggestion')[0]!.parentElement!;
    expect(row.className).toMatch(/\bflex-wrap\b/);
    expect(row.className).not.toMatch(/overflow-x-auto/);
  });
});

describe('after the reload an app update needed', () => {
  it('reopens the thread and puts the unsent message back in the composer', async () => {
    const older = useChatStore.getState().startThread('p1', 'c1', MAY_2019_SG);
    useChatStore.getState().appendMessage(older, 'user', 'How was May?');
    useChatStore.getState().appendMessage(older, 'assistant', 'AlmaMesh was updated.', { error: true, notice: 'app_updated' });
    useChatStore.getState().startThread('p1', 'c1');
    renderPanel();
    await waitFor(() => expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe('How was May?'));
    expect(screen.getByTestId('chat-thread-title').textContent).toBe('⏳ May 2019 · Singapore');
  });
});
