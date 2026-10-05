/**
 * Test-only in-memory stand-in for the EdgeProc SQLite state store. It keeps
 * the epoch/CAS and namespace semantics the PortableStateRepository relies on,
 * so store tests exercise the real SQLite code paths without a Worker.
 * Excluded from the build (see tsconfig.json); imported by *.test.ts only.
 */
import type {
  SqliteStateImportStage,
  SqliteStateMutation,
  SqliteStateStore,
} from '@gainratio/browser/sqlite';
import { SqliteStateConflictError } from '@gainratio/browser/sqlite';

import { PORTABLE_STATE_NAMESPACE } from './portableState';

export class PortableMemoryStore implements SqliteStateStore {
  readonly name = 'portable-deletion-test';
  readonly values = new Map<string, { value: Uint8Array; revision: number }>();
  epoch = 0;
  conflictOnce = false;
  onConflict: ((store: PortableMemoryStore) => void) | undefined;
  batchDelayMs = 0;
  activeBatches = 0;
  maxActiveBatches = 0;
  failNext: Error | undefined;
  beforeBatch:
    | ((mutations: readonly SqliteStateMutation[]) => Promise<void>)
    | undefined;

  async get(namespace: string, key: string) {
    const row = this.values.get(`${namespace}/${key}`);
    return row === undefined ? undefined : { namespace, key, ...row };
  }
  async list(options: { namespace: string }) {
    const prefix = `${options.namespace}/`;
    return {
      rows: [...this.values.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, row]) => ({
          namespace: options.namespace,
          key: key.slice(prefix.length),
          ...row,
        })),
    };
  }
  async batch(mutations: readonly SqliteStateMutation[], options = {}) {
    this.activeBatches += 1;
    this.maxActiveBatches = Math.max(this.maxActiveBatches, this.activeBatches);
    try {
      await this.beforeBatch?.(mutations);
      if (this.batchDelayMs > 0) {
        await new Promise((resolve) => globalThis.setTimeout(resolve, this.batchDelayMs));
      }
      if (this.failNext !== undefined) {
        const error = this.failNext;
        this.failNext = undefined;
        throw error;
      }
      if (this.conflictOnce) {
        this.conflictOnce = false;
        this.epoch += 1;
        this.onConflict?.(this);
        throw new SqliteStateConflictError('simulated competing tab');
      }
      if (options.expectedEpoch !== undefined && options.expectedEpoch !== this.epoch) {
        throw new SqliteStateConflictError('stale');
      }
      this.epoch += 1;
      for (const mutation of mutations) {
        const key = `${mutation.namespace}/${mutation.key}`;
        if (mutation.type === 'delete') this.values.delete(key);
        else
          this.values.set(key, {
            value: mutation.value.slice(),
            revision: this.epoch,
          });
      }
      return { changed: mutations.length, epoch: this.epoch };
    } finally {
      this.activeBatches -= 1;
    }
  }
  put(namespace: string, key: string, value: Uint8Array, options = {}) {
    return this.batch([{ type: 'put', namespace, key, value }], options);
  }
  delete(namespace: string, key: string, options = {}) {
    return this.batch([{ type: 'delete', namespace, key }], options);
  }
  async runtimeInfo() {
    return {
      name: this.name,
      sqliteVersion: '3.53.4',
      persistence: 'memory' as const,
      ownership: 'isolated-worker' as const,
      schemaVersion: 1,
      epoch: this.epoch,
      rowCount: this.values.size,
    };
  }
  async checkIntegrity() {
    return { ok: true as const, message: 'ok' as const };
  }
  async exportBytes() {
    return new Uint8Array([1]);
  }
  async stageImport(): Promise<SqliteStateImportStage> {
    return {
      stageId: 'stage',
      schemaVersion: 1,
      epoch: 0,
      rowCount: 0,
      byteLength: 1,
    };
  }
  async discardImport() {}
  async commitImport() {
    return { changed: 0, epoch: this.epoch, schemaVersion: 1 };
  }
  async reset() {
    this.values.clear();
    return { changed: 0, epoch: ++this.epoch };
  }
  async migrate() {
    return { changed: 0, epoch: this.epoch, schemaVersion: 1 };
  }
  async dispose() {}

  setPortableValue(key: string, value: string): void {
    this.values.set(`${PORTABLE_STATE_NAMESPACE}/${key}`, {
      value: new TextEncoder().encode(value),
      revision: this.epoch,
    });
  }
}
