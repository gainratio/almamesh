/**
 * Human copy for engine transit/domain timing events — PURE i18n mapping.
 *
 * The engine emits STABLE machine descriptors (e.g. "saturn.ingress.aries")
 * plus typed fields (`kind`, `graha`, `to_sign`, …). These helpers turn them
 * into localized one-liners via the `predictive` namespace, degrading honestly
 * to the raw descriptor when a field is missing — never inventing astrology.
 */

import type { TFunction } from 'i18next';
import type {
  DomainWindowData,
  SadeSatiPhase,
  TransitTimelineEventData,
} from '@almamesh/shared-types';
import { titleCaseToken } from './predictive';

const GRAHAS = new Set([
  'sun',
  'moon',
  'mars',
  'mercury',
  'jupiter',
  'venus',
  'saturn',
  'rahu',
  'ketu',
]);

/** The twelve signs in zodiac order (the order a forward sign change follows). */
const SIGN_ORDER = [
  'aries',
  'taurus',
  'gemini',
  'cancer',
  'leo',
  'virgo',
  'libra',
  'scorpio',
  'sagittarius',
  'capricorn',
  'aquarius',
  'pisces',
] as const;

const SIGNS = new Set<string>(SIGN_ORDER);

/** The mean nodes always move backward, so their ordinary sign change "enters". */
const NODES = new Set(['rahu', 'ketu']);

/**
 * True when a planet that normally moves forward steps back into the previous
 * sign: `to` is the sign just before `from` (Aries -> Pisces wraps).
 */
function isBackwardSignChange(graha: string, from: string, to: string): boolean {
  if (NODES.has(graha)) return false;
  const order: readonly string[] = SIGN_ORDER;
  const fromIndex = order.indexOf(from);
  const toIndex = order.indexOf(to);
  return fromIndex >= 0 && toIndex === (fromIndex + 11) % 12;
}

/** Localized graha name ("saturn" → "Saturn"/"Saturno"), verbatim fallback. */
export function grahaName(t: TFunction, graha: string): string {
  return GRAHAS.has(graha) ? t(`predictive:graha.${graha}`) : titleCaseToken(graha);
}

/** Localized sign name ("aries" → "Aries"), verbatim fallback. */
export function signName(t: TFunction, sign: string): string {
  return SIGNS.has(sign) ? t(`predictive:sign.${sign}`) : titleCaseToken(sign);
}

/** Localized Sade Sati phase label. */
export function sadeSatiPhaseName(t: TFunction, phase: SadeSatiPhase): string {
  return t(`predictive:sade_sati.phase.${phase}`);
}

/** Honest fallback: the engine's stable machine key, verbatim. */
function generic(t: TFunction, descriptor: string): string {
  return t('predictive:events.generic', { descriptor });
}

/** A localized one-liner for a 12-month timeline event. */
export function timelineEventLabel(t: TFunction, event: TransitTimelineEventData): string {
  switch (event.kind) {
    case 'sign_ingress':
      if (event.graha && event.to_sign) {
        const backward = event.from_sign !== null && isBackwardSignChange(event.graha, event.from_sign, event.to_sign);
        return t(backward ? 'predictive:events.sign_ingress_backward' : 'predictive:events.sign_ingress', {
          graha: grahaName(t, event.graha),
          sign: signName(t, event.to_sign),
        });
      }
      return generic(t, event.descriptor);
    case 'sade_sati_phase':
      if (event.sade_sati_phase) {
        return t('predictive:events.sade_sati_phase', {
          phase: sadeSatiPhaseName(t, event.sade_sati_phase),
        });
      }
      return generic(t, event.descriptor);
    case 'return':
      if (event.graha) {
        return t('predictive:events.return', { graha: grahaName(t, event.graha) });
      }
      return generic(t, event.descriptor);
    case 'dasha_change':
      if (event.from_lord && event.to_lord) {
        return t('predictive:events.dasha_change', {
          from: grahaName(t, event.from_lord),
          to: grahaName(t, event.to_lord),
        });
      }
      return t('predictive:events.dasha_change_generic');
    case 'station':
      if (event.graha && event.station_direction && event.station_sign) {
        return t(`predictive:events.station_${event.station_direction}`, {
          graha: grahaName(t, event.graha),
          sign: signName(t, event.station_sign),
        });
      }
      if (event.graha) {
        return t('predictive:events.station', { graha: grahaName(t, event.graha) });
      }
      return generic(t, event.descriptor);
    default:
      return generic(t, event.descriptor);
  }
}

/**
 * A localized one-liner for a domain forecast window. Windows carry only
 * `kind` + `trigger` + `descriptor`; when the descriptor's last token is a
 * sign ("saturn.ingress.aries") we can render the full ingress line — else we
 * degrade to the kind-level template, never to invented detail.
 */
export function domainWindowLabel(t: TFunction, window: DomainWindowData): string {
  const tokens = window.descriptor.split('.');
  const lastToken = tokens[tokens.length - 1] ?? '';
  switch (window.kind) {
    case 'sign_ingress': {
      if (window.trigger && SIGNS.has(lastToken)) {
        return t('predictive:events.sign_ingress', {
          graha: grahaName(t, window.trigger),
          sign: signName(t, lastToken),
        });
      }
      if (window.trigger) {
        return t('predictive:events.sign_ingress_unknown', {
          graha: grahaName(t, window.trigger),
        });
      }
      return generic(t, window.descriptor);
    }
    case 'return':
      if (window.trigger) {
        return t('predictive:events.return', { graha: grahaName(t, window.trigger) });
      }
      return generic(t, window.descriptor);
    case 'station':
      if (window.trigger) {
        return t('predictive:events.station', { graha: grahaName(t, window.trigger) });
      }
      return generic(t, window.descriptor);
    case 'dasha_change':
      if (window.trigger) {
        return t('predictive:events.dasha_change_to', {
          graha: grahaName(t, window.trigger),
        });
      }
      return t('predictive:events.dasha_change_generic');
    default:
      return generic(t, window.descriptor);
  }
}

/** Localized label for a slow-hit natal point ("moon" | "lagna" | "natal_<graha>"). */
export function slowHitTargetLabel(t: TFunction, natalPoint: string): string {
  if (natalPoint === 'moon') {
    return t('predictive:slow_hits.target.moon');
  }
  if (natalPoint === 'lagna') {
    return t('predictive:slow_hits.target.lagna');
  }
  if (natalPoint.startsWith('natal_')) {
    return t('predictive:slow_hits.target.natal_point', {
      graha: grahaName(t, natalPoint.slice('natal_'.length)),
    });
  }
  return titleCaseToken(natalPoint);
}
