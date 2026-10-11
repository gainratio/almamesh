import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { useChatStore } from '@almamesh/store';
import { hydrateLlmSettings, openRouterPreset, writeLlmSettings } from '@almamesh/llm';

vi.mock('../../../../lib/storeSaved', () => ({ waitForStoreSaved: vi.fn(async () => undefined) }));

import '../../../../i18n/config';
import type { ComponentProps } from 'react';
import { ChatPanel } from '../ChatPanel';
import { waitForStoreSaved } from '../../../../lib/storeSaved';
import { __resetMemoryForTest, __setMemoryForTest } from '../../../../lib/chatMemory';
import { useChartReanchorStatus } from '../../../../lib/chartReanchorStatus';

// 2050: stays in the future for decades, so 'future' starters do not flip with the calendar.
const YEAR_2050 = { start: '2050-01-01', end: '2050-12-31', granularity: 'year' } as const;
const PAST = { start: '2019-06-01', end: '2019-06-30', granularity: 'month' } as const;

type AskFn = NonNullable<ComponentProps<typeof ChatPanel>['onAskQuestionStream']>;

function renderPanel(onAsk = vi.fn<AskFn>(async () => ({ answer: 'ok' })), configured = true) {
  if (configured) writeLlmSettings(openRouterPreset('sk-or-v1-0000-synthetic-test-key', 'test-org/test-model'));
  render(
    <MemoryRouter>
      <ChatPanel personName="Marco" profileId="p1" chartId="c1" viewMode="layman" birthYear={1990} onAskQuestionStream={onAsk} />
    </MemoryRouter>,
  );
  return onAsk;
}

async function pinYear(year: string) {
  fireEvent.click(screen.getByTestId('time-travel-button'));
  fireEvent.click(screen.getByTestId('time-travel-tab-year'));
  fireEvent.change(screen.getByTestId('time-travel-year'), { target: { value: year } });
  fireEvent.click(screen.getByTestId('time-travel-go'));
  await screen.findByTestId('time-travel-banner');
}

beforeEach(() => {
  hydrateLlmSettings(null);
  useChatStore.setState({ threads: {}, messages: {}, summaries: {} });
  useChartReanchorStatus.setState({ pendingAttempts: new Map() });
  __setMemoryForTest({
    indexMessage: vi.fn().mockResolvedValue(undefined),
    retrieve: vi.fn().mockResolvedValue([]),
    deleteForProfile: vi.fn().mockResolvedValue(undefined),
    deleteForThread: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
  });
});
afterEach(() => {
  hydrateLlmSettings(null);
  useChatStore.setState({ threads: {}, messages: {}, summaries: {} });
  useChartReanchorStatus.setState({ pendingAttempts: new Map() });
  __resetMemoryForTest();
  vi.restoreAllMocks();
});

describe('ChatPanel time travel', () => {
  it('shows the Time travel button beside the input only when AI is configured', () => {
    renderPanel(undefined, false);
    expect(screen.queryByTestId('time-travel-button')).toBeNull();
  });

  it('the composer button shows its text label at every width (no sm:inline)', () => {
    renderPanel();
    const label = screen.getByTestId('time-travel-button').querySelector('span:not([aria-hidden])');
    expect(label?.textContent).toBe('Time travel');
    expect(label?.className ?? '').not.toMatch(/\bhidden\b/);
  });

  it('Year 2050 → Go opens a pinned thread with badge, title, banner and future starters', async () => {
    renderPanel();
    await pinYear('2050');
    expect(screen.getByTestId('time-travel-badge').textContent).toBe('⏳');
    expect(screen.getByTestId('time-travel-title').textContent?.replace(/\u00a0/g, ' ')).toBe('Time travel · 2050');
    expect(screen.getByTestId('time-travel-banner').textContent).toContain('answers are about this period');
    expect(screen.getByRole('button', { name: 'What should I prepare for?' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Which months look strongest?' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'What are my career strengths?' })).toBeNull();
    const threads = Object.values(useChatStore.getState().threads);
    expect(threads.map((thread) => thread.as_of)).toEqual([YEAR_2050]);
  });

  it('shows past starters for a pin that is over', async () => {
    useChatStore.getState().startThread('p1', 'c1', PAST);
    renderPanel();
    expect(screen.getByRole('button', { name: 'Why did this time feel hard?' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'What was this period teaching me?' })).toBeTruthy();
  });

  it('hands the pin to the page with every question', async () => {
    const onAsk = renderPanel();
    await pinYear('2050');
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Will work get easier?' } });
    fireEvent.click(screen.getByTestId('chat-send-button'));
    await waitFor(() => expect(onAsk).toHaveBeenCalled());
    expect((onAsk.mock.calls[0] as unknown[])[7]).toEqual(YEAR_2050);
  });

  it('a pinned thread can send while the chart re-anchors to a new day', async () => {
    useChatStore.getState().startThread('p1', 'c1', YEAR_2050);
    useChartReanchorStatus.getState().begin('c1', 'c1|2026-10-07');
    renderPanel();
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Will work get easier?' } });
    expect((screen.getByTestId('chat-send-button') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId('chat-reanchor-status')).toBeNull();
  });

  it('Change updates this thread\'s pin; Back to today leaves it', async () => {
    renderPanel();
    await pinYear('2050');
    fireEvent.click(screen.getByTestId('time-travel-change'));
    expect((screen.getByTestId('time-travel-year') as HTMLSelectElement).value).toBe('2050');
    fireEvent.change(screen.getByTestId('time-travel-year'), { target: { value: '2051' } });
    fireEvent.click(screen.getByTestId('time-travel-go'));
    await waitFor(() => expect(screen.getByTestId('time-travel-title').textContent?.replace(/\u00a0/g, ' ')).toBe('Time travel · 2051'));
    expect(Object.keys(useChatStore.getState().threads)).toHaveLength(1);

    await act(async () => fireEvent.click(screen.getByTestId('time-travel-back')));
    await waitFor(() => expect(screen.queryByTestId('time-travel-banner')).toBeNull());
  });

  it('a parent re-render does not wipe a draft typed in the Change sheet', async () => {
    useChatStore.getState().startThread('p1', 'c1', YEAR_2050);
    writeLlmSettings(openRouterPreset('sk-or-v1-0000-synthetic-test-key', 'test-org/test-model'));
    const onAsk = vi.fn<AskFn>();
    const tree = (
      <MemoryRouter>
        <ChatPanel personName="Marco" profileId="p1" chartId="c1" viewMode="layman" birthYear={1990} onAskQuestionStream={onAsk} />
      </MemoryRouter>
    );
    const view = render(tree);
    fireEvent.click(await screen.findByTestId('time-travel-change'));
    fireEvent.change(screen.getByTestId('time-travel-year'), { target: { value: '2051' } });
    view.rerender(tree);
    expect((screen.getByTestId('time-travel-year') as HTMLSelectElement).value).toBe('2051');
  });

  it('keeps the current eight starters for a pin that contains today', () => {
    const today = new Date().getUTCFullYear();
    useChatStore.getState().startThread('p1', 'c1', { start: `${today}-01-01`, end: `${today}-12-31`, granularity: 'year' });
    renderPanel();
    expect(screen.getByRole('button', { name: 'What are my career strengths?' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Why did this time feel hard?' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'What should I prepare for?' })).toBeNull();
  });

  it('a failed Back to today save keeps the banner, shows an alert and re-enables Back', async () => {
    renderPanel();
    await pinYear('2050');
    vi.mocked(waitForStoreSaved).mockRejectedValueOnce(new Error('disk full'));
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    await act(async () => fireEvent.click(screen.getByTestId('time-travel-back')));
    const alert = await screen.findByTestId('time-travel-back-failed');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toBe("Couldn't save this on your device. Try again.");
    expect(screen.getByTestId('time-travel-banner')).toBeTruthy();
    expect((screen.getByTestId('time-travel-back') as HTMLButtonElement).disabled).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('disables Time travel while an answer is streaming', async () => {
    const onAsk = vi.fn<AskFn>(() => new Promise(() => undefined));
    renderPanel(onAsk);
    const button = screen.getByTestId('time-travel-button') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Hello?' } });
    fireEvent.click(screen.getByTestId('chat-send-button'));
    await waitFor(() => expect(button.disabled).toBe(true));
  });
});
