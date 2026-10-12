import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const adapter = vi.hoisted(() => ({
  rows: new Map<string, string>(),
  read: undefined as ((name: string) => Promise<string | null>) | undefined,
  writes: vi.fn(),
}));

vi.mock('./deletionTombstones', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./deletionTombstones')>()),
  deletionAwareIdbStorage: {
    getItem: (name: string) => adapter.read?.(name) ?? Promise.resolve(adapter.rows.get(name) ?? null),
    setItem: (name: string, value: string) => {
      adapter.writes(name, value);
      adapter.rows.set(name, value);
    },
    removeItem: (name: string) => void adapter.rows.delete(name),
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function bounded<T>(promise: Promise<T>): Promise<T | 'hung'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<'hung'>((resolve) => { timer = setTimeout(() => resolve('hung'), 100); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function loadStores() {
  const [charts, profiles, chat] = await Promise.all([
    import('./chartLibrary'), import('./profiles'), import('./chat'),
  ]);
  return {
    charts: { store: charts.useChartLibraryStore, wait: charts.whenChartLibraryHydrated },
    profiles: { store: profiles.useProfilesStore, wait: profiles.whenProfilesHydrated },
    chat: { store: chat.useChatStore, wait: chat.whenChatHydrated },
    migrate: profiles.runProfileMigration,
    scope: charts.setActiveProfileScope,
  };
}

const stores = [
  {
    kind: 'charts', name: 'almamesh-chart-library',
    state: { charts: { saved: { chart_id: 'saved', person_name: 'Saved person', is_primary: true } } },
  },
  {
    kind: 'profiles', name: 'almamesh-profiles',
    state: { profiles: { saved: { id: 'saved', name: 'Saved person', createdAt: '2026-10-11', avatarTint: '#C9A24B' } }, activeProfileId: 'saved' },
  },
  {
    kind: 'chat', name: 'almamesh-chat-history',
    state: { threads: { saved: { id: 'saved', profile_id: 'person', title: 'Saved conversation', created_at: '2026-10-11', updated_at: '2026-10-11', archived_at: null, message_count: 0 } }, messages: { saved: [] }, summaries: {} },
  },
] as const;

beforeEach(() => {
  vi.resetModules();
  adapter.rows.clear();
  adapter.read = undefined;
  adapter.writes.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

describe.each(stores)('$kind hydration failures', ({ kind, name, state }) => {
  it.each(['read', 'parse', 'migrate'] as const)(
    'settles a failed %s without marking ready or overwriting the saved row',
    async (failure) => {
      const pending = deferred<string | null>();
      const raw = failure === 'parse' ? '{private-invalid-json' : JSON.stringify({ state, version: 0 });
      const error = new Error('private-source-value');
      adapter.rows.set(name, raw);
      adapter.read = (key) => key === name ? pending.promise : Promise.resolve(adapter.rows.get(key) ?? null);
      const loaded = await loadStores();
      const target = loaded[kind];
      if (failure === 'migrate') {
        target.store.persist.setOptions({ migrate: async () => { throw error; } });
      }
      // These are actual persist waiters, installed before the read completes.
      const waiting = bounded(target.wait());
      if (failure === 'read') pending.reject(error);
      else pending.resolve(raw);
      const outcome = await waiting;
      expect(outcome).toMatchObject({ status: 'failed' });
      if (outcome !== 'hung' && outcome.status === 'failed') {
        if (failure === 'parse') expect(outcome.error).toBeInstanceOf(SyntaxError);
        else expect(outcome.error).toBe(error);
      }
      expect(await bounded(target.wait())).toMatchObject({ status: 'failed' });
      expect(target.store.persist.hasHydrated()).toBe(false);
      expect(target.store.getState().hydrated).toBe(false);
      expect(adapter.writes.mock.calls.filter(([key]) => key === name)).toEqual([]);
      expect(adapter.rows.get(name)).toBe(raw);
    },
  );

  it('settles a rejection with no error value instead of treating it as successful hydration', async () => {
    const pending = deferred<string | null>();
    adapter.read = (key) => key === name ? pending.promise : Promise.resolve(null);
    const loaded = await loadStores();
    const waiting = bounded(loaded[kind].wait());
    pending.reject(undefined);
    expect(await waiting).toEqual({ status: 'failed', error: undefined });
    expect(loaded[kind].store.getState().hydrated).toBe(false);
  });

  it('can explicitly rehydrate successfully after a failed read, retaining the stored state', async () => {
    const pending = deferred<string | null>();
    const raw = JSON.stringify({ state, version: 1 });
    adapter.rows.set(name, raw);
    adapter.read = (key) => key === name ? pending.promise : Promise.resolve(adapter.rows.get(key) ?? null);
    const loaded = await loadStores();
    const target = loaded[kind];
    const waiting = bounded(target.wait());
    pending.reject(new Error('read unavailable'));
    expect(await waiting).toMatchObject({ status: 'failed' });
    adapter.read = undefined;
    await target.store.persist.rehydrate();
    expect(await bounded(target.wait())).toEqual({ status: 'hydrated' });
    expect(target.store.getState()).toMatchObject({ ...state, hydrated: true });
    expect(JSON.parse(adapter.rows.get(name)!)).toMatchObject({ state });
  });

  it('refuses profile migration after its failed hydration without creating or assigning data', async () => {
    const pending = deferred<string | null>();
    adapter.rows.set('almamesh-chart-library', JSON.stringify({
      state: { charts: { orphan: { chart_id: 'orphan', person_name: 'Saved person', is_primary: true } } },
      version: 1,
    }));
    adapter.read = (key) => key === name ? pending.promise : Promise.resolve(adapter.rows.get(key) ?? null);
    const loaded = await loadStores();
    await Promise.all(stores.filter((entry) => entry.kind !== kind).map((entry) => loaded[entry.kind].wait()));
    adapter.writes.mockClear();
    const migration = bounded(loaded.migrate().then(() => 'migrated', (error: unknown) => error));
    pending.reject(new Error('private-source-value'));
    const result = await migration;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe('Profile migration requires successful hydration.');
    expect(adapter.writes).not.toHaveBeenCalled();
    expect(loaded.profiles.store.getState().listProfiles()).toEqual([]);
    expect(loaded.charts.store.getState().getChart('orphan')?.profile_id).toBeUndefined();
  });
});

it('preserves the current chart scope when profile hydration fails', async () => {
  const pending = deferred<string | null>();
  adapter.rows.set('almamesh-chart-library', JSON.stringify({
    state: { charts: {
      first: { chart_id: 'first', profile_id: 'first-person', is_primary: true },
      second: { chart_id: 'second', profile_id: 'second-person', is_primary: true },
    } }, version: 1,
  }));
  adapter.read = (key) => key === 'almamesh-profiles' ? pending.promise : Promise.resolve(adapter.rows.get(key) ?? null);
  const loaded = await loadStores();
  await loaded.charts.wait();
  loaded.scope('first-person');
  const waiting = bounded(loaded.profiles.wait());
  pending.reject(new Error('read unavailable'));
  expect(await waiting).toMatchObject({ status: 'failed' });
  expect(loaded.charts.store.getState().listCharts().map((chart) => chart.chart_id)).toEqual(['first']);
});

it('refuses migration promptly when profiles fail even if another hydration is still pending', async () => {
  const profiles = deferred<string | null>();
  const chat = deferred<string | null>();
  adapter.read = (key) => key === 'almamesh-profiles' ? profiles.promise
    : key === 'almamesh-chat-history' ? chat.promise : Promise.resolve(null);
  const loaded = await loadStores();
  await loaded.charts.wait();
  adapter.writes.mockClear();
  const result = bounded(loaded.migrate().then(() => 'migrated', (error: unknown) => error));
  profiles.reject(new Error('private-source-value'));
  expect(await result).toMatchObject({ message: 'Profile migration requires successful hydration.' });
  expect(adapter.writes).not.toHaveBeenCalled();
  // Let this independent hydration finish so the test leaves no live work.
  chat.resolve(null);
  await loaded.chat.wait();
});
