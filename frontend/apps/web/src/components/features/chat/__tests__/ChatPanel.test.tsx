import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { ChatPanel } from '../ChatPanel';
import { useChatStore } from '@almamesh/store';
import { hydrateLlmSettings, openRouterPreset, writeLlmSettings } from '@almamesh/llm';
import { __setMemoryForTest, __resetMemoryForTest } from '../../../../lib/chatMemory';
import { embedderStatus, __resetEmbedderStatusForTest } from '../../../../lib/embedderStatus';
import { useChartReanchorStatus } from '../../../../lib/chartReanchorStatus';

/** Configure a synthetic cloud tier so the panel's send affordance is live. */
function configureCloudAi(): void {
  writeLlmSettings(openRouterPreset('sk-or-v1-0000-synthetic-test-key', 'test-org/test-model'));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('ChatPanel — typing indicator vs streamed text', () => {
  beforeEach(() => {
    hydrateLlmSettings(null);
    // These tests exercise the live-send path, which requires a configured AI
    // tier (the panel replaces the input with the Connect-AI CTA otherwise).
    configureCloudAi();
    useChatStore.setState({ threads: {}, messages: {} });
    // Stub memory so no embedder worker boots; retrieve resolves immediately.
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
    useChatStore.setState({ threads: {}, messages: {} });
    __resetMemoryForTest();
    vi.restoreAllMocks();
  });

  it('shows the typing indicator until the first token, then yields to the streamed answer', async () => {
    let onToken: ((t: string) => void) | null = null;
    const done = deferred<{ answer: string }>();
    const onAskQuestionStream = vi.fn((_q: string, cb: (t: string) => void) => {
      onToken = cb;
      return done.promise;
    });

    render(
      <MemoryRouter>
        <ChatPanel
          personName="Test"
          profileId="profile-1"
          chartId="chart-1"
          viewMode="layman"
          onAskQuestionStream={onAskQuestionStream as never}
        />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByTestId('chat-input'), {
      target: { value: 'What is my Mars placement?' },
    });
    fireEvent.click(screen.getByTestId('chat-send-button'));

    // Awaiting the first token (incl. any retrieval/tool pause): the typing
    // indicator is visible and no answer text has rendered yet.
    expect(await screen.findByTestId('chat-loading')).toBeTruthy();
    expect(screen.getByTestId('chat-panel').textContent).not.toContain('exalted in Capricorn');

    // First streamed token arrives.
    act(() => onToken?.('Your Mars is exalted in Capricorn.'));
    await waitFor(() =>
      expect(screen.getByTestId('chat-panel').textContent).toContain('exalted in Capricorn'),
    );

    // The typing indicator yields to the streaming text.
    expect(screen.queryByTestId('chat-loading')).toBeNull();

    act(() => done.resolve({ answer: 'Your Mars is exalted in Capricorn.' }));
    await waitFor(() => expect(onAskQuestionStream).toHaveBeenCalledTimes(1));

    // Persisted: the conversation survives because it lives in the chat store.
    await waitFor(() => {
      const threadIds = Object.keys(useChatStore.getState().messages);
      expect(threadIds.length).toBe(1);
      const msgs = useChatStore.getState().messages[threadIds[0]];
      expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    });
  });

  it('says the on-device memory is loading while the first send waits for the model', async () => {
    // The memory retrieval for this send is waiting on the model's first load.
    const retrieval = deferred<never[]>();
    __setMemoryForTest({
      indexMessage: vi.fn().mockResolvedValue(undefined),
      retrieve: vi.fn(() => retrieval.promise),
      deleteForProfile: vi.fn().mockResolvedValue(undefined),
      deleteForThread: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    });
    const model = deferred<Float32Array[]>();
    const firstEmbed = embedderStatus.track({ embed: () => model.promise }).embed(['q']);

    render(
      <MemoryRouter>
        <ChatPanel
          personName="Test"
          profileId="profile-1"
          chartId="chart-1"
          viewMode="layman"
          onAskQuestionStream={vi.fn(() => new Promise<never>(() => undefined)) as never}
        />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'What about Mars?' } });
    fireEvent.click(screen.getByTestId('chat-send-button'));

    const note = await screen.findByTestId('chat-memory-loading');
    expect(note.getAttribute('role')).toBe('status');
    // i18n may or may not be initialised, depending on which test file ran first in the worker.
    expect(note.textContent).toMatch(/^(memory\.loading_model|Loading on-device memory \(first time only\)…)$/);

    act(() => model.resolve([]));
    await firstEmbed;
    await waitFor(() => expect(screen.queryByTestId('chat-memory-loading')).toBeNull());
    __resetEmbedderStatusForTest();
  });

  it('renders an error-flagged message as a distinct error bubble (not a normal turn)', async () => {
    const store = useChatStore.getState();
    const threadId = store.ensureThread('profile-1', 'chart-1');
    store.appendMessage(threadId, 'user', 'a very long question');
    store.appendMessage(
      threadId,
      'assistant',
      'That conversation is too long — ask a shorter question.',
      { error: true },
    );

    render(
      <MemoryRouter>
        <ChatPanel
          personName="Test"
          profileId="profile-1"
          chartId="chart-1"
          viewMode="layman"
          onAskQuestionStream={vi.fn() as never}
        />
      </MemoryRouter>,
    );

    const bubble = await screen.findByTestId('chat-error-bubble');
    expect(bubble.textContent).toContain('shorter question');
  });

  it('renders the normal empty state with a usable input (no setup branch)', () => {
    const onAskQuestionStream = vi.fn();
    render(
      <MemoryRouter>
        <ChatPanel
          personName="Test"
          profileId="profile-1"
          chartId="chart-1"
          viewMode="layman"
          onAskQuestionStream={onAskQuestionStream as never}
        />
      </MemoryRouter>,
    );

    // The normal empty state (not the removed setup card) is shown.
    expect(screen.queryByTestId('chat-setup')).toBeNull();
    // Search is reachable and the input is enabled with the normal placeholder.
    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
    expect(input.placeholder).toBe('Ask a question about your chart...');
    // Send button is disabled only because the input is empty (not by setup).
    expect((screen.getByTestId('chat-send-button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('always uses the agent boundary without exposing a redundant mode toggle', async () => {
    const done = deferred<{ answer: string }>();
    const onAskQuestionStream = vi.fn().mockReturnValue(done.promise);
    render(
      <MemoryRouter>
        <ChatPanel
          personName="Test"
          profileId="profile-1"
          chartId="chart-1"
          viewMode="layman"
          onAskQuestionStream={onAskQuestionStream as never}
        />
      </MemoryRouter>,
    );

    expect(screen.queryByTestId('chat-agent-mode')).toBeNull();

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'What time is it?' } });
    fireEvent.click(screen.getByTestId('chat-send-button'));

    await waitFor(() => expect(onAskQuestionStream).toHaveBeenCalledTimes(1));
    expect(typeof onAskQuestionStream.mock.calls[0][6]).toBe('function');
    // Eighth slot is the thread's pin (Time travel); a normal thread passes undefined.
    expect(onAskQuestionStream.mock.calls[0]).toHaveLength(8);
    expect(onAskQuestionStream.mock.calls[0][7]).toBeUndefined();
    expect((await screen.findByTestId('chat-agent-status')).textContent).toContain(
      'Preparing local tools',
    );

    act(() => done.resolve({ answer: 'It is 1:30 AM.' }));
    await waitFor(() => expect(screen.queryByTestId('chat-agent-status')).toBeNull());
  });

  it('opens an older conversation when a semantic-search result belongs to that thread', async () => {
    useChatStore.setState({
      threads: {
        old: {
          id: 'old',
          profile_id: 'profile-1',
          chart_id: 'chart-1',
          title: 'Earlier timing question',
          created_at: '2026-09-01T00:00:00.000Z',
          updated_at: '2026-09-01T00:00:00.000Z',
          archived_at: null,
          message_count: 2,
        },
        new: {
          id: 'new',
          profile_id: 'profile-1',
          chart_id: 'chart-1',
          title: 'Newest conversation',
          created_at: '2026-09-02T00:00:00.000Z',
          updated_at: '2026-09-02T00:00:00.000Z',
          archived_at: null,
          message_count: 2,
        },
      },
      messages: {
        old: [
          {
            id: 'old-question',
            thread_id: 'old',
            role: 'user',
            content: 'What did we say about Saturn?',
            created_at: '2026-09-01T00:00:00.000Z',
          },
          {
            id: 'old-answer',
            thread_id: 'old',
            role: 'assistant',
            content: 'OLDER THREAD SENTINEL: build patiently.',
            created_at: '2026-09-01T00:00:01.000Z',
          },
        ],
        new: [
          {
            id: 'new-question',
            thread_id: 'new',
            role: 'user',
            content: 'What is newest?',
            created_at: '2026-09-02T00:00:00.000Z',
          },
          {
            id: 'new-answer',
            thread_id: 'new',
            role: 'assistant',
            content: 'NEWEST THREAD SENTINEL',
            created_at: '2026-09-02T00:00:01.000Z',
          },
        ],
      },
      summaries: {},
    });
    __setMemoryForTest({
      indexMessage: vi.fn().mockResolvedValue(undefined),
      retrieve: vi.fn().mockResolvedValue([
        {
          text: 'OLDER THREAD SENTINEL: build patiently.',
          message_id: 'old-answer',
          thread_id: 'old',
          score: 0.92,
        },
      ]),
      deleteForProfile: vi.fn().mockResolvedValue(undefined),
      deleteForThread: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    });

    render(
      <MemoryRouter>
        <ChatPanel
          personName="Test"
          profileId="profile-1"
          chartId="chart-1"
          viewMode="layman"
          onAskQuestionStream={vi.fn() as never}
        />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('chat-panel').textContent).toContain('NEWEST THREAD SENTINEL');

    fireEvent.change(screen.getByTestId('chat-search-input'), {
      target: { value: 'Saturn' },
    });
    fireEvent.click(await screen.findByTestId('chat-search-result-old-answer'));

    await waitFor(() =>
      expect(screen.getByTestId('chat-panel').textContent).toContain(
        'OLDER THREAD SENTINEL: build patiently.',
      ),
    );
    expect(screen.getByTestId('chat-panel').textContent).not.toContain(
      'NEWEST THREAD SENTINEL',
    );
  });
});

describe('ChatPanel — no-AI-configured gate (never invite a doomed question)', () => {
  beforeEach(() => {
    hydrateLlmSettings(null);
    useChatStore.setState({ threads: {}, messages: {} });
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
    useChatStore.setState({ threads: {}, messages: {} });
    __resetMemoryForTest();
    vi.restoreAllMocks();
  });

  it('replaces the send affordance with a Connect-AI CTA when no AI is configured', () => {
    render(
      <MemoryRouter>
        <ChatPanel
          personName="Test"
          profileId="profile-1"
          chartId="chart-1"
          viewMode="layman"
          onAskQuestionStream={vi.fn() as never}
        />
      </MemoryRouter>,
    );

    // No live input/send: a typed question could only fail.
    expect(screen.queryByTestId('chat-input')).toBeNull();
    expect(screen.queryByTestId('chat-send-button')).toBeNull();
    // The existing Connect-AI CTA pattern, pointing at AI settings.
    const link = screen.getByTestId('chat-connect-ai-link');
    expect(link.getAttribute('href')).toBe('/settings/ai');
    expect(screen.getByTestId('chat-connect-ai').textContent ?? '').toContain(
      'Connect an AI model',
    );
  });

  it('a suggested-question chip routes to AI settings instead of submitting a doomed question', async () => {
    const onAskQuestionStream = vi.fn();
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route
            path="/dashboard"
            element={
              <ChatPanel
                personName="Test"
                profileId="profile-1"
                chartId="chart-1"
                viewMode="layman"
                onAskQuestionStream={onAskQuestionStream as never}
              />
            }
          />
          <Route path="/settings/ai" element={<div data-testid="ai-settings-page" />} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText('What are my career strengths?'));

    expect(await screen.findByTestId('ai-settings-page')).toBeTruthy();
    expect(onAskQuestionStream).not.toHaveBeenCalled();
    // No user turn was persisted for the doomed question.
    expect(Object.keys(useChatStore.getState().messages)).toHaveLength(0);
  });

  it('keeps the live input and send button once an AI tier is configured', () => {
    configureCloudAi();
    render(
      <MemoryRouter>
        <ChatPanel
          personName="Test"
          profileId="profile-1"
          chartId="chart-1"
          viewMode="layman"
          onAskQuestionStream={vi.fn() as never}
        />
      </MemoryRouter>,
    );

    expect(screen.queryByTestId('chat-connect-ai')).toBeNull();
    expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).disabled).toBe(false);
  });
});

describe('ChatPanel — waits for the day\'s chart re-anchor before sending', () => {
  // A returning user's first message of a new day must not race the daily
  // recompute: an answer streamed across it is discarded ("Your chart changed
  // while this answer was being written"). While the active chart re-anchors,
  // Send waits and says why; it comes back as soon as the recompute settles.
  beforeEach(() => {
    hydrateLlmSettings(null);
    configureCloudAi();
    useChatStore.setState({ threads: {}, messages: {} });
    useChartReanchorStatus.setState({ pendingChartIds: new Set() });
  });

  afterEach(() => {
    hydrateLlmSettings(null);
    useChatStore.setState({ threads: {}, messages: {} });
    useChartReanchorStatus.setState({ pendingChartIds: new Set() });
    vi.restoreAllMocks();
  });

  function renderPanel(onAsk: ReturnType<typeof vi.fn>): void {
    render(
      <MemoryRouter>
        <ChatPanel
          personName="Test"
          profileId="profile-1"
          chartId="chart-1"
          viewMode="layman"
          onAskQuestionStream={onAsk as never}
        />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByTestId('chat-input'), {
      target: { value: 'What matters for me today?' },
    });
  }

  function sendButton(): HTMLButtonElement {
    return screen.getByTestId('chat-send-button') as HTMLButtonElement;
  }

  it('disables Send with a plain status while the active chart re-anchors, then re-enables when it lands', async () => {
    useChartReanchorStatus.getState().begin('chart-1');
    const onAsk = vi.fn(() => new Promise<never>(() => undefined));
    renderPanel(onAsk);

    expect(sendButton().disabled).toBe(true);
    expect(screen.getByTestId('chat-reanchor-status').textContent).toBe(
      'Updating your chart for today…',
    );
    fireEvent.click(sendButton());
    expect(onAsk).not.toHaveBeenCalled();

    act(() => useChartReanchorStatus.getState().settle('chart-1'));
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    expect(screen.queryByTestId('chat-reanchor-status')).toBeNull();
  });

  it('ignores a re-anchor of a different chart', () => {
    useChartReanchorStatus.getState().begin('chart-other');
    renderPanel(vi.fn());

    expect(sendButton().disabled).toBe(false);
    expect(screen.queryByTestId('chat-reanchor-status')).toBeNull();
  });
});
