import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openNodeSqlDatabase } from '@gainratio/browser/sql/node';
import type { RetrievedChunk } from '@almamesh/memory';
import { resetSessionStateForTests, useChatStore } from '@almamesh/store';

import {
  __resetMemoryForTest,
  __setMemoryForTest,
  canonicalChatMessages,
  clearMemory,
  deleteMemoryForProfile,
  deleteMemoryForThread,
  indexChatMessage,
  rebuildMemory,
  searchChatHistory,
} from '../chatMemory';
import { __setDerivedDbForTest, migrateDerivedDb, type SqlDatabase } from '../derivedDb';

let db: SqlDatabase;
let semanticHits: RetrievedChunk[] = [];

beforeEach(async () => {
  resetSessionStateForTests();
  useChatStore.setState({ threads: {}, messages: {} });
  db = await openNodeSqlDatabase({ name: `chat-keyword-${crypto.randomUUID()}` });
  await migrateDerivedDb(db);
  __setDerivedDbForTest(db);
  semanticHits = [];
  __setMemoryForTest({
    indexMessage: vi.fn().mockResolvedValue(undefined),
    retrieve: vi.fn(async () => semanticHits),
    deleteForProfile: vi.fn().mockResolvedValue(undefined),
    deleteForThread: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
  });
});

afterEach(async () => {
  __setDerivedDbForTest(undefined);
  __resetMemoryForTest();
  await db.close();
});

/** A canonical thread with one message, indexed the way useChatThread does it. */
async function say(profileId: string, content: string): Promise<{ threadId: string; messageId: string }> {
  const threadId = useChatStore.getState().startThread(profileId);
  const messageId = useChatStore.getState().appendMessage(threadId, 'user', content).id;
  await indexChatMessage({ id: messageId, thread_id: threadId, profile_id: profileId, content });
  return { threadId, messageId };
}

async function ftsMessageIds(): Promise<string[]> {
  return (await db.query<{ message_id: string }>('SELECT message_id FROM chat_fts ORDER BY message_id')).map((row) => row.message_id);
}

describe('hybrid chat search', () => {
  it('finds a message by keyword when the semantic index has nothing', async () => {
    const { messageId, threadId } = await say('p1', 'Will Saturn slow my promotion?');
    await say('p1', 'Tell me about Venus.');
    const hits = await searchChatHistory('promotion', 'p1');
    expect(hits.map((hit) => [hit.source, hit.message_id, hit.thread_id])).toEqual([['message', messageId, threadId]]);
  });

  it('finds a trip thread by its place title with no message hits', async () => {
    const { threadId } = await say('p1', 'How is work going?');
    const hits = await searchChatHistory('Singapore', 'p1', {
      titles: [{ thread_id: threadId, profile_id: 'p1', text: '⏳ May 2019 · Singapore' }],
    });
    expect(hits.map((hit) => [hit.source, hit.thread_id])).toEqual([['thread', threadId]]);
    expect((await searchChatHistory('2019', 'p1', {
      titles: [{ thread_id: threadId, profile_id: 'p1', text: '⏳ May 2019 · Singapore' }],
    })).map((hit) => hit.thread_id)).toEqual([threadId]);
  });

  it('merges semantic and keyword hits by reciprocal rank', async () => {
    const both = await say('p1', 'Jupiter blesses your career growth.');
    const keywordOnly = await say('p1', 'Career pressure peaks in March.');
    semanticHits = [
      { text: 'semantic-only', message_id: 'sem', thread_id: both.threadId, score: 0.9 },
      { text: 'Jupiter blesses', message_id: both.messageId, thread_id: both.threadId, score: 0.8 },
    ];
    const hits = await searchChatHistory('career growth', 'p1');
    // `both` is rank 2 semantic + rank 1 keyword; `sem` rank 1 semantic only.
    expect(hits.map((hit) => hit.message_id)).toEqual([both.messageId, 'sem', keywordOnly.messageId]);
  });

  it('never returns another profile messages or titles', async () => {
    await say('p1', 'my moon sign question');
    const other = await say('p2', 'their moon sign question');
    const hits = await searchChatHistory('moon', 'p2', {
      titles: [{ thread_id: 'x', profile_id: 'p1', text: 'moon trip' }],
    });
    expect(hits.map((hit) => hit.message_id)).toEqual([other.messageId]);
  });

  it('drops a keyword row whose thread is gone from the canonical chat store', async () => {
    const { threadId } = await say('p1', 'ketu axis question');
    useChatStore.getState().deleteThread(threadId);
    expect(await searchChatHistory('ketu', 'p1')).toEqual([]);
  });

  it('backfills the keyword index once from canonical chat after the upgrade', async () => {
    const threadId = useChatStore.getState().startThread('p1');
    const messageId = useChatStore.getState().appendMessage(threadId, 'user', 'an old rahu question').id;
    expect(await ftsMessageIds()).toEqual([]);
    expect((await searchChatHistory('rahu', 'p1')).map((hit) => hit.message_id)).toEqual([messageId]);
  });
});

describe('keyword index lifecycle', () => {
  it('rebuildMemory rebuilds the keyword index from durable chat', async () => {
    await say('p1', 'stale row');
    await rebuildMemory([{ id: 'restored', thread_id: 't1', profile_id: 'p1', content: 'restored mercury' }]);
    expect(await ftsMessageIds()).toEqual(['restored']);
  });

  it('deleteMemoryForProfile purges that profile keyword rows only', async () => {
    const target = await say('p1', 'target mars');
    const survivor = await say('p2', 'survivor mars');
    await deleteMemoryForProfile('p1');
    expect(await ftsMessageIds()).toEqual([survivor.messageId]);
    expect(await ftsMessageIds()).not.toContain(target.messageId);
  });

  it('deleteMemoryForThread purges that thread keyword rows only', async () => {
    const target = await say('p1', 'target sun');
    const survivor = await say('p1', 'survivor sun');
    await deleteMemoryForThread(target.threadId);
    expect(await ftsMessageIds()).toEqual([survivor.messageId]);
  });

  it('clearMemory empties the keyword index', async () => {
    await say('p1', 'anything');
    expect(await ftsMessageIds()).toHaveLength(1);
    await clearMemory();
    expect(await ftsMessageIds()).toEqual([]);
  });

  it('still purges keyword rows when the semantic purge fails, then reports the failure', async () => {
    await say('p1', 'target venus');
    expect(await ftsMessageIds()).toHaveLength(1);
    __setMemoryForTest({
      indexMessage: vi.fn(),
      retrieve: vi.fn(),
      deleteForProfile: vi.fn().mockRejectedValue(new Error('vector store gone')),
      deleteForThread: vi.fn(),
      clear: vi.fn(),
    });
    await expect(deleteMemoryForProfile('p1')).rejects.toThrow('vector store gone');
    expect(await ftsMessageIds()).toEqual([]);
  });
});

describe('keyword index failures never block chat', () => {
  function brokenDb(): SqlDatabase {
    const fail = async () => { throw new Error('OPFS gone'); };
    return { exec: fail, query: fail, transaction: fail } as unknown as SqlDatabase;
  }

  it('indexing still reaches the semantic index when the keyword write fails', async () => {
    const indexMessage = vi.fn().mockResolvedValue(undefined);
    __setMemoryForTest({ indexMessage, retrieve: vi.fn(), deleteForProfile: vi.fn(), deleteForThread: vi.fn(), clear: vi.fn() });
    __setDerivedDbForTest(brokenDb());
    await expect(indexChatMessage({ id: 'm1', thread_id: 't1', profile_id: 'p1', content: 'hello' })).resolves.toBeUndefined();
    expect(indexMessage).toHaveBeenCalledTimes(1);
  });

  it('a failed keyword rebuild still rebuilds vectors', async () => {
    const indexMessage = vi.fn().mockResolvedValue(undefined);
    __setMemoryForTest({ indexMessage, retrieve: vi.fn(), deleteForProfile: vi.fn(), deleteForThread: vi.fn(), clear: vi.fn() });
    __setDerivedDbForTest(brokenDb());
    await rebuildMemory([{ id: 'm1', thread_id: 't1', profile_id: 'p1', content: 'restored' }]);
    expect(indexMessage).toHaveBeenCalledTimes(1);
  });

  it('a failed keyword search falls back to the semantic hits', async () => {
    const threadId = useChatStore.getState().startThread('p1');
    semanticHits = [{ text: 'semantic', message_id: 'sem', thread_id: threadId, score: 0.7 }];
    __setDerivedDbForTest(brokenDb());
    expect((await searchChatHistory('anything', 'p1')).map((hit) => hit.message_id)).toEqual(['sem']);
  });

  it('without a derived database, search uses semantic and title hits only', async () => {
    const threadId = useChatStore.getState().startThread('p1');
    semanticHits = [{ text: 'semantic', message_id: 'sem', thread_id: threadId, score: 0.7 }];
    __setDerivedDbForTest(undefined);
    expect((await searchChatHistory('anything', 'p1')).map((hit) => hit.message_id)).toEqual(['sem']);
  });

  it('a blank query returns nothing', async () => {
    await say('p1', 'mars');
    expect(await searchChatHistory('   ', 'p1')).toEqual([]);
  });

  it('rebuild input skips blank and failed messages', () => {
    const threadId = useChatStore.getState().startThread('p1');
    const kept = useChatStore.getState().appendMessage(threadId, 'user', 'kept').id;
    useChatStore.getState().appendMessage(threadId, 'assistant', '   ');
    const failed = useChatStore.getState().appendMessage(threadId, 'assistant', 'boom').id;
    useChatStore.setState((state) => ({
      messages: { ...state.messages, [threadId]: (state.messages[threadId] ?? []).map((m) => (m.id === failed ? { ...m, error: true } : m)) },
    }));
    expect(canonicalChatMessages().map((message) => message.id)).toEqual([kept]);
  });
});
