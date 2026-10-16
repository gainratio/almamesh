import type { ChatMessage, ChatThread } from '@almamesh/shared-types';
import { describe, expect, it } from 'vitest';

import { staleDraftOf } from '../chatDraft';

const thread = (id: string, updated: string, profile = 'p1'): ChatThread => ({
  id, profile_id: profile, title: null, created_at: updated, updated_at: updated, archived_at: null, message_count: 0,
});
const msg = (id: string, role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id, thread_id: 't', role, content, created_at: '2026-10-13T10:00:00Z', ...extra,
});

describe('the unsent message survives the reload an app update needs (stored in the chat row, SQLite)', () => {
  it('finds the newest thread that ended on the app-updated notice and hands back the question before it', () => {
    const threads = { t1: thread('t1', '2026-10-13T10:00:00Z'), t2: thread('t2', '2026-10-13T11:00:00Z') };
    const messages = {
      t1: [msg('a', 'user', 'How was May?'), msg('b', 'assistant', 'AlmaMesh was updated.', { error: true, notice: 'app_updated' })],
      t2: [msg('c', 'user', 'Hi'), msg('d', 'assistant', 'Hello.')],
    };
    expect(staleDraftOf(threads, messages, 'p1')).toEqual({ threadId: 't1', text: 'How was May?' });
  });

  it('nothing to restore once the thread moved on, for another profile, or for an ordinary error', () => {
    const threads = { t1: thread('t1', '2026-10-13T10:00:00Z') };
    const answered = { t1: [msg('a', 'user', 'Q'), msg('b', 'assistant', 'x', { error: true, notice: 'app_updated' }), msg('c', 'user', 'Q'), msg('d', 'assistant', 'A')] };
    expect(staleDraftOf(threads, answered, 'p1')).toBeUndefined();
    const stale = { t1: [msg('a', 'user', 'Q'), msg('b', 'assistant', 'x', { error: true, notice: 'app_updated' })] };
    expect(staleDraftOf(threads, stale, 'p2')).toBeUndefined();
    const ordinary = { t1: [msg('a', 'user', 'Q'), msg('b', 'assistant', 'x', { error: true })] };
    expect(staleDraftOf(threads, ordinary, 'p1')).toBeUndefined();
  });
});
