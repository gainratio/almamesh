/**
 * AlmaMesh's thin domain adapter over the shared SQLite + sqlite-vector Worker.
 * Chat embeddings live in an OPFS-backed SQLite database; similarity and
 * metadata filtering execute inside sqlite-vector, never in the UI thread.
 */

import type {
  Metadata,
  VectorRecord as SharedVectorRecord,
} from "@gainratio/browser/vector";
import {
  createSqliteVectorIndex,
  type SqliteVectorRuntimeInfo,
  type SqliteVectorWorkerOptions,
  type SqliteWorkerVectorIndex,
} from "@gainratio/browser/vector/sqlite";

/** One indexed chat chunk plus the metadata needed to retrieve it. */
export interface VectorRecord {
  readonly id: string;
  readonly profile_id: string;
  readonly thread_id: string;
  readonly message_id: string;
  readonly text: string;
  readonly vector: Float32Array;
}

/** Metadata returned from SQLite; vectors stay inside the Worker. */
export type RetrievedVectorRecord = Omit<VectorRecord, "vector">;

/** A record paired with cosine similarity (one minus sqlite-vector distance). */
export interface ScoredRecord {
  readonly record: RetrievedVectorRecord;
  readonly score: number;
}

/** Shared SQLite API alias retained only as the unit-test injection type. */
export type SqliteVectorIndexLike = SqliteWorkerVectorIndex;

/** Browser-local semantic memory used by the RAG facade. */
export interface VectorStore {
  ready(): Promise<void>;
  upsert(records: readonly VectorRecord[], generation?: string | number): Promise<void>;
  deleteForProfile(profileId: string): Promise<void>;
  deleteForThread(threadId: string): Promise<void>;
  clear(): Promise<void>;
  search(
    queryVec: Float32Array,
    profileId: string,
    k: number,
    generation?: string | number,
  ): Promise<readonly ScoredRecord[]>;
  runtimeInfo(): Promise<SqliteVectorRuntimeInfo>;
  dispose(): Promise<void>;
}

export interface VectorStoreOptions {
  readonly name?: string;
  readonly dimension?: number;
  readonly generation?: () => string | number;
  /** Reads the durable deletion/restore ledger before and after each write. */
  readonly ledgerGuard?: {
    readonly acceptsWrite: (generation: string | number) => boolean | Promise<boolean>;
    readonly acceptsRead: (generation: string | number) => boolean | Promise<boolean>;
  };
  /** Unit-test seam. Production always uses createSqliteVectorIndex. */
  readonly indexFactory?: (
    options: SqliteVectorWorkerOptions,
  ) => SqliteVectorIndexLike | Promise<SqliteVectorIndexLike>;
  /** Unit-test seam for the browser OPFS capability probe. */
  readonly opfsProbe?: () => Promise<unknown>;
}

const DEFAULT_INDEX_NAME = "almamesh-chat-memory-v1";
const DEFAULT_DIMENSION = 384;

export class SemanticMemoryStorageUnavailableError extends Error {
  public readonly code = "memory.opfs_unavailable";

  public constructor(cause?: unknown) {
    super(
      "Semantic memory requires a working Origin Private File System; chat remains available without memory retrieval.",
      { cause },
    );
    this.name = "SemanticMemoryStorageUnavailableError";
  }
}

async function probeOpfs(): Promise<void> {
  const getDirectory = globalThis.navigator?.storage?.getDirectory;
  if (typeof getDirectory !== "function") {
    throw new SemanticMemoryStorageUnavailableError();
  }
  try {
    await getDirectory.call(globalThis.navigator.storage);
  } catch (error) {
    throw new SemanticMemoryStorageUnavailableError(error);
  }
}

function generationString(value: string | number | undefined): string {
  return String(value ?? 0);
}

function physicalId(generation: string, logicalId: string): string {
  return JSON.stringify([generation, logicalId]);
}

function metadataFor(record: VectorRecord, generation: string): Metadata {
  return {
    generation,
    record_id: record.id,
    profile_id: record.profile_id,
    thread_id: record.thread_id,
    message_id: record.message_id,
    text: record.text,
  };
}

function requiredString(metadata: Metadata, key: string): string {
  const value = metadata[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid SQLite vector metadata: ${key}`);
  }
  return value;
}

function fromHit(hit: {
  readonly distance: number;
  readonly metadata: Metadata;
}): ScoredRecord {
  if (!Number.isFinite(hit.distance)) {
    throw new Error("invalid SQLite vector distance");
  }
  return {
    record: {
      id: requiredString(hit.metadata, "record_id"),
      profile_id: requiredString(hit.metadata, "profile_id"),
      thread_id: requiredString(hit.metadata, "thread_id"),
      message_id: requiredString(hit.metadata, "message_id"),
      text: requiredString(hit.metadata, "text"),
    },
    score: 1 - hit.distance,
  };
}

/**
 * Build the AlmaMesh adapter. The shared Worker is opened lazily so importing
 * chat code does not claim an OPFS connection until memory is actually used.
 */
export function createVectorStore(options: VectorStoreOptions = {}): VectorStore {
  const indexOptions: SqliteVectorWorkerOptions = {
    name: options.name ?? DEFAULT_INDEX_NAME,
    dimension: options.dimension ?? DEFAULT_DIMENSION,
    persistence: "opfs",
  };
  const factory =
    options.indexFactory ??
    (async (value: SqliteVectorWorkerOptions) => {
      try {
        await (options.opfsProbe ?? probeOpfs)();
      } catch (error) {
        if (error instanceof SemanticMemoryStorageUnavailableError) throw error;
        throw new SemanticMemoryStorageUnavailableError(error);
      }
      return createSqliteVectorIndex(value);
    });
  let indexPromise: Promise<SqliteVectorIndexLike> | undefined;
  let disposed = false;

  function index(): Promise<SqliteVectorIndexLike> {
    if (disposed) {
      return Promise.reject(new Error("AlmaMesh vector store is disposed"));
    }
    indexPromise ??= Promise.resolve(factory(indexOptions));
    return indexPromise;
  }

  async function writeAccepted(generation: string | number): Promise<boolean> {
    return options.ledgerGuard === undefined
      ? true
      : options.ledgerGuard.acceptsWrite(generation);
  }

  async function readAccepted(generation: string | number): Promise<boolean> {
    return options.ledgerGuard === undefined
      ? true
      : options.ledgerGuard.acceptsRead(generation);
  }

  return {
    async ready(): Promise<void> {
      await index();
    },

    async upsert(
      records: readonly VectorRecord[],
      generation = options.generation?.() ?? 0,
    ): Promise<void> {
      if (records.length === 0 || !(await writeAccepted(generation))) {
        return;
      }
      const normalizedGeneration = generationString(generation);
      const insertedIds = records.map((record) => physicalId(normalizedGeneration, record.id));
      const opened = await index();
      await opened.insert(
        records.map((record, recordIndex): SharedVectorRecord => ({
          id: insertedIds[recordIndex],
          vector: record.vector,
          metadata: metadataFor(record, normalizedGeneration),
        })),
      );
      if (!(await writeAccepted(generation))) {
        await opened.delete(insertedIds, { generation: normalizedGeneration });
      }
    },

    async deleteForProfile(profileId: string): Promise<void> {
      await (await index()).deleteWhere({ profile_id: profileId });
    },

    async deleteForThread(threadId: string): Promise<void> {
      await (await index()).deleteWhere({ thread_id: threadId });
    },

    async clear(): Promise<void> {
      await (await index()).clear();
    },

    async search(
      queryVec: Float32Array,
      profileId: string,
      k: number,
      generation = options.generation?.() ?? 0,
    ): Promise<readonly ScoredRecord[]> {
      if (k <= 0 || !(await readAccepted(generation))) {
        return [];
      }
      const hits = await (
        await index()
      ).search(queryVec, k, {
        profile_id: profileId,
        generation: generationString(generation),
      });
      if (!(await readAccepted(generation))) {
        return [];
      }
      return hits.map(fromHit);
    },

    async runtimeInfo(): Promise<SqliteVectorRuntimeInfo> {
      return (await index()).runtimeInfo();
    },

    async dispose(): Promise<void> {
      if (disposed) {
        return;
      }
      const pending = indexPromise;
      disposed = true;
      if (pending !== undefined) {
        await (await pending).dispose();
      }
    },
  };
}
