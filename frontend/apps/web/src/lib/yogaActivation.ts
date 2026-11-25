/**
 * Pure presentation formatter for deterministic `YogaDashaActivation` emitted
 * by the Python engine (`almamesh.yogas.activation`). Recomputes zero astrology.
 */

import type { TFunction } from 'i18next';
import type {
  YogaAspectLink,
  YogaDashaLevel,
  YogaDashaLink,
  YogaData,
  YogaDispositorChain,
  YogaMitigatingFactor,
} from '@almamesh/browser/types';
import { grahaName } from './predictiveEventCopy';

const cap = (word: string): string => (word ? word.charAt(0).toUpperCase() + word.slice(1) : '');

const EN_LEVEL: Readonly<Record<YogaDashaLevel, string>> = {
  maha: 'Mahā',
  antar: 'Antar',
  pratyantar: 'Pratyantar',
};

function levelWord(level: YogaDashaLevel, tr?: TFunction): string {
  if (!tr) return EN_LEVEL[level];
  return tr(`dasha.${level}`);
}

function planetWord(planet: string, tp?: TFunction): string {
  return tp ? grahaName(tp, planet) : cap(planet);
}

function formatDirect(links: readonly YogaDashaLink[], tr?: TFunction, tp?: TFunction): string {
  return links
    .map((link) => `${levelWord(link.level, tr)} (${planetWord(link.lord, tp)})`)
    .join(', ');
}

function formatChains(
  chains: readonly YogaDispositorChain[],
  tr?: TFunction,
  tp?: TFunction,
): string {
  return chains
    .map(
      (c) =>
        `${levelWord(c.level, tr)} (${c.chain.map((p) => planetWord(p, tp)).join(' → ')})`,
    )
    .join(', ');
}

function formatAspects(links: readonly YogaAspectLink[], tr?: TFunction, tp?: TFunction): string {
  return links
    .map((a) => {
      const level = levelWord(a.level, tr);
      const lord = planetWord(a.lord, tp);
      const target = planetWord(a.target, tp);
      if (a.house_offset === 1) {
        return tr
          ? tr('yogas.activation.aspect_conjunction', { level, lord, target })
          : `${level} ${lord} conjunct ${target}`;
      }
      return tr
        ? tr('yogas.activation.aspect_drishti', { level, lord, target, offset: a.house_offset })
        : `${level} ${lord} -> ${target} (house ${a.house_offset} aspect)`;
    })
    .join(', ');
}

function formatMitigations(
  factors: readonly YogaMitigatingFactor[],
  tr?: TFunction,
  tp?: TFunction,
): string {
  return factors
    .map((m) => {
      const planet = m.planet ? planetWord(m.planet, tp) : '';
      switch (m.kind) {
        case 'combust':
          return tr ? tr('yogas.activation.mitigation.combust', { planet }) : `${planet} combust`;
        case 'debilitated':
          return tr
            ? tr('yogas.activation.mitigation.debilitated', { planet })
            : `${planet} debilitated`;
        case 'dusthana':
          return tr
            ? tr('yogas.activation.mitigation.dusthana', { planet, house: m.house ?? '' })
            : `${planet} in house ${m.house ?? ''}`;
        case 'lagna_near_cusp':
          return tr
            ? tr('yogas.activation.mitigation.lagna_near_cusp')
            : 'ascendant near sign boundary';
      }
    })
    .join(', ');
}

/** Localized (or English-fallback when `tr` is omitted) deterministic yoga activation line. */
export function formatYogaActivation(
  yoga: YogaData,
  tr?: TFunction,
  tp?: TFunction,
): string | undefined {
  const act = yoga.dasha_activation;
  if (!act) return undefined;
  const label = tr ? tr('yogas.activation.label') : 'Daśā activation';
  const status = tr
    ? tr(`yogas.activation.status.${act.status}`)
    : act.status === 'direct'
      ? 'Active (direct)'
      : act.status === 'indirect'
        ? 'Active (dispositor / aspect)'
        : 'Dormant in running period';
  const parts: string[] = [`${label}: ${status}`];
  if (act.direct_lords.length > 0) {
    const items = formatDirect(act.direct_lords, tr, tp);
    parts.push(tr ? tr('yogas.activation.direct_prefix', { items }) : `Direct: ${items}`);
  }
  if (act.dispositor_chains.length > 0) {
    const items = formatChains(act.dispositor_chains, tr, tp);
    parts.push(tr ? tr('yogas.activation.dispositor_prefix', { items }) : `Dispositor: ${items}`);
  }
  if (act.aspect_links.length > 0) {
    const items = formatAspects(act.aspect_links, tr, tp);
    parts.push(tr ? tr('yogas.activation.aspect_prefix', { items }) : `Aspect: ${items}`);
  }
  if (act.mitigating_factors.length > 0) {
    const items = formatMitigations(act.mitigating_factors, tr, tp);
    parts.push(tr ? tr('yogas.activation.mitigating_prefix', { items }) : `Qualifying: ${items}`);
  }
  return parts.join(' · ');
}
