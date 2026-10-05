import { describe, expect, it } from 'vitest';
import type { StoredChart } from '@almamesh/store';

import { saveTimeConfidence, type TimeConfidenceSaveDeps } from '../saveTimeConfidence';

const CHART_ID = 'c0ffee01';

function storedChart(): StoredChart {
  return {
    chart_id: CHART_ID,
    person_name: 'Reference Native',
    is_primary: true,
    birth_data: { birth_datetime_local: '1988-08-08T06:44:00', birth_time_confidence: 'exact' },
  } as unknown as StoredChart;
}

/** An in-memory chart library with a controllable durable flush. */
function deps(flush: () => Promise<void>, initial: StoredChart | null = storedChart()) {
  const charts = new Map<string, StoredChart>(initial ? [[initial.chart_id, initial]] : []);
  const saves: StoredChart[] = [];
  const value: TimeConfidenceSaveDeps = {
    getChart: (id) => charts.get(id),
    saveChart: (chart) => {
      saves.push(chart);
      charts.set(chart.chart_id, chart);
    },
    flush,
  };
  return { value, charts, saves };
}

describe('saveTimeConfidence', () => {
  it('persists the new confidence on the stored chart, keeping its identity', async () => {
    const d = deps(() => Promise.resolve());

    await expect(saveTimeConfidence(CHART_ID, 'approximate', d.value)).resolves.toBe('saved');

    const chart = d.charts.get(CHART_ID);
    expect(chart?.chart_id).toBe(CHART_ID);
    expect(chart?.birth_data?.birth_time_confidence).toBe('approximate');
    expect(chart?.birth_data?.birth_datetime_local).toBe('1988-08-08T06:44:00');
  });

  it('says not-saved and restores the old chart when the durable write fails', async () => {
    const d = deps(() => Promise.reject(new Error('SQLite write refused')));

    await expect(saveTimeConfidence(CHART_ID, 'approximate', d.value)).resolves.toBe('not-saved');

    expect(d.charts.get(CHART_ID)?.birth_data?.birth_time_confidence).toBe('exact');
  });

  it('says not-saved when there is no stored chart to update', async () => {
    const d = deps(() => Promise.resolve(), null);

    await expect(saveTimeConfidence(CHART_ID, 'approximate', d.value)).resolves.toBe('not-saved');
    expect(d.saves).toEqual([]);
  });
});
