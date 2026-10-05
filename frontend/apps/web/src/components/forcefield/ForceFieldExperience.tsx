/**
 * ForceFieldExperience - the typed boundary for the 3D planetary force-field.
 *
 * This is the only force-field file the rest of the app imports. The whole
 * force-field tree is fully typed (no `@ts-nocheck` anywhere): R3F v9 ships a
 * React-19-compatible `ThreeElements` JSX augmentation, and the one custom
 * shader element (`astrolabeDiscMaterial`) is registered through a typed
 * `ThreeElements` module augmentation in `PlanetMesh.tsx`. The pure
 * presentation decisions (lord hierarchy, thread selection, entrance timeline)
 * live typed + unit-tested in `astrolabe.ts`.
 *
 * Data feed (local-first, no server, no hooks): the static per-planet wave
 * params are computed ONCE from the persisted `SiderealChart` via the pure store
 * adapter `buildEnergyFrame(chart, 0)` (memoised on `chart`). The wave clock `t`
 * is advanced in a rAF loop and threaded into the scene, which evaluates the
 * cos/interference terms per frame. The aura aggregate is recomputed per frame
 * from the static waves (cheap; no per-frame allocation of the wave list).
 *
 * Perf/a11y: rAF pauses when offscreen (IntersectionObserver) or tab-hidden;
 * `prefers-reduced-motion` renders a single static frame; bloom is gated off on
 * low-power devices; the canvas carries `role="img"` + an aria summary.
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
import { Canvas } from '@react-three/fiber';
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing';
import { colors } from '@almamesh/constants';
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

export interface ForceFieldExperienceProps {
  /** The engine's raw, lossless chart output (the richest feed). */
  readonly chart: SiderealChart;
  /** Currently highlighted planet (lowercase id / 2D-kundli name), or null. */
  readonly selectedPlanet?: string | null;
  /** Lift selection up so the 2D chart and 3D scene highlight together. */
  readonly onSelectPlanet?: (id: string | null) => void;
  /** Override the rendered height (px). Default 420. */
  readonly height?: number;
}

/** Post-processing tier — phones get a gentle bloom, desktops the full pass. */
type EffectTier = 'full' | 'lite';

/**
 * Pick the post-processing tier. Low-core / coarse-pointer (phone) devices get
 * the `lite` tier — a soft, cheap single-pass bloom that still lifts the
 * brass/lapis glow without the wider mip chain + vignette that can cost FPS on
 * mobile GPUs. Everything else gets the `full` tier.
 */
function effectTier(): EffectTier {
  if (typeof navigator === 'undefined') return 'full';
  const lowCores =
    typeof navigator.hardwareConcurrency === 'number' &&
    navigator.hardwareConcurrency <= 4;
  const coarsePointer =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches;
  return lowCores || coarsePointer ? 'lite' : 'full';
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
  selectedPlanet = null,
  onSelectPlanet,
  height = 420,
}: ForceFieldExperienceProps): ReactElement {
  const { t } = useTranslation('common');
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const [animationTime, setAnimationTime] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [inView, setInView] = useState(true);

  // Static per-planet wave params: computed ONCE from the chart (t=0).
  const baseFrame = useMemo(() => buildEnergyFrame(chart, 0), [chart]);
  const lagnaColor = useMemo(() => lagnaTint(chart), [chart]);
  const lagnaLongitude = chart.lagna.longitude;
  const active = useMemo(() => activeDashaFromChart(chart), [chart]);
  const houseSpokes = useMemo(
    () => Object.values(chart.houses).map((h) => h.longitude),
    [chart.houses],
  );

  // Per-frame frame: reuse the static planet waves, recompute only the aura.
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
  const tier = useMemo(() => effectTier(), []);

  // prefers-reduced-motion
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mq.matches);
    const handler = (e: MediaQueryListEvent): void => setReducedMotion(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Pause when scrolled offscreen.
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

  // Pause when the tab is hidden.
  useEffect(() => {
    const onVisibility = (): void => setInView(!document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // rAF wave clock — only runs when visible and motion is allowed. Advances
  // by REAL elapsed time (not a fixed per-frame step) so the entrance
  // choreography completes in ~2.5 wall-seconds even when the device renders
  // at low FPS; long gaps (tab jank) are clamped so the clock never jumps.
  useEffect(() => {
    if (reducedMotion || !inView) {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      return;
    }
    let last: number | null = null;
    const tick = (now: number): void => {
      const delta = last === null ? 0.016 : Math.min((now - last) / 1000, 0.1);
      last = now;
      // A transition, not an urgent update. An urgent setState every frame
      // re-renders this tree ahead of everything else; on a slow device each
      // render outlasts the frame, so the router's navigation (a transition)
      // was interrupted and restarted forever and a click away from the
      // landing page never landed. Transitions batch together instead, so a
      // navigation commits with the next clock tick.
      startTransition(() => setAnimationTime((t) => t + delta));
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [reducedMotion, inView]);

  const handleSelect = useCallback(
    (id: string | null) => onSelectPlanet?.(id),
    [onSelectPlanet],
  );

  return (
    <div
      ref={containerRef}
      className="relative w-full overflow-hidden rounded-2xl border border-ui-border-dark"
      style={{
        height,
        // Observatory gradient base behind the (alpha) canvas — deep obsidian
        // floor lifting to a faint lapis-indigo glow, so the scene never reads
        // as a dead flat rectangle even before the GL paints.
        background: `radial-gradient(120% 90% at 50% 18%, ${colors.background.darker} 0%, ${colors.background.primary} 45%, ${colors.background.darkest} 100%)`,
      }}
    >
      <Canvas
        camera={{ position: [0, 6, 14], fov: 50 }}
        gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
        dpr={[1, 2]}
        frameloop={reducedMotion ? 'demand' : inView ? 'always' : 'demand'}
        role="img"
        aria-label={ariaLabel}
      >
        <color attach="background" args={[colors.background.primary]} />
        <ForceFieldScene
          frame={frame}
          animationTime={animationTime}
          reducedMotion={reducedMotion}
          selectedPlanet={selectedPlanet}
          onPlanetSelect={handleSelect}
          lagnaColor={lagnaColor}
          houseSpokes={houseSpokes}
          lagnaLongitude={lagnaLongitude}
          effects={
            tier === 'full' ? (
              <EffectComposer>
                <Bloom
                  luminanceThreshold={0.22}
                  luminanceSmoothing={0.9}
                  intensity={0.7}
                  mipmapBlur
                />
                <Vignette eskil={false} offset={0.28} darkness={0.62} />
              </EffectComposer>
            ) : (
              // Mobile / low-power: a single soft bloom (no mip chain, no
              // vignette) — keeps the gentle glow ON without tanking FPS.
              <EffectComposer>
                <Bloom
                  luminanceThreshold={0.32}
                  luminanceSmoothing={0.85}
                  intensity={0.45}
                />
              </EffectComposer>
            )
          }
        />
      </Canvas>

      {/* Screen-reader / reduced-motion text readout (visually hidden). */}
      <p className="sr-only">{ariaLabel}</p>

      {reducedMotion && (
        <div className="absolute bottom-3 left-3 rounded bg-background-elevated/80 px-2 py-1 text-xs text-text-muted">
          {t('accessibility.reduced_motion')}
        </div>
      )}
    </div>
  );
}
