/**
 * `@almamesh/memory` — in-browser, zero-egress semantic memory (RAG) over chat
 * history. A chat message is chunked, embedded on-device (self-hosted model in a
 * Web Worker; see {@link createWorkerEmbedder}), stored in an OPFS-backed
 * SQLite database, and retrieved by sqlite-vector in a second Worker. No
 * network, offline-first.
 *
 * The pipeline depends only on the {@link Embedder} contract, so unit tests
 * inject a deterministic stub and never load the model runtime. This module and
 * everything it imports at top level are runtime-light — the heavy
 * `@huggingface/transformers` dependency stays confined to `embedder.worker`.
 */

import { chunkText } from "./chunk";
import type { Embedder } from "./embedder";
import {
  createVectorStore,
  type VectorRecord,
  type VectorStore,
} from "./vectorStore";

export { chunkText, type ChunkOptions } from "./chunk";
export {
  createWorkerEmbedder,
  type Embedder,
  type EmbedWorkerRequest,
  type EmbedWorkerResponse,
  type WorkerEmbedderOptions,
} from "./embedder";
export {
  createVectorStore,
  SemanticMemoryStorageUnavailableError,
  type ScoredRecord,
  type SqliteVectorIndexLike,
  type VectorRecord,
  type VectorStore,
} from "./vectorStore";

/** A chat message handed to the memory index for chunking + embedding. */
export interface IndexableMessage {
  readonly id: string;
  readonly thread_id: string;
  readonly profile_id: string;
  readonly content: string;
}

/** A passage retrieved by semantic search, with its provenance and relevance. */
export interface RetrievedChunk {
  readonly text: string;
  readonly message_id: string;
  readonly thread_id: string;
  readonly score: number;
}

/** The chat-memory facade the UI uses: index a message, retrieve by query. */
export interface ChatMemory {
  /** Chunk → embed → persist a message's vectors for later retrieval. */
  indexMessage(msg: IndexableMessage): Promise<void>;
  /** Drain pending writes, then permanently delete one profile's vectors. */
  deleteForProfile(profileId: string): Promise<void>;
  /** Drain pending writes, then permanently delete one thread's vectors. */
  deleteForThread(threadId: string): Promise<void>;
  /** Drain every pending write, then clear the entire vector index. */
  clear(): Promise<void>;
  /** Embed `query`, then return the top-`k` most-similar chunks for a profile. */
  retrieve(
    query: string,
    profileId: string,
    k?: number,
  ): Promise<readonly RetrievedChunk[]>;
}

/** Injectable collaborators; `store` defaults to the OPFS SQLite vector adapter. */
export interface ChatMemoryDeps {
  readonly embedder: Embedder;
  readonly store?: VectorStore;
  /** Cross-realm dataset fence; changed generations discard stale embeddings. */
  readonly generation?: () => string | number;
}

const DEFAULT_K = 5;

/** Stable per-chunk record id: a message's chunks are addressable + replaceable. */
function chunkId(messageId: string, index: number): string {
  return `${messageId}#${index}`;
}

/**
 * Wire the chunk → embed → store pipeline behind the {@link ChatMemory} facade.
 * Pass a stub {@link Embedder} (and optionally a {@link VectorStore}) in tests.
 */
export function createMemory(deps: ChatMemoryDeps): ChatMemory {
  const store = deps.store ?? createVectorStore();
  const { embedder } = deps;
  const generation = deps.generation ?? (() => 0);
  const deletedProfiles = new Set<string>();
  const deletedThreads = new Set<string>();
  const pending = new Set<{
    readonly profileId: string;
    readonly threadId: string;
    readonly promise: Promise<void>;
  }>();
  let clearInProgress: Promise<void> | null = null;

  async function waitForClear(): Promise<void> {
    if (clearInProgress !== null) {
      await clearInProgress;
    }
  }

  async function drain(
    matches: (operation: { readonly profileId: string; readonly threadId: string }) => boolean,
  ): Promise<void> {
    const operations = Array.from(pending)
      .filter(matches)
      .map((operation) => operation.promise);
    await Promise.allSettled(operations);
  }

  async function indexNow(msg: IndexableMessage, startedInGeneration: string | number): Promise<void> {
    const chunks = chunkText(msg.content);
    if (chunks.length === 0) {
      return;
    }
    const vectors = await embedder.embed(chunks);
    if (generation() !== startedInGeneration) {
      return;
    }
    const records: VectorRecord[] = chunks.map((text, i) => ({
      id: chunkId(msg.id, i),
      profile_id: msg.profile_id,
      thread_id: msg.thread_id,
      message_id: msg.id,
      text,
      vector: vectors[i],
    }));
    await store.upsert(records, startedInGeneration);
  }

  return {
    async indexMessage(msg: IndexableMessage): Promise<void> {
      await waitForClear();
      if (deletedProfiles.has(msg.profile_id) || deletedThreads.has(msg.thread_id)) {
        return;
      }
      const operation = {
        profileId: msg.profile_id,
        threadId: msg.thread_id,
        promise: indexNow(msg, generation()),
      };
      pending.add(operation);
      try {
        await operation.promise;
      } finally {
        pending.delete(operation);
      }
    },

    async deleteForProfile(profileId: string): Promise<void> {
      await waitForClear();
      deletedProfiles.add(profileId);
      try {
        await drain((operation) => operation.profileId === profileId);
        await store.deleteForProfile(profileId);
      } catch (error) {
        deletedProfiles.delete(profileId);
        throw error;
      }
    },

    async deleteForThread(threadId: string): Promise<void> {
      await waitForClear();
      deletedThreads.add(threadId);
      try {
        await drain((operation) => operation.threadId === threadId);
        await store.deleteForThread(threadId);
      } catch (error) {
        deletedThreads.delete(threadId);
        throw error;
      }
    },

    async clear(): Promise<void> {
      await waitForClear();
      const operation = (async () => {
        await drain(() => true);
        await store.clear();
        deletedProfiles.clear();
        deletedThreads.clear();
      })();
      clearInProgress = operation;
      try {
        await operation;
      } finally {
        if (clearInProgress === operation) {
          clearInProgress = null;
        }
      }
    },

    async retrieve(
      query: string,
      profileId: string,
      k: number = DEFAULT_K,
    ): Promise<readonly RetrievedChunk[]> {
      await waitForClear();
      const startedInGeneration = generation();
      if (deletedProfiles.has(profileId)) {
        return [];
      }
      const [queryVec] = await embedder.embed([query]);
      if (queryVec === undefined || generation() !== startedInGeneration) {
        return [];
      }
      const hits = await store.search(queryVec, profileId, k, startedInGeneration);
      if (generation() !== startedInGeneration) {
        return [];
      }
      return hits.map((hit) => ({
        text: hit.record.text,
        message_id: hit.record.message_id,
        thread_id: hit.record.thread_id,
        score: hit.score,
      }));
    },
  };
}
