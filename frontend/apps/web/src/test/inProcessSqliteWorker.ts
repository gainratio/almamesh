/**
 * Test-only stand-in for the EdgeProc SQLite state Worker.
 *
 * `createSqliteStateStore` (from `@gainratio/browser/sqlite`) talks to a
 * dedicated Worker that owns the SQLite/WASM database. Node has no `Worker`,
 * so unit tests usually mock the whole store away — which is how a legacy-v2
 * backup whose settings the real validator rejects once shipped CI-green.
 *
 * This class replaces ONLY the transport. It answers the same request/response
 * protocol the real worker does, on the same thread, against the real pinned
 * SQLite WASM runtime and the real `SqliteStateStoreDatabase`. Everything above
 * it (client, repository, validation, legacy-settings merge) runs unmodified.
 * In-memory databases only: OPFS persistence is a browser feature.
 *
 * Install with `vi.stubGlobal('Worker', InProcessSqliteWorker)`.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface SqliteRequest {
  readonly id: number;
  readonly operation: string;
  readonly [field: string]: unknown;
}

interface StateStore {
  dispose(): Promise<void>;
  [operation: string]: (...args: never[]) => unknown;
}

/** `@gainratio/browser` is a dependency of `@almamesh/store`, so resolve it from there. */
const STORE_PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/store/package.json');
const BROWSER_DIST = join(
  dirname(createRequire(STORE_PACKAGE).resolve('@gainratio/browser/package.json')),
  'dist',
);

/** The package exports no deep paths, so load its internals by file URL. */
async function loadInternal<T>(path: string): Promise<T> {
  return (await import(/* @vite-ignore */ pathToFileURL(join(BROWSER_DIST, path)).href)) as T;
}

interface SqliteModule {
  readonly oo1: { readonly DB: new (filename: string) => unknown };
}

async function openMemoryStore(options: Record<string, unknown>): Promise<StateStore> {
  if ((options.persistence ?? 'opfs') !== 'memory') {
    throw new Error('InProcessSqliteWorker only supports in-memory databases');
  }
  const [{ default: init }, { SqliteStateStoreDatabase }, { createSqliteStateRuntime }] = await Promise.all([
    loadInternal<{ default: (config: object) => Promise<SqliteModule> }>('vector/sqlite/assets/sqlite3.mjs'),
    loadInternal<{ SqliteStateStoreDatabase: new (...args: unknown[]) => StateStore }>('sqlite/database.js'),
    loadInternal<{ createSqliteStateRuntime: (sqlite: SqliteModule, raw: unknown) => { database: unknown } }>(
      'sqlite/runtime.js',
    ),
  ]);
  const wasmBinary = new Uint8Array(await readFile(join(BROWSER_DIST, 'vector/sqlite/assets/sqlite3.wasm')));
  const sqlite = await withoutOpfs(() => init({ wasmBinary, print: () => undefined, printErr: () => undefined }));
  const runtime = createSqliteStateRuntime(sqlite, new sqlite.oo1.DB(':memory:'));
  return new SqliteStateStoreDatabase(options, runtime.database, runtime, false);
}

/**
 * SQLite reads its OPFS switches from `location`; Node has none, so the init
 * would log two "inability to install opfs" warnings. Same trick as the
 * package's own Node loader (`vector/sqlite/node.js`).
 */
async function withoutOpfs<T>(init: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { href: 'https://edgeproc.invalid/?opfs-disable&opfs-wl-disable' },
  });
  try {
    return await init();
  } finally {
    if (original === undefined) Reflect.deleteProperty(globalThis, 'location');
    else Object.defineProperty(globalThis, 'location', original);
  }
}

/** Request operation → store method and its arguments, as the real worker maps them. */
const OPERATIONS: Readonly<Record<string, (request: SqliteRequest) => [string, unknown[]]>> = {
  get: (r) => ['get', [r.namespace, r.key]],
  list: (r) => ['list', [r.options]],
  batch: (r) => ['batch', [r.mutations, r.options]],
  migrate: (r) => ['migrate', [r.migration]],
  'integrity-check': () => ['checkIntegrity', []],
  export: () => ['exportBytes', []],
  'stage-import': (r) => ['stageImport', [r.bytes]],
  'discard-import': (r) => ['discardImport', [r.stageId]],
  'commit-import': (r) => ['commitImport', [r.stageId, r.options]],
  reset: (r) => ['reset', [r.options]],
  'runtime-info': () => ['runtimeInfo', []],
};

export class InProcessSqliteWorker extends EventTarget {
  #store: StateStore | undefined;
  #queue: Promise<void> = Promise.resolve();

  postMessage(request: SqliteRequest): void {
    this.#queue = this.#queue.then(() => this.#handle(request));
  }

  terminate(): void {
    this.#store = undefined;
  }

  async #handle(request: SqliteRequest): Promise<void> {
    try {
      this.#reply({ id: request.id, ok: true, value: await this.#dispatch(request) });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.#reply({ id: request.id, ok: false, error: { name: failure.name, message: failure.message } });
    }
  }

  async #dispatch(request: SqliteRequest): Promise<unknown> {
    if (request.operation === 'initialize') {
      this.#store = await openMemoryStore(request.options as Record<string, unknown>);
      return this.#store.runtimeInfo();
    }
    const store = this.#store;
    if (store === undefined) throw new Error('SQLite state worker is not initialized');
    if (request.operation === 'dispose') {
      this.#store = undefined;
      return store.dispose();
    }
    const route = OPERATIONS[request.operation];
    if (route === undefined) throw new Error(`unknown SQLite operation ${request.operation}`);
    const [method, args] = route(request);
    return (store[method] as (...values: unknown[]) => unknown)(...args);
  }

  #reply(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}
