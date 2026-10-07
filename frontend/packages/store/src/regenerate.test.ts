import { describe, expect, it, vi } from 'vitest';

import type { SiderealChart } from '@almamesh/browser/types';

import golden from '../../../../backend/tests/fixtures/chart_golden_de421.json';
import type { BirthMeta } from './adapters/chart';
import { chartId, siderealChartToChartData } from './adapters/chart';
import type { RegenerateDeps } from './regenerate';
import { reanchorChart, regenerateOnBirthChange } from './regenerate';
import type { StoredChart } from './chartLibrary';

const DELHI_KEY = '1990-01-15T12:00:00+00:00';
const fakeSiderealChart = (golden as Record<string, SiderealChart>)[DELHI_KEY];

const baseBirth: BirthMeta = {
  name: 'Delhi Native',
  date: '1990-01-15',
  time: '17:30',
  latitude: 28.6139,
  longitude: 77.209,
  timezone: 'Asia/Kolkata',
  location_name: 'New Delhi, India',
};

/** The chart's reference instant — pinned here so these tests read no clock. */
const REFERENCE_INSTANT = '2024-01-01T00:00:00.000Z';

/** An in-memory chart library satisfying `RegenerateDeps['library']`. */
function makeFakeLibrary(seed: StoredChart | readonly StoredChart[]) {
  const seeded = Array.isArray(seed) ? seed : [seed];
  const charts = new Map<string, StoredChart>(seeded.map((chart) => [chart.chart_id, chart]));
  return {
    charts,
    getPrimaryChart: () => [...charts.values()].find((c) => c.is_primary),
    listAllCharts: () => [...charts.values()],
    getChart: (id: string) => charts.get(id),
    saveChart: (chart: StoredChart) => {
      for (const [id, c] of charts) {
        if (c.is_primary && c.profile_id === chart.profile_id) {
          charts.set(id, { ...c, is_primary: false });
        }
      }
      charts.set(chart.chart_id, chart);
    },
    deleteChart: (id: string) => void charts.delete(id),
    primaryFor: (profileId: string) =>
      [...charts.values()].find((c) => c.is_primary && c.profile_id === profileId),
  };
}

function seededPrimary(birth: BirthMeta, profileId: string): StoredChart {
  const data = siderealChartToChartData(fakeSiderealChart, birth, REFERENCE_INSTANT);
  return {
    ...data,
    chart_id: data.chart_id,
    person_name: birth.name,
    is_primary: true,
    profile_id: profileId,
    sidereal_chart: fakeSiderealChart,
  };
}

/** An interpretation facade for cases that do not assert on readings. */
function forgetNothing() {
  return { forgetChart: vi.fn((_chartId: string) => undefined) };
}

/** A chat facade for cases that do not assert on chat links. */
function unlinkNothing() {
  return { unlinkMissingCharts: vi.fn((_live: ReadonlySet<string>): readonly string[] => []) };
}

describe('regenerateOnBirthChange', () => {
  it('no-ops when chartId is unchanged (name is part of the id, so keep it equal)', async () => {
    const lib = makeFakeLibrary(seededPrimary(baseBirth, 'p1'));
    const engine = { generateChart: vi.fn() };
    const onRegenerated = vi.fn();
    const deps: RegenerateDeps = {
      engine,
      library: lib,
      onRegenerated,
      chat: unlinkNothing(), interpretations: forgetNothing(),
      referenceInstant: REFERENCE_INSTANT,
    };

    await regenerateOnBirthChange({ birth: baseBirth, profileId: 'p1' }, deps);

    expect(engine.generateChart).not.toHaveBeenCalled();
    expect(onRegenerated).not.toHaveBeenCalled();
    expect(lib.charts.size).toBe(1);
  });

  it('regenerates, deletes the stale-id orphan, and preserves profile_id', async () => {
    const lib = makeFakeLibrary(seededPrimary(baseBirth, 'p1'));
    const staleId = chartId(baseBirth);
    const changedBirth: BirthMeta = { ...baseBirth, time: '18:00' };
    const newId = chartId(changedBirth);
    const engine = { generateChart: vi.fn().mockResolvedValue(fakeSiderealChart) };
    const onRegenerated = vi.fn();
    const deps: RegenerateDeps = {
      engine,
      library: lib,
      onRegenerated,
      chat: unlinkNothing(), interpretations: forgetNothing(),
      referenceInstant: REFERENCE_INSTANT,
    };

    await regenerateOnBirthChange({ birth: changedBirth, profileId: 'p1' }, deps);

    expect(engine.generateChart).toHaveBeenCalledOnce();
    expect(lib.getChart(staleId)).toBeUndefined();
    expect(lib.primaryFor('p1')?.profile_id).toBe('p1');
    expect(lib.primaryFor('p1')?.chart_id).toBe(newId);
    expect(onRegenerated).toHaveBeenCalledOnce();
  });

  it('replaces only the event profile chart when another profile is active', async () => {
    const profileA = seededPrimary(baseBirth, 'profile-a');
    const profileBBirth: BirthMeta = { ...baseBirth, name: 'Mumbai Native', time: '09:15' };
    const profileB = seededPrimary(profileBBirth, 'profile-b');
    const lib = makeFakeLibrary([profileB, profileA]);
    const changedBirth: BirthMeta = { ...baseBirth, time: '18:00' };
    const engine = { generateChart: vi.fn().mockResolvedValue(fakeSiderealChart) };
    const onRegenerated = vi.fn();

    await regenerateOnBirthChange(
      { birth: changedBirth, profileId: 'profile-a' },
      { engine, library: lib, onRegenerated, chat: unlinkNothing(), interpretations: forgetNothing(), referenceInstant: REFERENCE_INSTANT },
    );

    expect(lib.getChart(profileB.chart_id)).toEqual(profileB);
    expect(lib.getChart(profileA.chart_id)).toBeUndefined();
    expect(lib.primaryFor('profile-a')?.chart_id).toBe(chartId(changedBirth));
    expect(lib.primaryFor('profile-b')).toEqual(profileB);
  });

  it('sends the engine the SAME instant it stamps on the chart', async () => {
    // The determinism claim rests on this identity. If the engine input and the
    // stored `calculation_timestamp` came from two clock reads, the generation
    // date printed on the report would not be the key that reproduces the
    // chart — which is exactly the state this seam replaced.
    const lib = makeFakeLibrary(seededPrimary(baseBirth, 'p1'));
    const engine = { generateChart: vi.fn().mockResolvedValue(fakeSiderealChart) };
    const changedBirth: BirthMeta = { ...baseBirth, time: '18:00' };

    await regenerateOnBirthChange(
      { birth: changedBirth, profileId: 'p1' },
      { engine, library: lib, onRegenerated: vi.fn(), chat: unlinkNothing(), interpretations: forgetNothing(), referenceInstant: REFERENCE_INSTANT },
    );

    const sent = engine.generateChart.mock.calls[0]?.[0] as { referenceDate: string };
    const stored = lib.primaryFor('p1');
    expect(sent.referenceDate).toBe(REFERENCE_INSTANT);
    expect(stored?.astronomical_calculations?.calculation_timestamp).toBe(REFERENCE_INSTANT);
    expect(stored?.astronomical_calculations?.calculation_timestamp).toBe(sent.referenceDate);
  });

  it('regenerates identically when the same event is replayed at the same instant', async () => {
    // Same inputs -> same stored chart. The instant is now one of the inputs,
    // so this is a statement about the whole path, not just the engine.
    const run = async (): Promise<StoredChart | undefined> => {
      const lib = makeFakeLibrary(seededPrimary(baseBirth, 'p1'));
      await regenerateOnBirthChange(
        { birth: { ...baseBirth, time: '18:00' }, profileId: 'p1' },
        {
          engine: { generateChart: vi.fn().mockResolvedValue(fakeSiderealChart) },
          library: lib,
          onRegenerated: vi.fn(),
          chat: unlinkNothing(), interpretations: forgetNothing(),
          referenceInstant: REFERENCE_INSTANT,
        },
      );
      return lib.primaryFor('p1');
    };

    expect(JSON.stringify(await run())).toBe(JSON.stringify(await run()));
  });

  it('unlinks chat threads from the chart it replaced, so export never sees a dangling chart', async () => {
    // Production 2026-10-05: a birth-time edit regenerated the chart under a
    // new id and deleted the old one, but the chat thread kept the old
    // chart_id, and Export refused the whole dataset.
    const lib = makeFakeLibrary(seededPrimary(baseBirth, 'p1'));
    const staleId = chartId(baseBirth);
    const changedBirth: BirthMeta = { ...baseBirth, time: '18:00' };
    const chat = unlinkNothing();

    await regenerateOnBirthChange(
      { birth: changedBirth, profileId: 'p1' },
      {
        engine: { generateChart: vi.fn().mockResolvedValue(fakeSiderealChart) },
        library: lib,
        onRegenerated: vi.fn(),
        chat,
        interpretations: forgetNothing(),
        referenceInstant: REFERENCE_INSTANT,
      },
    );

    expect(chat.unlinkMissingCharts).toHaveBeenCalledOnce();
    const live = chat.unlinkMissingCharts.mock.calls[0]![0];
    expect(live.has(staleId)).toBe(false);
    expect(live.has(chartId(changedBirth))).toBe(true);
  });

  it('touches no chat link on a no-op (same chart id) event', async () => {
    const lib = makeFakeLibrary(seededPrimary(baseBirth, 'p1'));
    const chat = unlinkNothing();
    const interpretations = forgetNothing();

    await regenerateOnBirthChange(
      { birth: baseBirth, profileId: 'p1' },
      { engine: { generateChart: vi.fn() }, library: lib, onRegenerated: vi.fn(), chat, interpretations, referenceInstant: REFERENCE_INSTANT },
    );

    expect(chat.unlinkMissingCharts).not.toHaveBeenCalled();
    expect(interpretations.forgetChart).not.toHaveBeenCalled();
  });

  it('forgets the replaced chart reading, so Export never meets a reading for a missing chart', async () => {
    const lib = makeFakeLibrary(seededPrimary(baseBirth, 'p1'));
    const interpretations = forgetNothing();

    await regenerateOnBirthChange(
      { birth: { ...baseBirth, name: 'Renamed Native' }, profileId: 'p1' },
      {
        engine: { generateChart: vi.fn().mockResolvedValue(fakeSiderealChart) },
        library: lib,
        onRegenerated: vi.fn(),
        chat: unlinkNothing(),
        interpretations,
        referenceInstant: REFERENCE_INSTANT,
      },
    );

    expect(interpretations.forgetChart).toHaveBeenCalledExactlyOnceWith(chartId(baseBirth));
  });

  it('serializes overlapping regenerations: the later save wins and no orphan survives', async () => {
    const lib = makeFakeLibrary(seededPrimary(baseBirth, 'p1'));
    const first: BirthMeta = { ...baseBirth, time: '18:00' };
    const second: BirthMeta = { ...baseBirth, time: '19:00' };
    // The FIRST compute is the slow one, so without serialization it lands last
    // and resurrects the older birth time over the newer one.
    const slowFirst = (input: { datetimeUtc: string }) =>
      new Promise<SiderealChart>((resolve) => {
        const delayMs = input.datetimeUtc.includes('T12:30') ? 30 : 0;
        setTimeout(() => resolve(fakeSiderealChart), delayMs);
      });
    const engine = { generateChart: vi.fn(slowFirst) };
    // A chat thread started on the ORIGINAL chart: every replaced id must be
    // unlinked by the time the queue drains, whichever run removed it.
    const threadLinks = new Set([chartId(baseBirth)]);
    const chat = {
      unlinkMissingCharts: vi.fn((live: ReadonlySet<string>): readonly string[] => {
        const dropped = [...threadLinks].filter((id) => !live.has(id));
        for (const id of dropped) threadLinks.delete(id);
        return dropped;
      }),
    };
    const interpretations = forgetNothing();
    const deps: RegenerateDeps = {
      engine,
      library: lib,
      onRegenerated: vi.fn(),
      chat,
      interpretations,
      referenceInstant: REFERENCE_INSTANT,
    };

    await Promise.all([
      regenerateOnBirthChange({ birth: first, profileId: 'p1' }, deps),
      regenerateOnBirthChange({ birth: second, profileId: 'p1' }, deps),
    ]);

    const p1Charts = lib.listAllCharts().filter((c) => c.profile_id === 'p1');
    expect(p1Charts.map((c) => c.chart_id)).toEqual([chartId(second)]);
    expect(lib.primaryFor('p1')?.chart_id).toBe(chartId(second));
    // Dependents stay consistent: no chat link and no reading points at a chart
    // that no longer exists.
    expect(threadLinks.size).toBe(0);
    const live = new Set(lib.listAllCharts().map((c) => c.chart_id));
    for (const [forgotten] of interpretations.forgetChart.mock.calls) {
      expect(live.has(forgotten)).toBe(false);
    }
    expect(interpretations.forgetChart.mock.calls.map(([id]) => id)).toEqual([
      chartId(baseBirth),
      chartId(first),
    ]);
  });

  it('keeps serving the queue after a failed regeneration', async () => {
    const lib = makeFakeLibrary(seededPrimary(baseBirth, 'p1'));
    const next: BirthMeta = { ...baseBirth, time: '19:00' };
    const engine = {
      generateChart: vi
        .fn()
        .mockRejectedValueOnce(new Error('engine crashed'))
        .mockResolvedValueOnce(fakeSiderealChart),
    };
    const deps: RegenerateDeps = {
      engine,
      library: lib,
      onRegenerated: vi.fn(),
      chat: unlinkNothing(),
      interpretations: forgetNothing(),
      referenceInstant: REFERENCE_INSTANT,
    };

    const failed = regenerateOnBirthChange({ birth: { ...baseBirth, time: '18:00' }, profileId: 'p1' }, deps);
    const succeeded = regenerateOnBirthChange({ birth: next, profileId: 'p1' }, deps);

    await expect(failed).rejects.toThrow('engine crashed');
    await succeeded;
    expect(lib.primaryFor('p1')?.chart_id).toBe(chartId(next));
  });
});

describe('reanchorChart', () => {
  const TODAY = '2026-10-07T18:00:00.000Z';

  function reanchorDeps(lib: ReturnType<typeof makeFakeLibrary>, engine: RegenerateDeps['engine']) {
    return { engine, library: lib, referenceInstant: TODAY };
  }

  it('recomputes the same chart as of the new instant, keeping its identity, birth and owner', async () => {
    const prior = seededPrimary(baseBirth, 'p1');
    const lib = makeFakeLibrary(prior);
    const engine = { generateChart: vi.fn(async () => fakeSiderealChart) };

    const saved = await reanchorChart(prior.chart_id, reanchorDeps(lib, engine));

    expect(saved).toBe(true);
    expect(engine.generateChart).toHaveBeenCalledWith({
      datetimeUtc: prior.birth_data.birth_datetime_utc,
      latitude: 28.6139,
      longitude: 77.209,
      referenceDate: TODAY,
    });
    const next = lib.getChart(prior.chart_id)!;
    expect(next.astronomical_calculations.calculation_timestamp).toBe(TODAY);
    expect(next.astronomical_calculations.calculation_timestamp).not.toBe(
      prior.astronomical_calculations.calculation_timestamp,
    );
    expect(next.birth_data).toBe(prior.birth_data);
    expect(next.person_name).toBe(prior.person_name);
    expect(next.profile_id).toBe('p1');
    expect(next.is_primary).toBe(true);
    expect(lib.charts.size).toBe(1);
  });

  it('never resurrects a chart deleted while it was computing', async () => {
    const prior = seededPrimary(baseBirth, 'p1');
    const lib = makeFakeLibrary(prior);
    const engine = {
      generateChart: vi.fn(async () => {
        lib.deleteChart(prior.chart_id);
        return fakeSiderealChart;
      }),
    };

    expect(await reanchorChart(prior.chart_id, reanchorDeps(lib, engine))).toBe(false);
    expect(lib.charts.size).toBe(0);
  });

  it('never overwrites a chart that changed while it was computing', async () => {
    const prior = seededPrimary(baseBirth, 'p1');
    const lib = makeFakeLibrary(prior);
    const renamed = { ...prior, person_name: 'Renamed' };
    const engine = {
      generateChart: vi.fn(async () => {
        lib.charts.set(prior.chart_id, renamed);
        return fakeSiderealChart;
      }),
    };

    expect(await reanchorChart(prior.chart_id, reanchorDeps(lib, engine))).toBe(false);
    expect(lib.getChart(prior.chart_id)).toBe(renamed);
  });

  it('leaves a chart without a stored birth instant alone', async () => {
    const prior = seededPrimary(baseBirth, 'p1');
    const bare = { ...prior, birth_data: {} } as unknown as StoredChart;
    const lib = makeFakeLibrary(bare);
    const engine = { generateChart: vi.fn() };

    expect(await reanchorChart(prior.chart_id, reanchorDeps(lib, engine))).toBe(false);
    expect(engine.generateChart).not.toHaveBeenCalled();
    expect(lib.getChart(prior.chart_id)).toBe(bare);
  });

  it('waits for a regeneration already queued, then re-anchors whatever it left', async () => {
    const prior = seededPrimary(baseBirth, 'p1');
    const lib = makeFakeLibrary(prior);
    const order: string[] = [];
    const engine = {
      generateChart: vi.fn(async (input: { referenceDate: string }) => {
        order.push(input.referenceDate);
        return fakeSiderealChart;
      }),
    };
    const moved: BirthMeta = { ...baseBirth, time: '18:30' };

    const regen = regenerateOnBirthChange(
      { birth: moved, profileId: 'p1' },
      {
        engine,
        library: lib,
        onRegenerated: vi.fn(),
        chat: unlinkNothing(),
        interpretations: forgetNothing(),
        referenceInstant: REFERENCE_INSTANT,
      },
    );
    const reanchor = reanchorChart(prior.chart_id, reanchorDeps(lib, engine));
    await Promise.all([regen, reanchor]);

    expect(order).toEqual([REFERENCE_INSTANT]);
    expect(await reanchor).toBe(false);
    expect(lib.getChart(prior.chart_id)).toBeUndefined();
    expect(lib.getChart(chartId(moved))).toBeDefined();
  });
});
