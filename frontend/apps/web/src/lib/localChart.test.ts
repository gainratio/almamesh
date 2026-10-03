import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
}));

vi.mock('@almamesh/store', () => ({
  CHART_LIBRARY_FLAG_KEY: 'almamesh-chart',
  useChartLibraryStore: { getState: mocks.getState },
}));

import { hasLocalChart } from './localChart';

describe('hasLocalChart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getState.mockReturnValue({
      listAllCharts: () => [],
      listCharts: () => [],
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('reads the already-hydrated chart library without touching localStorage', () => {
    const getItem = vi.fn(() => {
      throw new DOMException('Access is denied for this document.', 'SecurityError');
    });
    vi.stubGlobal('localStorage', { getItem });
    mocks.getState.mockReturnValue({
      listAllCharts: () => [{ chart_id: 'persisted' }],
      listCharts: () => [{ chart_id: 'persisted' }],
    });

    expect(hasLocalChart()).toBe(true);
    expect(getItem).not.toHaveBeenCalled();
  });

  it('ignores a stale legacy flag when the hydrated chart library is empty', () => {
    const getItem = vi.fn(() => '1');
    vi.stubGlobal('localStorage', { getItem });

    expect(hasLocalChart()).toBe(false);
    expect(getItem).not.toHaveBeenCalled();
  });

  it('uses all charts rather than the active-profile filtered list for returning-visitor routing', () => {
    mocks.getState.mockReturnValue({
      listAllCharts: () => [{ chart_id: 'another-profile' }],
      listCharts: () => [],
    });

    expect(hasLocalChart()).toBe(true);
  });
});
