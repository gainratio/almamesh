import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatThread } from '@almamesh/shared-types';
import type { DeletionTombstones } from '@almamesh/store';

import { lexicalChatMemory } from '../lexicalChatMemory';

const ledger: DeletionTombstones = {
  version: 1, activeEpoch: 0, restoreEpoch: 0, restoreInProgress: false,
  memoryRebuildPending: false, profileIds: [], threadIds: [], chartIds: [],
};
const thread = (id: string, profile = 'p'): ChatThread => ({
  id, profile_id: profile, title: null, created_at: '2026-01-01',
  updated_at: '2026-01-01', archived_at: null, message_count: 1,
});
const message = (id: string, threadId: string, content: string): ChatMessage => ({
  id, thread_id: threadId, content, role: 'assistant', created_at: '2026-01-01',
});

describe('lexicalChatMemory', () => {
  it('returns whole keywords, ignores accents/case, and never treats a substring as a keyword', () => {
    const chat = {
      threads: { t: thread('t') }, summaries: {}, messages: { t: [
        message('a', 't', 'Your chart emphasizes patient effort.'),
        message('b', 't', 'ART and Bogotá matter to your career.'),
      ] },
    };
    expect(lexicalChatMemory('art bogota', 'p', 8, chat, { p: {} }, ledger)).toEqual([
      { message_id: 'b', thread_id: 't', score: 1, text: 'ART and Bogotá matter to your career.' },
    ]);
  });

  it('has stable ties independent of thread insertion order and prefers more matching terms', () => {
    const messages = {
      z: [message('z1', 'z', 'career focus')],
      a: [message('a2', 'a', 'career focus'), message('a1', 'a', 'career focus')],
      b: [message('b1', 'b', 'career')],
    };
    const search = (threads: Record<string, ChatThread>) => lexicalChatMemory(
      'career focus', 'p', 3, { threads, messages, summaries: {} }, { p: {} }, ledger,
    );
    const forward = search({ a: thread('a'), b: thread('b'), z: thread('z') });
    const reverse = search({ z: thread('z'), b: thread('b'), a: thread('a') });
    expect(forward).toEqual(reverse);
    expect(forward.map((hit) => hit.message_id)).toEqual(['a1', 'a2', 'z1']);
  });

  it('excludes dangling message buckets, wrong-thread messages, and a missing profile', () => {
    const chat = {
      threads: { t: thread('t') }, summaries: {}, messages: {
        t: [message('wrong', 'foreign', 'career')],
        removed: [message('orphan', 'removed', 'career')],
      },
    };
    expect(lexicalChatMemory('career', 'p', 8, chat, { p: {} }, ledger)).toEqual([]);
    chat.messages.t = [message('valid', 't', 'career')];
    expect(lexicalChatMemory('career', 'p', 8, chat, {}, ledger)).toEqual([]);
  });

  it('blocks in-progress restore and mismatched generations but can read canonical history before vector rebuild', () => {
    const chat = {
      threads: { t: thread('t') }, summaries: {}, messages: { t: [message('m', 't', 'career')] },
    };
    for (const patch of [{ restoreInProgress: true }, { restoreEpoch: 1 }]) {
      expect(lexicalChatMemory('career', 'p', 8, chat, { p: {} }, { ...ledger, ...patch })).toEqual([]);
    }
    expect(lexicalChatMemory('career', 'p', 8, chat, { p: {} }, { ...ledger, memoryRebuildPending: true })).toHaveLength(1);
  });

  it('limits scanning and returns a short snippet around the matching text', () => {
    const chat = {
      threads: { t: thread('t') }, summaries: {}, messages: { t: [
        message('in-range', 't', `${'x '.repeat(400)}career ${'filler '.repeat(1_000)}`),
        message('out-of-range', 't', `${'x '.repeat(3_001)}career`),
      ] },
    };
    const hits = lexicalChatMemory('career', 'p', 8, chat, { p: {} }, ledger);
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toContain('career');
    expect(hits[0].text.length).toBeLessThanOrEqual(512);
    expect(hits[0]).not.toHaveProperty('createdAt');
  });

  it('keeps the matched keyword in snippets when decomposed accents change normalized offsets', () => {
    const chat = {
      threads: { t: thread('t') }, summaries: {}, messages: {
        t: [message('m', 't', `${'e\u0301 '.repeat(600)}career outlook`)],
      },
    };
    const hits = lexicalChatMemory('career', 'p', 8, chat, { p: {} }, ledger);
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toContain('career');
    expect(hits[0].text.length).toBeLessThanOrEqual(512);
  });
});
