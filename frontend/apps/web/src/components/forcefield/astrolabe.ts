/**
 * The Living Astrolabe — pure presentation decisions for the force-field.
 *
 * One radiant core, a quiet engraved wheel, and at most three dasha threads.
 * Everything here is chart-derived from the existing `EnergyFrame` (active
 * maha/antar lords, friendliness, amplitude) — NO astrology is computed here,
 * only visual-hierarchy decisions. Fully typed (no `@ts-nocheck`): pure math,
 * no R3F JSX, unit-tested in `astrolabe.test.ts`.
 */

import type {
  ActiveDasha,
  PlanetName,
  PlanetWave,
} from '@almamesh/shared-types';

// ============================================================================
// Focal hierarchy — dasha lords dominate, the other seven recede
// ============================================================================

/** Scale multiplier for the current dasha lords (maha + antar). */
export const LORD_SCALE = 1.6;
/** Full presence for the lords. */
export const LORD_OPACITY = 1.0;
/** The seven non-lords recede into the engraved field. */
export const FIELD_OPACITY = 0.72;
/** Gentle breathing amplitude reserved for the lords; the field holds still. */
export const LORD_PULSE = 0.06;

export interface PlanetRole {
  readonly isMaha: boolean;
  readonly isAntar: boolean;
  readonly isLord: boolean;
  readonly scale: number;
  readonly opacity: number;
  readonly pulseAmplitude: number;
}

/** Visual role of a planet under the current dasha lords. */
export function planetRole(id: PlanetName, active: ActiveDasha): PlanetRole {
  const isMaha = id === active.maha;
  const isAntar = active.antar !== null && id === active.antar;
  const isLord = isMaha || isAntar;
  return {
    isMaha,
    isAntar,
    isLord,
    scale: isLord ? LORD_SCALE : 1,
    opacity: isLord ? LORD_OPACITY : FIELD_OPACITY,
    pulseAmplitude: isLord ? LORD_PULSE : 0,
  };
}

// ============================================================================
// Dasha threads — 27 hairlines → at most 3 legible threads
// ============================================================================

export type ThreadKind = 'maha' | 'antar' | 'discord';

export interface ThreadSpec {
  readonly planetId: PlanetName;
  readonly kind: ThreadKind;
}

/** Hard cap on simultaneous threads. */
export const MAX_THREADS = 3;
/** |friendlinessToActive| needed before a discord thread is drawn. */
export const DISCORD_MIN_HOSTILITY = 0.5;

/**
 * Choose which planets get a visible thread to the core:
 * the maha lord, the antar lord (when distinct), and optionally the single
 * strongest hostile planet (amplitude-weighted) that is not itself a lord.
 */
export function selectThreads(
  planets: readonly PlanetWave[],
  active: ActiveDasha,
): ThreadSpec[] {
  const byId = new Map(planets.map((p) => [p.id, p]));
  const threads: ThreadSpec[] = [];

  if (byId.has(active.maha)) {
    threads.push({ planetId: active.maha, kind: 'maha' });
  }
  if (
    active.antar !== null &&
    active.antar !== active.maha &&
    byId.has(active.antar)
  ) {
    threads.push({ planetId: active.antar, kind: 'antar' });
  }

  const lordIds = new Set(threads.map((t) => t.planetId));
  const discord = planets
    .filter(
      (p) =>
        !lordIds.has(p.id) &&
        p.friendlinessToActive <= -DISCORD_MIN_HOSTILITY,
    )
    .reduce<PlanetWave | null>((best, p) => {
      const score = p.amplitude * Math.abs(p.friendlinessToActive);
      const bestScore = best
        ? best.amplitude * Math.abs(best.friendlinessToActive)
        : -Infinity;
      return score > bestScore ? p : best;
    }, null);

  if (discord && threads.length < MAX_THREADS) {
    threads.push({ planetId: discord.id, kind: 'discord' });
  }

  return threads.slice(0, MAX_THREADS);
}

// ============================================================================
// Core flux ring — one ring system, rate from netFlux (never planet count)
// ============================================================================

/** Idle ring pulse rate (rad/s) at balanced flux. */
export const RING_RATE_MIN = 0.16;
/** Cap — the core must stay calm (audit target ≤ 0.5 rad/s). */
export const RING_RATE_MAX = 0.5;

/**
 * Ring pulse rate from the aura's net flux. The adapter clamps netFlux to
 * [-2, 2]; the mapping is linear in |netFlux| and hard-capped at RING_RATE_MAX.
 */
export function ringRateFromNetFlux(netFlux: number): number {
  const n = Math.min(Math.abs(netFlux) / 2, 1);
  return RING_RATE_MIN + (RING_RATE_MAX - RING_RATE_MIN) * n;
}

// ============================================================================
// Labels & Zodiac wheel — legible orientation + progressive disclosure
// ============================================================================

export type LabelMode = 'all' | 'lords' | 'hover';
export type CameraViewMode = '3d' | 'top';

/** 3-letter ASCII sign abbreviations (0 = Aries .. 11 = Pisces). */
export const ZODIAC_ABBR: readonly string[] = [
  'ARI',
  'TAU',
  'GEM',
  'CAN',
  'LEO',
  'VIR',
  'LIB',
  'SCO',
  'SAG',
  'CAP',
  'AQU',
  'PIS',
];

/** Hover/selection helper kept for unit-test & halo compatibility. */
export function labelVisible(hovered: boolean, selected: boolean): boolean {
  return hovered || selected;
}

/** Decide whether a planet's 3D label should render under the active mode. */
export function shouldShowPlanetLabel(
  mode: LabelMode,
  isKeyRole: boolean,
  hovered: boolean,
  selected: boolean,
): boolean {
  if (mode === 'all') return true;
  if (mode === 'lords') return isKeyRole || hovered || selected;
  return hovered || selected;
}

/** 3-letter ASCII sign abbreviation from an ecliptic longitude (0..360). */
export function signAbbrFromLongitude(longitude: number): string {
  const norm = ((longitude % 360) + 360) % 360;
  const idx = Math.floor(norm / 30) % 12;
  return ZODIAC_ABBR[idx] ?? 'ARI';
}

/** Whole degree (0..29) within a 30-degree zodiac sign. */
export function inSignDegree(longitude: number): number {
  const norm = ((longitude % 30) + 30) % 30;
  return Math.floor(norm);
}

/**
 * Secondary ASCII sub-label for a planet in 3D space: highlights active
 * Dasha / friction roles first, otherwise falls back to `<deg>deg <SIGN>`.
 */
export function planetSubLabel(
  planet: PlanetWave,
  active: ActiveDasha,
  threads: readonly ThreadSpec[],
): string {
  if (planet.id === active.maha && planet.id === active.antar) {
    return 'MAHA + ANTAR';
  }
  if (planet.id === active.maha) return 'MAHA LORD';
  if (planet.id === active.antar) return 'ANTAR LORD';
  const thread = threads.find((t) => t.planetId === planet.id);
  if (thread?.kind === 'discord') return 'FRICTION';
  const deg = inSignDegree(planet.eclipticLongitude);
  const sign = signAbbrFromLongitude(planet.eclipticLongitude);
  return `${deg}° ${sign}`;
}

/** Minimum angular separation (degrees) before two labels stagger vertically. */
const LABEL_COLLISION_DEG = 18;
const BASE_LABEL_Y = 0.56;
const STAGGER_STEP_Y = 0.34;

function angularDistanceDeg(a: number, b: number): number {
  const diff = Math.abs(((a - b) % 360 + 540) % 360 - 180);
  return diff;
}

/**
 * Stagger 3D label heights when two or more planets sit in close ecliptic
 * longitude so conjunct planets never collide visually.
 */
export function computeLabelElevations(
  planets: readonly PlanetWave[],
): ReadonlyMap<PlanetName, number> {
  const sorted = [...planets].sort(
    (a, b) => a.eclipticLongitude - b.eclipticLongitude,
  );
  const tiers = new Map<PlanetName, number>();
  const placed: { lon: number; tier: number }[] = [];

  for (const p of sorted) {
    const usedTiers = new Set(
      placed
        .filter((prev) => angularDistanceDeg(prev.lon, p.eclipticLongitude) < LABEL_COLLISION_DEG)
        .map((prev) => prev.tier),
    );
    let tier = 0;
    while (usedTiers.has(tier) && tier < 3) tier++;
    tiers.set(p.id, BASE_LABEL_Y + tier * STAGGER_STEP_Y);
    placed.push({ lon: p.eclipticLongitude, tier });
  }
  return tiers;
}

// ============================================================================
// Entrance choreography (~2.5 s, once per mount)
// ============================================================================

/** Total entrance length in wave-clock seconds. */
export const ENTRANCE_DURATION = 2.5;

const CORE_WINDOW: readonly [number, number] = [0, 0.7];
const RING_WINDOW: readonly [number, number] = [0.5, 1.4];
const THREAD_WINDOW: readonly [number, number] = [1.8, 2.5];
const PLANET_START = 0.9;
const PLANET_STAGGER_SPAN = 0.9;
const PLANET_FADE = 0.4;

function easeOutCubic(x: number): number {
  return 1 - Math.pow(1 - x, 3);
}

function windowProgress(t: number, [start, end]: readonly [number, number]): number {
  if (t <= start) return 0;
  if (t >= end) return 1;
  return easeOutCubic((t - start) / (end - start));
}

export interface EntrancePhase {
  /** Core ignition 0..1. */
  readonly core: number;
  /** Zodiac ring sweep 0..1. */
  readonly ring: number;
  /** Dasha threads draw-in 0..1. */
  readonly threads: number;
}

/**
 * Entrance timeline at wave-clock `t`. `skip` (reduced motion) returns the
 * final static frame immediately.
 */
export function entrancePhase(t: number, skip = false): EntrancePhase {
  if (skip) return { core: 1, ring: 1, threads: 1 };
  return {
    core: windowProgress(t, CORE_WINDOW),
    ring: windowProgress(t, RING_WINDOW),
    threads: windowProgress(t, THREAD_WINDOW),
  };
}

/**
 * Per-planet fade/scale-in, staggered by longitude order (`orderIndex` from
 * `revealOrder`). Clamped 0..1; `skip` jumps to fully revealed.
 */
export function planetReveal(
  t: number,
  orderIndex: number,
  total: number,
  skip = false,
): number {
  if (skip) return 1;
  const denom = Math.max(total - 1, 1);
  const start = PLANET_START + (orderIndex / denom) * PLANET_STAGGER_SPAN;
  return windowProgress(t, [start, start + PLANET_FADE]);
}

/** Reveal order: ascending ecliptic longitude (a sweep around the wheel). */
export function revealOrder(planets: readonly PlanetWave[]): PlanetName[] {
  return [...planets]
    .sort((a, b) => a.eclipticLongitude - b.eclipticLongitude)
    .map((p) => p.id);
}
