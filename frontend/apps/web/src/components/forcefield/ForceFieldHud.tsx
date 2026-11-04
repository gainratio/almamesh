/**
 * ForceFieldHud — non-obstructing Observatory frame around the 3D Planetary
 * Force Field canvas:
 *   - Top header strip (above canvas): Core status, active Dasha thread legend,
 *     and camera/label controls.
 *   - Middle stage (`children`): 100% unobstructed 3D WebGL viewport.
 *   - Bottom footer dock (below canvas): Selected-planet telemetry strip and
 *     the 9-graha interactive selector bar.
 */

import { useMemo, type ReactElement, type ReactNode } from 'react';
import { colors, PLANET_COLORS } from '@almamesh/constants';
import type { SiderealChart } from '@almamesh/browser/types';
import type { EnergyFrame, PlanetName } from '@almamesh/shared-types';
import {
  inSignDegree,
  selectThreads,
  signAbbrFromLongitude,
  type CameraViewMode,
  type LabelMode,
  type ThreadKind,
} from './astrolabe';
import { ForceFieldGuide, ForceFieldInspector } from './ForceFieldInspector';

export interface ForceFieldHudProps {
  readonly chart: SiderealChart;
  readonly frame: EnergyFrame;
  readonly selectedPlanet: string | null;
  readonly onSelectPlanet: (id: string | null) => void;
  readonly viewMode: CameraViewMode;
  readonly onViewModeChange: (mode: CameraViewMode) => void;
  readonly labelMode: LabelMode;
  readonly onLabelModeChange: (mode: LabelMode) => void;
  readonly onResetView: () => void;
  readonly children: ReactNode;
}

const PLANET_ORDER: readonly PlanetName[] = [
  'sun',
  'moon',
  'mars',
  'mercury',
  'jupiter',
  'venus',
  'saturn',
  'rahu',
  'ketu',
];

const THREAD_LABELS: Readonly<Record<ThreadKind, string>> = {
  maha: 'Maha',
  antar: 'Antar',
  discord: 'Friction',
};

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

function fluxReadout(netFlux: number): { label: string; dotColor: string } {
  if (netFlux > 0.15) {
    return {
      label: 'Constructive',
      dotColor: colors.forcefield.fluxConstructive,
    };
  }
  if (netFlux < -0.15) {
    return {
      label: 'Compressed',
      dotColor: colors.forcefield.fluxDestructive,
    };
  }
  return {
    label: 'Balanced',
      dotColor: colors.forcefield.fluxBalanced,
  };
}

const BTN_BASE =
  'inline-flex min-h-6 items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-gold';

export function ForceFieldHud({
  chart,
  frame,
  selectedPlanet,
  onSelectPlanet,
  viewMode,
  onViewModeChange,
  labelMode,
  onLabelModeChange,
  onResetView,
  children,
}: ForceFieldHudProps): ReactElement {
  const threads = useMemo(
    () => selectThreads(frame.planets, frame.active),
    [frame.planets, frame.active],
  );
  const planetById = useMemo(
    () => new Map(frame.planets.map((p) => [p.id, p])),
    [frame.planets],
  );
  const selectedWave = selectedPlanet
    ? (planetById.get(selectedPlanet as PlanetName) ?? null)
    : null;
  const flux = fluxReadout(frame.aura.netFlux);
  const lagnaSign = capitalize(chart.lagna.sign);

  return (
    <div data-testid="forcefield-hud" className="flex flex-col">
      {/* Dedicated Top Header Strip (above the 3D canvas — never obstructs diagram). */}
      <div className="relative z-10 flex flex-wrap items-center justify-between gap-2 border-b border-ui-border-dark bg-background-darker/95 px-3.5 py-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <div
            data-testid="forcefield-core-status"
            className="inline-flex min-h-6 items-center gap-1.5 rounded-md border border-ui-border bg-background-darkest/85 px-2.5 py-1 text-xs text-text-secondary"
          >
            <span
              aria-hidden="true"
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: flux.dotColor }}
            />
            <span className="font-medium text-text-primary">
              {`Core: ${lagnaSign} Asc`}
            </span>
            <span className="text-text-muted">·</span>
            <span>{`Flux: ${flux.label}`}</span>
          </div>

          {threads.map((spec) => {
            const isSelected = selectedPlanet === spec.planetId;
            const dotColor =
              spec.kind === 'discord'
                ? colors.status.debilitated
                : PLANET_COLORS[spec.planetId];
            return (
              <button
                key={`${spec.kind}-${spec.planetId}`}
                type="button"
                aria-pressed={isSelected}
                onClick={() =>
                  onSelectPlanet(isSelected ? null : spec.planetId)
                }
                className={`${BTN_BASE} ${
                  isSelected
                    ? 'border-accent-gold bg-accent-gold/20 text-text-primary'
                    : 'border-ui-border bg-background-darkest/85 text-text-secondary hover:border-accent-gold/40 hover:text-text-primary'
                }`}
              >
                <span
                  aria-hidden="true"
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: dotColor }}
                />
                <span>{`${THREAD_LABELS[spec.kind]}: ${capitalize(spec.planetId)}`}</span>
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <div
            role="group"
            aria-label="Camera perspective"
            className="inline-flex rounded-md border border-ui-border bg-background-darkest/85 p-0.5"
          >
            <button
              type="button"
              aria-pressed={viewMode === '3d'}
              onClick={() => onViewModeChange('3d')}
              className={`min-h-6 rounded px-2 py-0.5 text-xs font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-gold ${
                viewMode === '3d'
                  ? 'bg-accent-gold/20 text-accent-gold-bright'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              3D Orbit
            </button>
            <button
              type="button"
              aria-pressed={viewMode === 'top'}
              onClick={() => onViewModeChange('top')}
              className={`min-h-6 rounded px-2 py-0.5 text-xs font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-gold ${
                viewMode === 'top'
                  ? 'bg-accent-gold/20 text-accent-gold-bright'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              Top Wheel
            </button>
          </div>

          <button
            type="button"
            aria-pressed={labelMode === 'all'}
            onClick={() =>
              onLabelModeChange(labelMode === 'all' ? 'lords' : 'all')
            }
            className={`${BTN_BASE} border-ui-border bg-background-darkest/85 text-text-secondary hover:border-accent-gold/40 hover:text-text-primary`}
          >
            {labelMode === 'all' ? 'Labels: All' : 'Labels: Lords'}
          </button>

          <button
            type="button"
            onClick={onResetView}
            className={`${BTN_BASE} border-ui-border bg-background-darkest/85 text-text-secondary hover:border-accent-gold/40 hover:text-text-primary`}
          >
            Reset View
          </button>

          <ForceFieldGuide />
        </div>
      </div>

      {/* Unobstructed 3D WebGL Canvas Stage. */}
      {children}

      {/* Dedicated Bottom Footer Dock (below the 3D canvas — never obstructs diagram). */}
      <div className="flex flex-col gap-2.5 border-t border-ui-border-dark bg-background-darker/95 px-3.5 py-2.5">
        {selectedWave && (
          <ForceFieldInspector
            planet={selectedWave}
            chart={chart}
            active={frame.active}
            threads={threads}
            onClose={() => onSelectPlanet(null)}
          />
        )}

        <div
          role="group"
          aria-label="Select planet in force field"
          data-testid="forcefield-planet-bar"
          className="flex flex-wrap items-center gap-1.5"
        >
          {PLANET_ORDER.map((id) => {
            const p = planetById.get(id);
            if (!p) return null;
            const isSelected = selectedPlanet === id;
            const isMaha = frame.active.maha === id;
            const isAntar = frame.active.antar === id;
            const deg = inSignDegree(p.eclipticLongitude);
            const sign = signAbbrFromLongitude(p.eclipticLongitude);

            return (
              <button
                key={id}
                type="button"
                data-testid={`forcefield-pill-${id}`}
                aria-pressed={isSelected}
                onClick={() => onSelectPlanet(isSelected ? null : id)}
                className={`inline-flex min-h-6 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-gold ${
                  isSelected
                    ? 'border-accent-gold bg-accent-gold/20 text-text-primary shadow-sm'
                    : isMaha || isAntar
                      ? 'border-accent-gold/35 bg-background-darkest/90 text-text-primary hover:border-accent-gold/70'
                      : 'border-ui-border-dark bg-background-darkest/60 text-text-secondary hover:border-ui-border-light hover:text-text-primary'
                }`}
              >
                <span
                  aria-hidden="true"
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: PLANET_COLORS[id] }}
                />
                <span className="font-medium capitalize">
                  {id}
                  {p.isRetrograde ? ' (R)' : ''}
                </span>
                <span className="hidden font-mono text-[10px] text-text-muted sm:inline">
                  {`${deg}° ${sign}`}
                </span>
                {isMaha && (
                  <span className="rounded bg-accent-gold/25 px-1 py-0.2 text-[9px] font-semibold uppercase tracking-wider text-accent-gold-bright">
                    Maha
                  </span>
                )}
                {!isMaha && isAntar && (
                  <span className="rounded bg-accent-lapis/30 px-1 py-0.2 text-[9px] font-semibold uppercase tracking-wider text-text-primary">
                    Antar
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
