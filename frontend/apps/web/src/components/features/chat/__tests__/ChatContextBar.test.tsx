import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import '../../../../i18n/config';
import { hydrateLlmSettings, openRouterPreset, writeLlmSettings } from '@almamesh/llm';
import { useChatStore, useProfilesStore, whenProfilesHydrated } from '@almamesh/store';
import { __resetMemoryForTest, __setMemoryForTest } from '../../../../lib/chatMemory';
import { ChatPanel } from '../ChatPanel';
import { CopyMessageButton } from '../CopyMessageButton';

beforeAll(async () => {
  await whenProfilesHydrated();
});

describe('ChatPanel agentic UX: Context Bar (hideHeader=true), initialDraft, memory delete & copy button', () => {
  let profileId = '';

  beforeEach(() => {
    hydrateLlmSettings(null);
    writeLlmSettings(openRouterPreset('sk-or-v1-0000-test-key', 'test-org/test-model'));
    useChatStore.setState({ threads: {}, messages: {}, summaries: {} });
    act(() => {
      useProfilesStore.setState({ profiles: {}, activeProfileId: null });
      profileId = useProfilesStore.getState().createProfile('Ada');
      useProfilesStore.getState().addProfileMemoryFact(profileId, {
        category: 'career',
        text: 'Launching design studio in Q1',
        createdAt: '2026-11-11T00:00:00.000Z',
      });
    });
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
    __resetMemoryForTest();
    vi.restoreAllMocks();
  });

  it('renders Context Bar even when hideHeader={true} (FloatingChatPanel mode) and seeds initialDraft', async () => {
    render(
      <MemoryRouter>
        <ChatPanel
          personName="Ada"
          profileId={profileId}
          chartId="chart-1"
          viewMode="layman"
          hideHeader
          initialDraft="Deep dive my D9 Navamsa and D60 Shashtiamsa"
          onAskQuestionStream={vi.fn() as never}
        />
      </MemoryRouter>,
    );

    // Context bar + location chip + specialist pill + memory count render even with hideHeader=true!
    expect(screen.getByTestId('chat-context-bar')).toBeTruthy();
    expect(screen.getByTestId('chat-location-chip').textContent).toContain('Set location');
    expect(screen.getByTestId('chat-specialist-pill').getAttribute('data-specialist')).toBe('natal_varga');
    expect(screen.getByTestId('chat-memory-count').textContent).toBe('1');

    // Deep-link initialDraft seeds composer input!
    await waitFor(() => {
      expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe(
        'Deep dive my D9 Navamsa and D60 Shashtiamsa',
      );
    });

    // 1-click delete inside Memory popover removes the durable note
    fireEvent.click(screen.getByTestId('chat-memory-button'));
    expect(screen.getByTestId('chat-memory-popover').textContent).toContain('Launching design studio in Q1');
    const fact = useProfilesStore.getState().profiles[profileId]?.memoryFacts?.[0];
    expect(fact).toBeDefined();
    fireEvent.click(screen.getByTestId(`chat-memory-delete-${fact!.id}`));
    expect(useProfilesStore.getState().profiles[profileId]?.memoryFacts ?? []).toHaveLength(0);
  });

  it('CopyMessageButton keeps button enabled, uses sibling status region, and appends NBSP on consecutive copy', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    render(<CopyMessageButton text="Grounded answer text" />);
    const btn = screen.getByTestId('chat-copy-button') as HTMLButtonElement;
    const status = screen.getByTestId('chat-copy-status');

    // Sibling live region sits outside button
    expect(btn.contains(status)).toBe(false);

    await act(async () => {
      fireEvent.click(btn);
    });
    expect(writeText).toHaveBeenCalledWith('Grounded answer text');
    expect(btn.disabled).toBe(false);
    expect(status.textContent).toBe('Copied');

    // Second consecutive copy appends \u00A0 so VoiceOver re-announces
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(status.textContent).toBe('Copied\u00A0');
  });
});
