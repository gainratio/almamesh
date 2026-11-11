import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  getProfileMemoryFacts,
  MAX_MEMORY_FACT_CHARS,
  MAX_PROFILE_MEMORY_FACTS,
  sanitizeMemoryFactText,
  upsertProfileMemoryFact,
  useProfilesStore,
  whenProfilesHydrated,
} from './index';

beforeAll(async () => {
  await whenProfilesHydrated();
});

beforeEach(() => {
  useProfilesStore.setState({ profiles: {}, activeProfileId: null });
});

describe('profileMemory: pure sanitization and bounded upsert', () => {
  it('strips emails, phone numbers, and coordinates while keeping clean life context', () => {
    const raw =
      'Building a fintech startup; email me at founder@example.com or +1 (415) 555-0199 at 38.1074, -122.5697 lat: 28.6139';
    const cleaned = sanitizeMemoryFactText(raw);
    expect(cleaned).not.toContain('founder@example.com');
    expect(cleaned).not.toContain('555-0199');
    expect(cleaned).not.toContain('38.1074');
    expect(cleaned).not.toContain('122.5697');
    expect(cleaned).not.toContain('28.6139');
    expect(cleaned).toContain('Building a fintech startup');
  });

  it('caps length at 160 characters and rejects empty notes', () => {
    const long = `Starting a new chapter ${'x'.repeat(200)}`;
    expect(sanitizeMemoryFactText(long).length).toBeLessThanOrEqual(MAX_MEMORY_FACT_CHARS);
    expect(upsertProfileMemoryFact([], { text: '   ', category: 'life' })).toBeUndefined();
    expect(upsertProfileMemoryFact([], { text: 'founder@example.com', category: 'life' })).toBeUndefined();
  });

  it('deduplicates case-insensitively and enforces the 15-item cap', () => {
    const first = upsertProfileMemoryFact([], {
      text: 'Starting a fintech startup.',
      category: 'career',
      id: 'm1',
      createdAt: '2026-10-01T00:00:00Z',
    })!;
    const second = upsertProfileMemoryFact(first.facts, {
      text: 'starting a fintech startup',
      category: 'milestone',
      createdAt: '2026-10-02T00:00:00Z',
    })!;
    expect(second.facts).toHaveLength(1);
    expect(second.fact.id).toBe('m1');
    expect(second.fact.category).toBe('milestone');

    let list = second.facts;
    for (let i = 0; i < 20; i += 1) {
      list = upsertProfileMemoryFact(list, {
        text: `Context note ${i}`,
        category: 'life',
        id: `id-${i}`,
        createdAt: `2026-10-10T00:00:${String(i).padStart(2, '0')}Z`,
      })!.facts;
    }
    expect(list).toHaveLength(MAX_PROFILE_MEMORY_FACTS);
    expect(list[0]?.text).toBe('Context note 5');
    expect(list.at(-1)?.text).toBe('Context note 19');
  });

  it('ignores malformed persisted entries safely', () => {
    expect(getProfileMemoryFacts(undefined)).toEqual([]);
    expect(getProfileMemoryFacts({ memoryFacts: 'corrupt' })).toEqual([]);
    expect(
      getProfileMemoryFacts({
        memoryFacts: [
          null,
          { id: '', text: 'bad', category: 'life', createdAt: '2026-01-01T00:00:00Z' },
          { id: 'ok', text: 'Preparing for relocation', category: 'life', createdAt: '2026-01-01T00:00:00Z' },
        ],
      }),
    ).toEqual([{ id: 'ok', text: 'Preparing for relocation', category: 'life', createdAt: '2026-01-01T00:00:00Z' }]);
  });
});

describe('profileMemory: store lifecycle and profile deletion cleanup', () => {
  it('adds, removes, clears, and isolates notes per profile, cleaning up on deleteProfile and clearAll', () => {
    const store = useProfilesStore.getState();
    const ada = store.createProfile('Ada');
    const ben = store.createProfile('Ben');

    const added = useProfilesStore.getState().addProfileMemoryFact(ada, {
      text: 'Preparing for relocation to the Bay Area',
      category: 'life',
    });
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error('expected ok');
    useProfilesStore.getState().addProfileMemoryFact(ada, {
      text: 'Prefers concise bullet summaries',
      category: 'preference',
    });
    useProfilesStore.getState().addProfileMemoryFact(ben, {
      text: 'Studying music composition',
      category: 'career',
    });

    expect(getProfileMemoryFacts(useProfilesStore.getState().profiles[ada])).toHaveLength(2);
    expect(getProfileMemoryFacts(useProfilesStore.getState().profiles[ben])).toHaveLength(1);

    expect(useProfilesStore.getState().removeProfileMemoryFact(ada, added.fact.id)).toEqual({ ok: true });
    expect(getProfileMemoryFacts(useProfilesStore.getState().profiles[ada]).map((f) => f.text)).toEqual([
      'Prefers concise bullet summaries',
    ]);

    expect(useProfilesStore.getState().clearProfileMemoryFacts(ada)).toEqual({ ok: true });
    expect(getProfileMemoryFacts(useProfilesStore.getState().profiles[ada])).toEqual([]);
    expect('memoryFacts' in (useProfilesStore.getState().profiles[ada] ?? {})).toBe(false);

    // Re-add on Ben, then delete Ben -> Ben and Ben's memory notes are gone completely.
    useProfilesStore.getState().deleteProfile(ben);
    expect(useProfilesStore.getState().profiles[ben]).toBeUndefined();

    useProfilesStore.getState().addProfileMemoryFact(ada, { text: 'Launching product in Q4', category: 'milestone' });
    useProfilesStore.getState().clearAll();
    expect(useProfilesStore.getState().profiles).toEqual({});
  });
});
