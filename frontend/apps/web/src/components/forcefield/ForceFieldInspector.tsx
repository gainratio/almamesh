/**
 * ForceFieldInspector — selected-planet telemetry strip and the collapsible
 * `<details>` "How to Read" legend for the 3D Planetary Force Field.
 */

import type { ReactElement } from 'react';
import { PLANET_COLORS } from '@almamesh/constants';
import type { SiderealChart } from '@almamesh/browser/types';
import type {
  ActiveDasha,
  PlanetName,
  PlanetWave,
} from '@almamesh/shared-types';
import type { ThreadSpec } from './astrolabe';

interface ForceFieldInspectorProps {
  readonly planet: PlanetWave;
  readonly chart: SiderealChart;
  readonly active: ActiveDasha;
  readonly threads: readonly ThreadSpec[];
  readonly onClose: () => void;
}

function formatSignDegree(longitude: number): string {
  const inSign = ((longitude % 30) + 30) % 30;
  const deg = Math.floor(inSign);
  const min = Math.floor((inSign - deg) * 60);
  return `${deg}°${String(min).padStart(2, '0')}'`;
}

function titleCase(s: string): string {
  if (!s) return 'Neutral';
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');
}

function roleLabel(
  id: PlanetName,
  active: ActiveDasha,
  threads: readonly ThreadSpec[],
): { text: string; tone: string } {
  if (id === active.maha && id === active.antar) {
    return {
      text: 'Mahadasha + Antardasha Lord',
      tone: 'border-accent-gold/50 bg-accent-gold/15 text-accent-gold-bright',
    };
  }
  if (id === active.maha) {
    return {
      text: 'Mahadasha Lord (Primary Driver)',
      tone: 'border-accent-gold/50 bg-accent-gold/15 text-accent-gold-bright',
    };
  }
  if (id === active.antar) {
    return {
      text: 'Antardasha Lord (Sub-Period)',
      tone: 'border-accent-lapis/50 bg-accent-lapis/20 text-text-primary',
    };
  }
  const thread = threads.find((t) => t.planetId === id);
  if (thread?.kind === 'discord') {
    return {
      text: 'Primary Friction Thread',
      tone: 'border-status-debilitated/50 bg-status-debilitated/15 text-status-debilitated',
    };
  }
  return {
    text: 'Natal Field Graha',
    tone: 'border-ui-border-light bg-background-tertiary/70 text-text-secondary',
  };
}

function relationSummary(friendliness: number, mahaLord: string): string {
  const maha = titleCase(mahaLord);
  if (friendliness > 0.5) return `Harmonious with ${maha} (+1.0)`;
  if (friendliness < -0.5) return `Counter-force to ${maha} (-1.0)`;
  return `Neutral to ${maha} (+0.25)`;
}

export function ForceFieldInspector({
  planet,
  chart,
  active,
  threads,
  onClose,
}: ForceFieldInspectorProps): ReactElement {
  const raw = chart.planets[planet.id];
  const color = PLANET_COLORS[planet.id] ?? '#C9A24B';
  const role = roleLabel(planet.id, active, threads);
  const sign = raw ? titleCase(raw.sign) : '—';
  const deg = formatSignDegree(raw?.longitude ?? planet.eclipticLongitude);
  const house = raw?.house ?? '—';
  const nakshatra = raw?.nakshatra ? raw.nakshatra.split(' (')[0] : '—';
  const pada = raw?.nakshatra_pada ? ` (${raw.nakshatra_pada})` : '';
  const dignity = raw?.dignity ? titleCase(raw.dignity) : 'Neutral';
  const coherencePct = Math.round(planet.coherence * 100);

  return (
    <div
      data-testid="forcefield-inspector"
      className="w-full rounded-xl border border-accent-gold/35 bg-background-darkest/90 px-3.5 py-2.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="inline-block h-3.5 w-3.5 shrink-0 rounded-full ring-2 ring-white/15"
            style={{ backgroundColor: color }}
          />
          <div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-semibold capitalize text-text-primary">
                {planet.id}
              </span>
              <span
                className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${role.tone}`}
              >
                {role.text}
              </span>
              <span className="font-mono text-xs text-text-secondary">
                {`· ${sign} ${deg} · House ${house} · ${nakshatra}${pada}`}
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <div className="rounded border border-ui-border-dark bg-background-secondary/80 px-2.5 py-1">
            <span className="text-text-muted">State: </span>
            <span className="font-medium text-text-primary">
              {dignity}
              {planet.isRetrograde ? ' · Retro (Outward)' : ' · Direct (Inward)'}
              {planet.isCombust ? ' · Combust' : ''}
            </span>
          </div>
          <div className="rounded border border-ui-border-dark bg-background-secondary/80 px-2.5 py-1">
            <span className="text-text-muted">Resonance: </span>
            <span className="font-medium text-text-primary">
              {`${relationSummary(planet.friendlinessToActive, active.maha)} · ${coherencePct}%`}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-6 min-w-6 items-center justify-center rounded-md border border-ui-border px-2 py-0.5 text-xs text-text-secondary transition-colors hover:border-accent-gold/40 hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-gold"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/** Native `<details>` disclosure explaining how to read the 3D force field. */
export function ForceFieldGuide(): ReactElement {
  return (
    <details
      data-testid="forcefield-guide"
      className="group relative"
    >
      <summary className="inline-flex min-h-6 cursor-pointer list-none items-center gap-1 rounded-md border border-ui-border bg-background-darkest/85 px-2.5 py-1 text-xs font-medium text-text-secondary transition-colors hover:border-accent-gold/40 hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-gold [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className="text-accent-gold">
          ?
        </span>
        <span>Guide</span>
      </summary>
      <div className="absolute right-0 top-full z-20 mt-1.5 w-72 rounded-xl border border-ui-border-light bg-background-darkest/95 p-3 text-xs leading-relaxed text-text-secondary shadow-xl backdrop-blur-md">
        <p className="font-semibold text-text-primary">
          Reading the Living Astrolabe
        </p>
        <ul role="list" className="mt-1.5 space-y-1.5 text-[11px]">
          <li>
            <strong className="text-accent-gold-bright">Center Core:</strong>{' '}
            Your Ascendant (Lagna) nucleus; gimbal rings pulse with net wave
            harmony.
          </li>
          <li>
            <strong className="text-text-primary">Glowing Arcs:</strong> Connect
            your active <em>Mahadasha</em> and <em>Antardasha</em> rulers (plus
            primary friction) to the core.
          </li>
          <li>
            <strong className="text-text-primary">Pulse Direction:</strong>{' '}
            Inward toward core = Direct; Outward from core = Retrograde{' '}
            <code>(R)</code>.
          </li>
          <li>
            <strong className="text-text-primary">Interact:</strong> Click any
            planet orb or pill below to inspect its house, dignity, and wave
            coherence. Drag to orbit or switch to <strong>Top Wheel</strong>.
          </li>
        </ul>
      </div>
    </details>
  );
}
