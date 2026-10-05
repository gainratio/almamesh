import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { ChatSearch } from '../ChatSearch';
import { useChatStore } from '@almamesh/store';
import {
  __setMemoryForTest,
  __resetMemoryForTest,
  type ChatMemoryFacade,
} from '../../../../lib/chatMemory';
import { embedderStatus, __resetEmbedderStatusForTest } from '../../../../lib/embedderStatus';

const PROFILE = 'profile-X';

function seedThread(): string {
  const store = useChatStore.getState();
  const tid = store.ensureThread(PROFILE);
  store.appendMessage(tid, 'user', 'What about my career?');
  return tid;
}

function memoryReturning(threadId: string): ChatMemoryFacade {
  return {
    indexMessage: vi.fn().mockResolvedValue(undefined),
    retrieve: vi.fn().mockResolvedValue([
      { text: 'You have strong career yogas', message_id: 'm1', thread_id: threadId, score: 0.91 },
    ]),
    deleteForProfile: vi.fn().mockResolvedValue(undefined),
    deleteForThread: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
  };
}

describe('ChatSearch', () => {
  beforeEach(() => {
    useChatStore.setState({ threads: {}, messages: {} });
    __resetMemoryForTest();
  });

  afterEach(() => {
    useChatStore.setState({ threads: {}, messages: {} });
    __resetMemoryForTest();
    __resetEmbedderStatusForTest();
    vi.restoreAllMocks();
  });

  it('tells the user the on-device model is loading during the first search', async () => {
    __setMemoryForTest({
      indexMessage: vi.fn(),
      retrieve: vi.fn(() => new Promise<never>(() => undefined)),
      deleteForProfile: vi.fn().mockResolvedValue(undefined),
      deleteForThread: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    });
    // The first embed is in flight: the model is still starting.
    void embedderStatus.track({ embed: () => new Promise<never>(() => undefined) }).embed(['q']);

    render(<ChatSearch profileId={PROFILE} onOpenResult={vi.fn()} />);
    fireEvent.change(screen.getByTestId('chat-search-input'), { target: { value: 'career' } });

    const note = await screen.findByTestId('chat-search-model-loading');
    expect(note.getAttribute('role')).toBe('status');
    // i18n may or may not be initialised, depending on which test file ran first in the worker.
    expect(note.textContent).toMatch(/^(search\.loading_model|Loading on-device search \(first time only\)…)$/);
    expect(screen.queryByText(/^(search\.searching|Searching your conversations…)$/)).toBeNull();
  });

  it('shows the plain searching state once the model is resident', async () => {
    __setMemoryForTest({
      indexMessage: vi.fn(),
      retrieve: vi.fn(() => new Promise<never>(() => undefined)),
      deleteForProfile: vi.fn().mockResolvedValue(undefined),
      deleteForThread: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    });
    await embedderStatus.track({ embed: async () => [] }).embed(['warm']);

    render(<ChatSearch profileId={PROFILE} onOpenResult={vi.fn()} />);
    fireEvent.change(screen.getByTestId('chat-search-input'), { target: { value: 'career' } });

    await screen.findByText(/^(search\.searching|Searching your conversations…)$/);
    expect(screen.queryByTestId('chat-search-model-loading')).toBeNull();
  });

  it('renders a discoverable search input', () => {
    __setMemoryForTest({
      indexMessage: vi.fn(),
      retrieve: vi.fn().mockResolvedValue([]),
      deleteForProfile: vi.fn().mockResolvedValue(undefined),
      deleteForThread: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    });
    render(<ChatSearch profileId={PROFILE} onOpenResult={vi.fn()} />);
    expect(screen.getByTestId('chat-search-input')).toBeTruthy();
  });

  it('shows a result snippet, thread title, and score for a query', async () => {
    const tid = seedThread();
    __setMemoryForTest(memoryReturning(tid));

    render(<ChatSearch profileId={PROFILE} onOpenResult={vi.fn()} />);
    fireEvent.change(screen.getByTestId('chat-search-input'), {
      target: { value: 'career' },
    });

    await waitFor(() => {
      expect(screen.getByText(/You have strong career yogas/)).toBeTruthy();
    });
    // The thread title (derived from the first user message) is shown.
    expect(screen.getByText(/What about my career\?/)).toBeTruthy();
  });

  it('clicking a result calls onOpenResult with the message + thread id', async () => {
    const tid = seedThread();
    __setMemoryForTest(memoryReturning(tid));
    const onOpen = vi.fn();

    render(<ChatSearch profileId={PROFILE} onOpenResult={onOpen} />);
    fireEvent.change(screen.getByTestId('chat-search-input'), {
      target: { value: 'career' },
    });

    await waitFor(() => screen.getByTestId('chat-search-result-m1'));
    fireEvent.click(screen.getByTestId('chat-search-result-m1'));

    expect(onOpen).toHaveBeenCalledWith('m1', tid);
  });

  it('clearing the query removes the results', async () => {
    const tid = seedThread();
    __setMemoryForTest(memoryReturning(tid));

    render(<ChatSearch profileId={PROFILE} onOpenResult={vi.fn()} />);
    const input = screen.getByTestId('chat-search-input');
    fireEvent.change(input, { target: { value: 'career' } });
    await waitFor(() => screen.getByTestId('chat-search-result-m1'));

    fireEvent.change(input, { target: { value: '' } });
    await waitFor(() => {
      expect(screen.queryByTestId('chat-search-result-m1')).toBeNull();
    });
  });
});
