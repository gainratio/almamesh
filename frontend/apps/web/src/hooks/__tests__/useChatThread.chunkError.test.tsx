import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@almamesh/store';

vi.mock('../../lib/storeSaved', () => ({ waitForStoreSaved: vi.fn(async () => undefined) }));

import i18n from '../../i18n/config';
import { useAppStale } from '../../lib/appStale';
import { __resetMemoryForTest, __setMemoryForTest } from '../../lib/chatMemory';
import { describeChatStreamError, isMappedChatStreamError, useChatThread } from '../useChatThread';

// What a tab open across a deploy throws when a lazy chunk of the old build is gone (2026-10-13:
// Harish's open tab after a preview rebuild showed "Couldn't reach your AI endpoint").
const STALE_CHUNK = new TypeError('Failed to fetch dynamically imported module: http://127.0.0.1:4173/assets/placeLookup-Dx1.js');

beforeEach(() => {
  useAppStale.setState({ stale: false });
  useChatStore.setState({ threads: {}, messages: {}, summaries: {} });
  __setMemoryForTest({
    indexMessage: vi.fn().mockResolvedValue(undefined), retrieve: vi.fn().mockResolvedValue([]),
    deleteForProfile: vi.fn().mockResolvedValue(undefined), deleteForThread: vi.fn().mockResolvedValue(undefined), clear: vi.fn().mockResolvedValue(undefined),
  });
});
afterEach(() => {
  useChatStore.setState({ threads: {}, messages: {}, summaries: {} });
  __resetMemoryForTest();
});

describe('a chunk that failed to load is an app update, never an unreachable AI endpoint', () => {
  it('maps the error to "AlmaMesh was updated" copy, not endpoint_unreachable', () => {
    expect(describeChatStreamError(STALE_CHUNK)).toBe(i18n.t('chat:errors.app_updated'));
    expect(describeChatStreamError(STALE_CHUNK)).not.toBe(i18n.t('chat:errors.endpoint_unreachable'));
    expect(isMappedChatStreamError(STALE_CHUNK)).toBe(true);
    // A real network failure still says the endpoint is unreachable.
    expect(describeChatStreamError(new TypeError('Failed to fetch'))).toBe(i18n.t('chat:errors.endpoint_unreachable'));
  });

  it('a chat send that hits a stale chunk raises the update notice and leaves an update bubble', async () => {
    const { result } = renderHook(() => useChatThread('p1', null));
    await act(() => result.current.submit('How was May?', async () => { throw STALE_CHUNK; }));
    expect(useAppStale.getState().stale).toBe(true);
    const last = result.current.messages.at(-1);
    expect(last).toMatchObject({ role: 'assistant', error: true, content: i18n.t('chat:errors.app_updated') });
  });
});
