/**
 * On-device hook for `engine.computeVargaDetail` (~1–2ms in the Pyodide worker).
 *
 * Returns `null` cleanly when no engine is booted (e.g. unit tests without a
 * Worker or during cold boot) or when `division` is `null`.
 */

import { useEffect, useMemo, useState } from 'react';
import type {
  DivisionalChartId,
  SiderealChart,
  VargaDetailResult,
} from '@almamesh/browser/types';
import { useOptionalChartEngine } from '../providers/chartEngineContext';
import { buildVargaDetailInput } from '../lib/vargaDetailClient';

export function useVargaDetail(
  siderealChart: SiderealChart | null | undefined,
  division: DivisionalChartId | null,
): VargaDetailResult | null {
  const engine = useOptionalChartEngine()?.engine ?? null;
  const [detail, setDetail] = useState<VargaDetailResult | null>(null);

  const input = useMemo(
    () => (siderealChart && division ? buildVargaDetailInput(siderealChart, division) : null),
    [siderealChart, division],
  );

  useEffect(() => {
    if (!engine || !input || typeof engine.computeVargaDetail !== 'function') {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void engine
      .computeVargaDetail(input)
      .then((res) => {
        if (!cancelled) setDetail(res);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [engine, input]);

  return detail && detail.chart === division ? detail : null;
}
