/**
 * App-side glue for `@almamesh/memory` — the in-browser, zero-egress semantic
 * memory (RAG) over chat history.
 *
 * Design:
 * - ONE lazily-booted memory singleton. The embedder Web Worker (and its ~25 MB
 *   self-hosted MiniLM model) is created only on the FIRST index/retrieve call,
 *   NOT at page load, so opening the dashboard stays cheap.
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
  type IndexableMessage,
  type RetrievedChunk,
  type VectorStore,
} from '@almamesh/memory';
import { safeWarn } from '@almamesh/shared-types';
import { readDeletionTombstones } from '@almamesh/store';

/** The slice of `ChatMemory` the UI depends on — keeps tests honest + injectable. */
export type ChatMemoryFacade = Pick<
  ChatMemory,
  'indexMessage' | 'retrieve' | 'deleteForProfile' | 'deleteForThread' | 'clear'
>;

/** Default top-k for the discoverable search box (a few more than RAG uses). */
const SEARCH_K = 8;
const SQLITE_PROOF_INDEX = 'almamesh-chat-memory-browser-proof-v1';

let singleton: ChatMemoryFacade | null = null;

function datasetGeneration(): string {
  return globalThis.localStorage?.getItem('almamesh-restore-epoch') ?? '0';
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

const vectorStore: VectorStore = createGenerationAwareVectorStore();

/**
 * Resolve the process-wide memory singleton, booting the embedder worker on
 * first use. Replaceable in tests via {@link __setMemoryForTest}.
 */
function getMemory(): ChatMemoryFacade {
  if (singleton === null) {
    // Boot the shared @almamesh/memory worker embedder: it enables local,
    // same-origin model loading (`env.allowLocalModels = true`) and forces
    // single-threaded ORT to keep embedding memory predictable even though the
    // deployed app is cross-origin isolated for shared SQLite.
    singleton = createMemory({
      embedder: createWorkerEmbedder(),
      store: vectorStore,
      generation: datasetGeneration,
    });
  }
  return singleton;
}

/** TEST SEAM: inject a fake facade so unit tests never boot the model worker. */
export function __setMemoryForTest(fake: ChatMemoryFacade): void {
  singleton = fake;
}

/** TEST SEAM: drop the singleton so the next call re-boots a fresh instance. */
export function __resetMemoryForTest(): void {
  singleton = null;
}

/**
 * Drop the memory facade after a generation change. Keep the single SQLite
 * Worker/OPFS owner alive; every query is generation-filtered and stale writes
 * are fenced by the durable deletion ledger.
 */
export function invalidateMemoryRuntime(): void {
  singleton = null;
}

/** Delete every persisted semantic-memory record owned by one profile. */
export async function deleteMemoryForProfile(profileId: string): Promise<void> {
  await getMemory().deleteForProfile(profileId);
}

/** Delete every persisted semantic-memory record owned by one chat thread. */
export async function deleteMemoryForThread(threadId: string): Promise<void> {
  await getMemory().deleteForThread(threadId);
}

/** Delete the entire persisted semantic-memory index. */
export async function clearMemory(): Promise<void> {
  await getMemory().clear();
}

/** Replace stale vectors with a complete index of restored chat messages. */
export async function rebuildMemory(messages: readonly IndexableMessage[]): Promise<void> {
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
  if (msg.content.trim().length === 0) {
    return;
  }
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
    const chunks = await getMemory().retrieve(query, profileId);
    return chunks.map((c) => c.text);
  } catch (error) {
    safeWarn('memory.retrieve_failed', error);
    return [];
  }
}

/**
 * Full semantic search for the discoverable search box: returns the complete
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
    return await getMemory().retrieve(query, profileId, k);
  } catch (error) {
    safeWarn('memory.search_failed', error);
    return [];
  }
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
