/**
 * On-device chat recall: semantic memory on full devices, bounded keyword
 * retrieval from canonical SQLite-backed chat on minimal/lite devices, and on
 * every device an SQLite FTS5 keyword index (`chatFtsRows.ts`) that search
 * fuses with the semantic results by reciprocal rank.
 *
 * Design:
 * - ONE lazily-booted memory singleton. The embedder Web Worker (its ~25 MB
 *   self-hosted MiniLM model plus onnxruntime wasm: about +80-95 MB resident)
 *   is created only on the FIRST full-device index/retrieve call,
 *   NOT at page load, so opening the dashboard stays cheap. `embedderStatus`
 *   reports that first load so the chat UI can show it; the memory-budget e2e
 *   lane fails if the model ever loads during boot.
 * - Every entry point is BEST-EFFORT: if the embedder fails (model missing, OOM,
 *   no GPU/WASM), we log a stable code and degrade gracefully. Memory is an enhancement —
 *   it must NEVER block the chat from answering.
 *
 * The heavy `@huggingface/transformers` runtime lives only inside the embedder
 * worker, so importing this module does not pull the model into the main bundle.
 */

import {
  createMemory,
  createVectorStore,
  createWorkerEmbedder,
  type ChatMemory,
  type Embedder,
  type IndexableMessage,
  type RetrievedChunk,
  type VectorStore,
} from '@almamesh/memory';
import { devicePolicy } from '@almamesh/browser';
import { safeWarn } from '@almamesh/shared-types';
import {
  areDatasetStoresCurrent,
  readDeletionTombstones,
  readObservedDatasetEpoch,
  useChatStore,
  useProfilesStore,
  whenChatHydrated,
  whenProfilesHydrated,
} from '@almamesh/store';

import { chatFtsRows, type ChatFtsRows, type ChatKeywordHit } from './chatFtsRows';
import {
  fuseByReciprocalRank,
  matchThreadTitles,
  snippetAround,
  type ChatSearchHit,
  type ThreadTitle,
} from './chatSearchFusion';
import { derivedDbAvailable } from './derivedDb';
import { embedderStatus } from './embedderStatus';
import { lexicalChatMemory } from './lexicalChatMemory';

/** The slice of `ChatMemory` the UI depends on — keeps tests honest + injectable. */
export type ChatMemoryFacade = Pick<
  ChatMemory,
  'indexMessage' | 'retrieve' | 'deleteForProfile' | 'deleteForThread' | 'clear'
>;

/** Default top-k for the discoverable search box (a few more than RAG uses). */
const SEARCH_K = 8;
const SQLITE_PROOF_INDEX = 'almamesh-chat-memory-browser-proof-v1';
const CANONICAL_RECALL_STORES = ['almamesh-chat-history', 'almamesh-profiles'] as const;

let singleton: ChatMemoryFacade | null = null;
let testOverride: ChatMemoryFacade | null = null;
let vectorStore: VectorStore | null = null;
let embedder: Embedder | null = null;
let cleanupTail: Promise<void> = Promise.resolve();

function datasetGeneration(): string {
  return String(readObservedDatasetEpoch());
}

async function acceptsVectorWrite(generation: string | number): Promise<boolean> {
  const ledger = await readDeletionTombstones();
  return (
    !ledger.restoreInProgress &&
    ledger.activeEpoch === Number(generation) &&
    ledger.restoreEpoch === ledger.activeEpoch
  );
}

async function acceptsVectorRead(generation: string | number): Promise<boolean> {
  const ledger = await readDeletionTombstones();
  return (
    !ledger.memoryRebuildPending &&
    !ledger.restoreInProgress &&
    ledger.activeEpoch === Number(generation) &&
    ledger.restoreEpoch === ledger.activeEpoch
  );
}

function createGenerationAwareVectorStore(): VectorStore {
  return createVectorStore({
    generation: datasetGeneration,
    ledgerGuard: {
      acceptsWrite: acceptsVectorWrite,
      acceptsRead: acceptsVectorRead,
    },
  });
}

/**
 * ONE embedder for the page. `createWorkerEmbedder` spawns its Worker (and loads
 * the model) only on the first `embed`, so holding it here costs nothing at
 * boot. It is dataset-independent, so it survives `invalidateMemoryRuntime`:
 * recreating it would leave the old worker (~+80-95 MB) alive beside a new one.
 * Full devices release it after ten idle minutes; constrained devices never
 * create it. Once idle for that window the worker is
 * terminated, so its model and wasm heap go back to the OS; the next search or
 * chat send reloads it, and the status store says so.
 */
function getEmbedder(): Embedder {
  embedder ??= embedderStatus.track(
    createWorkerEmbedder({
      idleReleaseMs: devicePolicy().embedderIdleReleaseMs,
      onRelease: () => embedderStatus.reset(),
    }),
  );
  return embedder;
}

function usesSemanticMemory(): boolean {
  // Explicit fake injection replaces the backend in UI tests. Real policy
  // tests never inject it, so no production model can bypass device policy.
  return testOverride !== null || devicePolicy().semanticMemoryAllowed;
}

/**
 * Resolve the process-wide memory singleton, booting the embedder worker on
 * first use. Replaceable in tests via {@link __setMemoryForTest}.
 */
function getMemory(): ChatMemoryFacade {
  if (testOverride !== null) return testOverride;
  if (singleton === null) {
    // Wire the shared worker embedder (above) into a fresh facade. The worker
    // enables local,
    // same-origin model loading (`env.allowLocalModels = true`) and forces
    // single-threaded ORT to keep embedding memory predictable even though the
    // deployed app is cross-origin isolated for shared SQLite.
    singleton = createMemory({
      embedder: getEmbedder(),
      store: vectorStore ??= createGenerationAwareVectorStore(),
      generation: datasetGeneration,
    });
  }
  return singleton;
}

/** TEST SEAM: explicitly replace the recall backend with a fake semantic facade. */
export function __setMemoryForTest(fake: ChatMemoryFacade): void {
  testOverride = fake;
}

/** TEST SEAM: drop the singleton so the next call re-boots a fresh instance. */
export function __resetMemoryForTest(): void {
  singleton = null;
  testOverride = null;
}

/**
 * Drop the memory facade after a generation change. Keep the single SQLite
 * Worker/OPFS owner alive; every query is generation-filtered and stale writes
 * are fenced by the durable deletion ledger.
 */
export function invalidateMemoryRuntime(): void {
  singleton = null;
}

/** The keyword index, or undefined where there is no derived database. */
function keywordIndex(): ChatFtsRows | undefined {
  return derivedDbAvailable() ? chatFtsRows() : undefined;
}

/**
 * Run the keyword and the semantic purge; neither failure skips the other.
 * The keyword failure is reported first: it is never a capability limit.
 */
async function purgeBoth(keyword: (rows: ChatFtsRows) => Promise<void>, semantic: () => Promise<void>): Promise<void> {
  const index = keywordIndex();
  const outcomes = await Promise.allSettled([index ? keyword(index) : Promise.resolve(), semantic()]);
  const failed = outcomes.find((outcome) => outcome.status === 'rejected');
  if (failed) throw failed.reason;
}

/** Delete every derived chat-memory record (vectors + keyword rows) of one profile. */
export async function deleteMemoryForProfile(profileId: string): Promise<void> {
  await purgeBoth((rows) => rows.deleteForProfile(profileId), async () => {
    if (usesSemanticMemory()) await getMemory().deleteForProfile(profileId);
    else await cleanOldVectors((store) => store.deleteForProfile(profileId));
  });
}

/** Delete every derived chat-memory record (vectors + keyword rows) of one thread. */
export async function deleteMemoryForThread(threadId: string): Promise<void> {
  await purgeBoth((rows) => rows.deleteForThread(threadId), async () => {
    if (usesSemanticMemory()) await getMemory().deleteForThread(threadId);
    else await cleanOldVectors((store) => store.deleteForThread(threadId));
  });
}

/** Delete the entire derived chat memory: the vector index and the keyword index. */
export async function clearMemory(): Promise<void> {
  await purgeBoth((rows) => rows.clear(), async () => {
    if (usesSemanticMemory()) await getMemory().clear();
    else await cleanOldVectors((store) => store.clear());
  });
}

/** Old vectors must still be deleted, without retaining a cleanup-only Worker. */
function cleanOldVectors(clean: (store: VectorStore) => Promise<void>): Promise<void> {
  const next = cleanupTail.then(async () => {
    const store = createGenerationAwareVectorStore();
    try {
      await clean(store);
    } finally {
      await store.dispose();
    }
  });
  cleanupTail = next.catch(() => undefined);
  return next;
}

/** Every nonblank, non-error message the user or the AI wrote (no moved-turn pointers), for rebuilds. */
export function canonicalChatMessages(): readonly IndexableMessage[] {
  const chat = useChatStore.getState();
  const messages: IndexableMessage[] = [];
  for (const thread of Object.values(chat.threads)) {
    for (const message of chat.messages[thread.id] ?? []) {
      if (message.error === true || message.role === 'system' || message.content.trim().length === 0) continue;
      messages.push({ id: message.id, thread_id: thread.id, profile_id: thread.profile_id, content: message.content });
    }
  }
  return messages;
}

function keywordRow(message: IndexableMessage) {
  return { profile_id: message.profile_id, thread_id: message.thread_id, message_id: message.id, text: message.content };
}

/**
 * Rebuild derived chat memory from durable chat: the keyword index on every
 * device (best-effort, it is a cache), vectors only on full devices.
 */
export async function rebuildMemory(messages: readonly IndexableMessage[]): Promise<void> {
  try {
    await keywordIndex()?.rebuild(messages.map(keywordRow));
  } catch (error) {
    safeWarn('memory.index_failed', error);
  }
  if (!usesSemanticMemory()) return;
  const memory = getMemory();
  await memory.clear();
  for (const message of messages) {
    if (message.content.trim().length > 0) {
      await memory.indexMessage(message);
    }
  }
}

/**
 * Chunk → embed → persist one chat message for later semantic search + RAG.
 * Best-effort: blank content is skipped, and an embedder failure is logged and
 * swallowed so it can never block the conversation.
 */
export async function indexChatMessage(msg: IndexableMessage): Promise<void> {
  if (msg.content.trim().length === 0) return;
  try {
    await keywordIndex()?.index(keywordRow(msg));
  } catch (error) {
    safeWarn('memory.index_failed', error);
  }
  if (!usesSemanticMemory()) return;
  try {
    await getMemory().indexMessage(msg);
  } catch (error) {
    safeWarn('memory.index_failed', error);
  }
}

/**
 * Retrieve the top relevant past-conversation snippets for a RAG prompt.
 * Returns just the snippet texts (the shape `streamChartChat` expects). A blank
 * query or an embedder failure degrades to an empty array.
 */
export async function retrieveContext(
  query: string,
  profileId: string,
): Promise<readonly string[]> {
  if (query.trim().length === 0) {
    return [];
  }
  try {
    if (!usesSemanticMemory()) {
      return (await retrieveCanonicalContext(query, profileId, 5)).map((chunk) => chunk.text);
    }
    const chunks = await getMemory().retrieve(query, profileId);
    return chunks.map((c) => c.text);
  } catch (error) {
    safeWarn('memory.retrieve_failed', error);
    return [];
  }
}

/**
 * Search for the discoverable search box: semantic on full devices, keyword
 * overlap on constrained devices. Returns the complete
 * {@link RetrievedChunk} records (text + provenance + score) so the UI can link
 * a hit back to its message. Best-effort; degrades to `[]` on failure.
 */
export async function searchMemory(
  query: string,
  profileId: string,
  k: number = SEARCH_K,
): Promise<readonly RetrievedChunk[]> {
  if (query.trim().length === 0) {
    return [];
  }
  try {
    if (!usesSemanticMemory()) return await retrieveCanonicalContext(query, profileId, k);
    return await getMemory().retrieve(query, profileId, k);
  } catch (error) {
    safeWarn('memory.search_failed', error);
    return [];
  }
}

/**
 * The keyword index stores no text: each hit shows a snippet of its canonical
 * chat message, and a hit whose message is gone from canonical chat is dropped.
 */
function withCanonicalText(hits: readonly ChatKeywordHit[], query: string): readonly ChatSearchHit[] {
  const messages = useChatStore.getState().messages;
  const shown: ChatSearchHit[] = [];
  for (const hit of hits) {
    const message = messages[hit.thread_id]?.find((candidate) => candidate.id === hit.message_id);
    if (!message || message.error === true || message.content.trim().length === 0) continue;
    shown.push({ source: 'message', thread_id: hit.thread_id, message_id: hit.message_id, text: snippetAround(message.content, query), score: hit.score });
  }
  return shown;
}

/** Keyword hits, backfilling the index once from hydrated canonical chat. */
async function searchKeywords(query: string, profileId: string, k: number): Promise<readonly ChatSearchHit[]> {
  const index = keywordIndex();
  if (!index) return [];
  try {
    if (!(await index.isBuilt()) && (await whenChatHydrated()).status === 'hydrated') {
      await index.rebuild(canonicalChatMessages().map(keywordRow));
    }
    return withCanonicalText(await index.search(query, profileId, k), query);
  } catch (error) {
    safeWarn('memory.search_failed', error);
    return [];
  }
}

export interface ChatHistorySearchOptions {
  /** Top-k of the fused results (default 8). */
  readonly k?: number;
  /** Searchable title text per thread (title, period and place). */
  readonly titles?: readonly ThreadTitle[];
}

/**
 * Hybrid search for the chat search box: semantic (or canonical lexical)
 * results, FTS5 keyword hits and thread-title matches, merged by reciprocal
 * rank (k=60). Every hit belongs to a live thread of `profileId` in the
 * canonical chat store. Best-effort: each retriever degrades to no hits.
 */
export async function searchChatHistory(
  query: string,
  profileId: string,
  options: ChatHistorySearchOptions = {},
): Promise<readonly ChatSearchHit[]> {
  const k = options.k ?? SEARCH_K;
  if (query.trim().length === 0) return [];
  const [semantic, keyword] = await Promise.all([searchMemory(query, profileId, k), searchKeywords(query, profileId, k)]);
  const titles = matchThreadTitles(query, options.titles ?? [], profileId);
  const threads = useChatStore.getState().threads;
  const live = (hit: ChatSearchHit) => threads[hit.thread_id]?.profile_id === profileId;
  const lists = [semantic.map((chunk) => ({ ...chunk, source: 'message' as const })), keyword, titles];
  return fuseByReciprocalRank(lists.map((list) => list.filter(live)), k);
}

async function retrieveCanonicalContext(
  query: string,
  profileId: string,
  k: number,
): Promise<readonly RetrievedChunk[]> {
  const hydrated = await Promise.all([whenChatHydrated(), whenProfilesHydrated()]);
  if (hydrated.some((outcome) => outcome.status !== 'hydrated')) return [];
  const ledger = await readDeletionTombstones();
  // A replacement can start after the initial hydration barriers settled.
  // Never scan an old snapshot while a new getItem/merge is still pending.
  if (!useChatStore.persist.hasHydrated() || !useProfilesStore.persist.hasHydrated()) return [];
  if (!areDatasetStoresCurrent(CANONICAL_RECALL_STORES, ledger.activeEpoch)) return [];
  return lexicalChatMemory(
    query, profileId, k, useChatStore.getState(), useProfilesStore.getState().profiles, ledger,
  );
}

export interface SqliteMemoryProof {
  readonly firstMessageId: string;
  readonly reopenedMessageId: string;
  readonly sqliteVersion: string;
  readonly vectorVersion: string;
  readonly vectorBackend: string;
}

/**
 * Exit-gate hook: exercise the same production SQLite Worker + OPFS adapter,
 * then close and reopen it to prove durable retrieval. The isolated proof
 * index is cleared in a finally path and is never used for real chat data.
 */
export async function verifySqliteMemoryPersistence(): Promise<SqliteMemoryProof> {
  const createProofStore = () =>
    createVectorStore({
      name: SQLITE_PROOF_INDEX,
      dimension: 3,
      generation: () => 'proof',
    });
  const expected = 'sqlite-proof-message';
  let first = createProofStore();
  try {
    await first.clear();
    await first.upsert([
      {
        id: 'nearest',
        profile_id: 'sqlite-proof-profile',
        thread_id: 'sqlite-proof-thread',
        message_id: expected,
        text: 'SQLite OPFS persistence proof',
        vector: new Float32Array([1, 0, 0]),
      },
      {
        id: 'farther',
        profile_id: 'sqlite-proof-profile',
        thread_id: 'sqlite-proof-thread',
        message_id: 'farther-message',
        text: 'A deliberately distant vector',
        vector: new Float32Array([0, 1, 0]),
      },
    ], 'proof');
    const [firstHit] = await first.search(
      new Float32Array([1, 0, 0]),
      'sqlite-proof-profile',
      1,
      'proof',
    );
    const runtime = await first.runtimeInfo();
    await first.dispose();

    first = createProofStore();
    const [reopenedHit] = await first.search(
      new Float32Array([1, 0, 0]),
      'sqlite-proof-profile',
      1,
      'proof',
    );
    return {
      firstMessageId: firstHit?.record.message_id ?? '',
      reopenedMessageId: reopenedHit?.record.message_id ?? '',
      sqliteVersion: runtime.sqliteVersion,
      vectorVersion: runtime.vectorVersion,
      vectorBackend: runtime.vectorBackend,
    };
  } finally {
    await first.clear().catch(() => undefined);
    await first.dispose().catch(() => undefined);
  }
}
