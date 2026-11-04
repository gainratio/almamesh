/**
 * ForceFieldExperience - the typed boundary for the 3D planetary force-field.
 *
 * This is the only force-field file the rest of the app imports. The whole
 * force-field tree is fully typed (no `@ts-nocheck` anywhere): R3F v9 ships a
 * React-19-compatible `ThreeElements` JSX augmentation, and the one custom
 * shader element (`astrolabeDiscMaterial`) is registered through a typed
 * `ThreeElements` module augmentation in `PlanetMesh.tsx`.
 *
 * When `decorative` is false (default, used in Dashboard's ChartVisualization),
 * wraps the 3D WebGL stage in the non-obstructing `ForceFieldHud` instrument
 * frame (dedicated top header strip for Dasha legend + camera/label controls,
 * unobstructed 3D viewport in the middle, and dedicated bottom dock for the
 * selected-planet telemetry strip + 9-planet selector bar).
 */

import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Canvas, type RootState } from '@react-three/fiber';
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing';
import { colors } from '@almamesh/constants';
import { devicePolicy } from '@almamesh/browser';
import type { SiderealChart } from '@almamesh/browser/types';
import {
  buildEnergyFrame,
  computeAuraState,
  activeDashaFromChart,
} from '@almamesh/store';
import {
  PLANET_WAVE_COLORS,
  type EnergyFrame,
  type PlanetName,
  type RGBColor,
} from '@almamesh/shared-types';
import { ForceFieldScene } from './ForceFieldScene';
import { ForceFieldHud } from './ForceFieldHud';
import { isSoftwareRenderer } from './softwareRenderer';
import { forceFieldRenderSettings } from './renderSettings';
import { SharedTextureRelease } from './SharedTextureRelease';
import type { CameraViewMode, LabelMode } from './astrolabe';

export interface ForceFieldExperienceProps {
  /** The engine's raw, lossless chart output (the richest feed). */
  readonly chart: SiderealChart;
  /** Currently highlighted planet (lowercase id / 2D-kundli name), or null. */
  readonly selectedPlanet?: string | null;
  /** Lift selection up so the 2D chart and 3D scene highlight together. */
  readonly onSelectPlanet?: (id: string | null) => void;
  /** Override the rendered 3D viewport height (px). Default 440 (420 when decorative). */
  readonly height?: number;
  /** Purely atmospheric mode (no interactive HUD, used on Landing hero). */
  readonly decorative?: boolean;
}

/** The lagna tint = the wave colour of the ascendant's sign-lord planet. */
function lagnaTint(chart: SiderealChart): RGBColor | undefined {
  const lord = chart.lagna.sign_lord as PlanetName;
  return PLANET_WAVE_COLORS[lord];
}

/** Human-readable summary for the a11y label and the screen-reader readout. */
function describeField(frame: EnergyFrame): string {
  const maha = frame.active.maha;
  const antar = frame.active.antar;
  const flux =
    frame.aura.netFlux > 0.15
      ? 'positive (constructive), aura expanding'
      : frame.aura.netFlux < -0.15
        ? 'negative (destructive), aura compressed'
        : 'balanced';
  const dasha = antar ? `${maha} mahadasha / ${antar} antardasha` : `${maha} mahadasha`;
  return `Planetary energy field: ${dasha}; net flux ${flux}.`;
}

export function ForceFieldExperience({
  chart,
  selectedPlanet: controlledPlanet,
  onSelectPlanet,
  height,
  decorative = false,
}: ForceFieldExperienceProps): ReactElement {
  const { t } = useTranslation('common');
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const [animationTime, setAnimationTime] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [softwareGl, setSoftwareGl] = useState(false);
  const still = reducedMotion || softwareGl;
  const [inView, setInView] = useState(true);

  const [uncontrolledPlanet, setUncontrolledPlanet] = useState<string | null>(null);
  const selectedPlanet =
    controlledPlanet !== undefined ? controlledPlanet : uncontrolledPlanet;

  const [viewMode, setViewMode] = useState<CameraViewMode>('3d');
  const [labelMode, setLabelMode] = useState<LabelMode>(
    decorative ? 'hover' : 'all',
  );
  const [resetTrigger, setResetTrigger] = useState(0);

  const resolvedHeight = height ?? (decorative ? 420 : 440);

  const baseFrame = useMemo(() => buildEnergyFrame(chart, 0), [chart]);
  const lagnaColor = useMemo(() => lagnaTint(chart), [chart]);
  const lagnaLongitude = chart.lagna.longitude;
  const active = useMemo(() => activeDashaFromChart(chart), [chart]);
  const houseSpokes = useMemo(
    () => Object.values(chart.houses).map((h) => h.longitude),
    [chart.houses],
  );

  const frame: EnergyFrame = useMemo(
    () => ({
      t: animationTime,
      active,
      planets: baseFrame.planets,
      aura: computeAuraState(baseFrame.planets, animationTime),
    }),
    [baseFrame.planets, active, animationTime],
  );

  const ariaLabel = useMemo(() => describeField(frame), [frame]);
  const render = useMemo(() => forceFieldRenderSettings(devicePolicy()), []);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mq.matches);
    const handler = (e: MediaQueryListEvent): void => setReducedMotion(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => setInView(entries[0]?.isIntersecting ?? true),
      { threshold: 0.05 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const onVisibility = (): void => setInView(!document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  useEffect(() => {
    if (still || !inView) {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      return;
    }
    let last: number | null = null;
    let elapsed = 0;
    let lastCommitted = 0;
    const tick = (now: number): void => {
      const delta = last === null ? 0.016 : Math.min((now - last) / 1000, 0.1);
      last = now;
      elapsed += delta;
      // During the 2.5s entrance ease-out, commit every frame so the scale-in
      // curve is smooth; once settled, commit at ~1 Hz for the HUD net-flux
      // readout while R3F's useFrame drives 3D shaders at native 60/120fps.
      if (elapsed <= 2.6 || elapsed - lastCommitted >= 1.0) {
        const step = elapsed - lastCommitted;
        lastCommitted = elapsed;
        startTransition(() => setAnimationTime((prev) => prev + step));
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [still, inView]);

  const handleCreated = useCallback((state: RootState) => {
    setSoftwareGl(isSoftwareRenderer(state.gl.getContext()));
  }, []);

  const handleSelect = useCallback(
    (id: string | null) => {
      if (controlledPlanet === undefined) {
        setUncontrolledPlanet(id);
      }
      onSelectPlanet?.(id);
    },
    [controlledPlanet, onSelectPlanet],
  );

  const handleResetView = useCallback(() => {
    setResetTrigger((n) => n + 1);
  }, []);

  const canvasStage = (
    <div
      className="relative w-full overflow-hidden"
      style={{
        height: resolvedHeight,
        contain: 'layout paint',
        background: `radial-gradient(120% 90% at 50% 18%, ${colors.background.darker} 0%, ${colors.background.primary} 45%, ${colors.background.darkest} 100%)`,
      }}
    >
      <Canvas
        camera={{ position: [0, 6.2, 13.8], fov: 48 }}
        gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
        dpr={[render.dpr[0], render.dpr[1]]}
        frameloop={!still && inView ? 'always' : 'demand'}
        onCreated={handleCreated}
        role="img"
        aria-label={ariaLabel}
      >
        <color attach="background" args={[colors.background.primary]} />
        <SharedTextureRelease />
        <ForceFieldScene
          frame={frame}
          animationTime={animationTime}
          reducedMotion={still}
          selectedPlanet={selectedPlanet}
          onPlanetSelect={handleSelect}
          lagnaColor={lagnaColor}
          houseSpokes={houseSpokes}
          lagnaLongitude={lagnaLongitude}
          labelMode={labelMode}
          viewMode={viewMode}
          autoOrbit={!decorative}
          resetTrigger={resetTrigger}
          effects={
            render.effects === 'full' ? (
              <EffectComposer>
                <Bloom
                  luminanceThreshold={0.26}
                  luminanceSmoothing={0.9}
                  intensity={0.62}
                  mipmapBlur
                />
                <Vignette eskil={false} offset={0.28} darkness={0.58} />
              </EffectComposer>
            ) : render.effects === 'lite' ? (
              <EffectComposer>
                <Bloom
                  luminanceThreshold={0.34}
                  luminanceSmoothing={0.85}
                  intensity={0.42}
                />
              </EffectComposer>
            ) : null
          }
        />
      </Canvas>

      {reducedMotion && (
        <div className="absolute bottom-3 left-3 rounded bg-background-elevated/80 px-2 py-1 text-xs text-text-muted">
          {t('accessibility.reduced_motion')}
        </div>
      )}
    </div>
  );

  return (
    <div
      ref={containerRef}
      className="relative w-full overflow-hidden rounded-2xl border border-ui-border-dark bg-background-darkest"
    >
      {decorative ? (
        canvasStage
      ) : (
        <ForceFieldHud
          chart={chart}
          frame={frame}
          selectedPlanet={selectedPlanet}
          onSelectPlanet={handleSelect}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          labelMode={labelMode}
          onLabelModeChange={setLabelMode}
          onResetView={handleResetView}
        >
          {canvasStage}
        </ForceFieldHud>
      )}
      <p className="sr-only">{ariaLabel}</p>
    </div>
  );
}
