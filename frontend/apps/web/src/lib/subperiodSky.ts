/**
 * `subperiodSky` — pure date-range filtering and dual-voice formatting for
 * engine-emitted `TransitCtx` slow hits, timeline events, and Sade Sati phases
 * falling inside a Vimśottarī sub-period `[startDate, endDate]`.
 */
import type { TFunction } from 'i18next';
import type {
  SadeSatiData,
  SadeSatiSegmentData,
  TransitCtx,
  TransitTimelineEventData,
} from '@almamesh/shared-types';
import { formatPredictiveWindowBound, sortSlowHits } from './predictive';

export type SlowHitItem = TransitCtx['slow_hits'][number];
import {
  grahaName,
  sadeSatiPhaseName,
  slowHitTargetLabel,
  timelineEventLabel,
} from './predictiveEventCopy';
import type { SubperiodAudience } from './subperiodGuide';

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface SpanBounds {
  readonly startMs: number;
  readonly endMs: number;
  readonly endExclusive: boolean;
}

export function parseSpanBounds(startDate: string, endDate: string): SpanBounds {
  const startMs = DATE_ONLY_RE.test(startDate)
    ? Date.parse(`${startDate}T00:00:00.000Z`)
    : Date.parse(startDate);
  const endIsDateOnly = DATE_ONLY_RE.test(endDate);
  const endMs = endIsDateOnly ? Date.parse(`${endDate}T23:59:59.999Z`) : Date.parse(endDate);
  return { startMs, endMs, endExclusive: !endIsDateOnly };
}

function parseInstantMs(iso: string): number {
  return DATE_ONLY_RE.test(iso) ? Date.parse(`${iso}T12:00:00.000Z`) : Date.parse(iso);
}

export function isInstantInSpan(iso: string, bounds: SpanBounds): { ok: boolean; ms: number } {
  const ms = parseInstantMs(iso);
  if (!Number.isFinite(ms) || !Number.isFinite(bounds.startMs) || !Number.isFinite(bounds.endMs)) {
    return { ok: false, ms };
  }
  const withinEnd = bounds.endExclusive ? ms < bounds.endMs : ms <= bounds.endMs;
  return { ok: ms >= bounds.startMs && withinEnd, ms };
}

function laymanHitTarget(t: TFunction, natalPoint: string): string {
  if (natalPoint === 'moon') return t('predictive:subperiod.sky.target_moon_layman');
  if (natalPoint === 'lagna') return t('predictive:subperiod.sky.target_lagna_layman');
  return t('predictive:subperiod.sky.target_planet_layman');
}

function laymanTimelineLine(t: TFunction, event: TransitTimelineEventData): string | null {
  if (event.kind === 'sign_ingress') return t('predictive:subperiod.sky.event_ingress_layman');
  if (event.kind === 'return') return t('predictive:subperiod.sky.event_return_layman');
  if (event.kind === 'station') {
    const key = event.station_direction === 'retrograde' ? 'event_station_retro_layman' : 'event_station_direct_layman';
    return t(`predictive:subperiod.sky.${key}`);
  }
  return null;
}

function selectOverlappingSadeSati(sadeSati: SadeSatiData, bounds: SpanBounds): SadeSatiSegmentData | null {
  let best: { seg: SadeSatiSegmentData; overlap: number; isCurrent: boolean } | null = null;
  for (const seg of sadeSati.cycle) {
    const segStart = DATE_ONLY_RE.test(seg.start) ? Date.parse(`${seg.start}T00:00:00.000Z`) : Date.parse(seg.start);
    const segEnd = DATE_ONLY_RE.test(seg.end) ? Date.parse(`${seg.end}T23:59:59.999Z`) : Date.parse(seg.end);
    const overlap = Math.min(segEnd, bounds.endMs) - Math.max(segStart, bounds.startMs);
    if (!Number.isFinite(overlap) || overlap <= 0) continue;
    const isCurrent = sadeSati.is_active && seg.phase === sadeSati.current_phase;
    if (!best || (isCurrent && !best.isCurrent) || (isCurrent === best.isCurrent && overlap > best.overlap)) {
      best = { seg, overlap, isCurrent };
    }
  }
  return best?.seg ?? null;
}

export function collectSkyBullets(params: {
  readonly t: TFunction;
  readonly transitCtx?: TransitCtx;
  readonly sortedHits?: readonly SlowHitItem[];
  readonly startDate: string;
  readonly endDate: string;
  readonly audience: SubperiodAudience;
}): string[] {
  const { t, transitCtx, startDate, endDate, audience } = params;
  if (!transitCtx) return [];
  const bounds = parseSpanBounds(startDate, endDate);
  const dated: { ms: number; line: string }[] = [];

  for (const hit of params.sortedHits ?? sortSlowHits(transitCtx.slow_hits)) {
    const check = isInstantInSpan(hit.exact, bounds);
    if (!check.ok) continue;
    const date = formatPredictiveWindowBound(hit.exact);
    const tone = t(`predictive:severity.${hit.severity}`).toLowerCase();
    const line =
      audience === 'layman'
        ? t('predictive:subperiod.sky.slow_hit_layman', { date, target: laymanHitTarget(t, hit.natal_point), tone })
        : t('predictive:subperiod.sky.slow_hit_astrologer', { date, graha: grahaName(t, hit.graha), target: slowHitTargetLabel(t, hit.natal_point), tone });
    dated.push({ ms: check.ms, line });
  }

  for (const event of transitCtx.timeline.events) {
    if (event.kind === 'dasha_change' || event.kind === 'sade_sati_phase') continue;
    const check = isInstantInSpan(event.date, bounds);
    if (!check.ok) continue;
    const label = audience === 'layman' ? laymanTimelineLine(t, event) : timelineEventLabel(t, event);
    if (!label) continue;
    dated.push({
      ms: check.ms,
      line: t('predictive:subperiod.sky.timeline_event', { date: formatPredictiveWindowBound(event.date), event: label }),
    });
  }

  const topEvents = dated.sort((a, b) => a.ms - b.ms).slice(0, 2).map((item) => item.line);
  const seg = selectOverlappingSadeSati(transitCtx.sade_sati, bounds);
  if (!seg) return topEvents;
  const sadeKey = audience === 'layman' ? 'sade_sati_layman' : 'sade_sati_astrologer';
  const sadeLine = t(`predictive:subperiod.sky.${sadeKey}`, {
    phase: sadeSatiPhaseName(t, seg.phase),
    start: formatPredictiveWindowBound(seg.start),
    end: formatPredictiveWindowBound(seg.end),
  });
  return [...topEvents, sadeLine].slice(0, 3);
}
