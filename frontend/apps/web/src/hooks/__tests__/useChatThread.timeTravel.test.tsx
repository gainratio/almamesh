import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChartLibraryStore, useChatStore, type StoredChart } from '@almamesh/store';

vi.mock('../../lib/storeSaved', () => ({ waitForStoreSaved: vi.fn(async () => undefined) }));

import i18n from '../../i18n/config';
import { __resetMemoryForTest, __setMemoryForTest } from '../../lib/chatMemory';
import { useChatThread, type ChatStreamInput } from '../useChatThread';

const PROFILE = 'profile-A';
const CHART = 'chart-A';
const YEAR = { start: '2027-01-01', end: '2027-12-31', granularity: 'year' } as const;
const JUNE = { start: '2026-06-01', end: '2026-06-30', granularity: 'month' } as const;
const NATAL = {
  snapshot_schema: '1', engine_version: 'e', ephemeris_file: 'de421.bsp', data_hash: 'd', ayanamsa: 'lahiri',
  node_type: 'mean', house_system: 'whole_sign', dasha_year_convention: '365.25',
  birth_utc: '1990-01-15T12:00:00Z', reference_date: '2026-03-08T00:00:00Z', snapshot_id: 'a'.repeat(64),
};

function chartWith(snapshot: Record<string, string>): StoredChart {
  return { chart_id: CHART, profile_id: PROFILE, person_name: 'P', is_primary: true, sidereal_chart: { snapshot } } as unknown as StoredChart;
}

function deferredStream(answer: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const stream = vi.fn(async (_input: ChatStreamInput) => {
    await gate;
    return answer;
  });
  return { stream, release };
}

beforeEach(() => {
  useChatStore.setState({ threads: {}, messages: {}, summaries: {} });
  useChartLibraryStore.setState({ charts: { [CHART]: chartWith(NATAL) } });
  __setMemoryForTest({
    indexMessage: vi.fn().mockResolvedValue(undefined),
    retrieve: vi.fn().mockResolvedValue([]),
    deleteForProfile: vi.fn().mockResolvedValue(undefined),
    deleteForThread: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
  });
});
afterEach(() => {
  useChatStore.setState({ threads: {}, messages: {}, summaries: {} });
  useChartLibraryStore.setState({ charts: {} });
  __resetMemoryForTest();
});

async function askInPin(mutate: () => void) {
  const { result } = renderHook(() => useChatThread(PROFILE, CHART));
  await act(() => result.current.pin(YEAR));
  const { stream, release } = deferredStream('Work eases in spring 2027.');
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.submit('Will work get easier?', stream);
  });
  mutate();
  await act(async () => {
    release();
    await pending;
  });
  return { result, stream };
}

describe('useChatThread in a pinned thread', () => {
  it('opens the new pinned thread and hands the pin to the stream function', async () => {
    const { result, stream } = await askInPin(() => undefined);
    expect(result.current.asOf).toEqual(YEAR);
    expect(stream.mock.calls[0]?.[0].asOf).toEqual(YEAR);
    expect(result.current.messages.at(-1)?.content).toBe('Work eases in spring 2027.');
  });

  it('drops the late answer when the pin changes mid-answer, and says why', async () => {
    const { result } = await askInPin(() => {
      const id = Object.keys(useChatStore.getState().threads)[0]!;
      useChatStore.getState().setThreadAsOf(id, JUNE);
    });
    const contents = result.current.messages.map((m) => m.content);
    expect(contents).not.toContain('Work eases in spring 2027.');
    expect(result.current.messages.at(-1)).toMatchObject({ error: true, content: i18n.t('chat:errors.pin_changed') });
  });

  it('keeps the answer across a daily re-anchor (only the analysis instant changed)', async () => {
    const { result } = await askInPin(() =>
      useChartLibraryStore.setState({
        charts: { [CHART]: chartWith({ ...NATAL, reference_date: '2026-03-09T00:00:00Z', snapshot_id: 'b'.repeat(64) }) },
      }),
    );
    expect(result.current.messages.at(-1)?.content).toBe('Work eases in spring 2027.');
  });

  it('drops the answer when the birth data changed under it', async () => {
    const { result } = await askInPin(() =>
      useChartLibraryStore.setState({
        charts: { [CHART]: chartWith({ ...NATAL, birth_utc: '1990-01-15T13:00:00Z', snapshot_id: 'c'.repeat(64) }) },
      }),
    );
    expect(result.current.messages.at(-1)).toMatchObject({ error: true, content: i18n.t('chat:errors.chart_changed') });
  });

  it('Back to today leaves the pinned thread', async () => {
    const { result } = renderHook(() => useChatThread(PROFILE, CHART));
    await act(() => result.current.pin(YEAR));
    await act(() => result.current.backToToday());
    expect(result.current.asOf).toBeUndefined();
  });

  it('an unpinned thread sends no asOf', async () => {
    const { result } = renderHook(() => useChatThread(PROFILE, CHART));
    const { stream, release } = deferredStream('Fine.');
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.submit('How is today?', stream);
    });
    await act(async () => {
      release();
      await pending;
    });
    expect(stream.mock.calls[0]?.[0]).not.toHaveProperty('asOf');
  });
});

describe('a thread deleted mid-answer', () => {
  it('does not throw and leaves nothing behind', async () => {
    await askInPin(() => {
      const id = Object.keys(useChatStore.getState().threads)[0]!;
      useChatStore.getState().deleteThread(id);
    });
    expect(useChatStore.getState().listThreads(PROFILE)).toEqual([]);
  });
});
