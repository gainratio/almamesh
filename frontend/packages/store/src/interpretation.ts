/**
 * Interpretation store — the on-device, local-first home for the structured
 * `VedicInterpretation` the app generates client-side, keyed by `chartId` and
 * persisted to portable SQLite so a generated reading survives reloads and joins the
 * same crash-atomic personal-data Replace transaction as every other store.
 *
 * No backend, no streaming SSE: unlike the predecessor (which tracked a server
 * stream token-by-token), the WHOLE `VedicInterpretation` is produced in the
 * browser, so this store holds the finished object plus coarse per-section
 * progress for the dashboard to render. Persistence uses the shared personal-
 * data SQLite transaction under one key, alongside the chart/profile stores.
 *
 * Callers pass `updatedAt` (an ISO string) explicitly — the store never calls
 * `Date.now()`/`new Date()` itself, keeping it deterministic and easy to test.
 */

import { create, type StateCreator } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

import type {
  NatalInterpretation,
  RawEvidenceAnnotationPayload,
  ReadingProvenance,
} from '@almamesh/llm';
import { safeWarn, type TitledPersona, type VedicInterpretation } from '@almamesh/shared-types';
import { deletionAwareIdbStorage, interpretationQuarantineRows } from './deletionTombstones';
import { reportHydrationFailure, whenHydrated, type HydrationOutcome } from './hydrationBarrier';
import {
  holdUnreadableInterpretation,
  migrateLegacyInterpretationQuarantine,
  pruneExpiredInterpretationQuarantine,
  retireExpiredLegacyQuarantine,
  type UnreadableInterpretation,
} from './interpretationQuarantine';
import { portableStatePersistence } from './portablePersistence';
import { browserLocalStorage, type LegacyWebStorage } from './webStorage';

export {
  INTERPRETATION_QUARANTINE_KEY,
  INTERPRETATION_QUARANTINE_TTL_DAYS,
  type UnreadableInterpretation,
} from './interpretationQuarantine';

/** Lifecycle of a chart's interpretation generation. */
export type InterpretationStatus = 'idle' | 'generating' | 'complete' | 'error';

/**
 * WHY an interpretation failed, machine-readable.
 *
 * The companion to the human-readable `error` sentence — never a replacement.
 * The sentence is already localized prose, so a UI that wants to treat
 * "the provider is out of credits" differently from "the app hit a defect"
 * would otherwise have to re-parse translated text. This records the verdict
 * once, at the point of failure, so consumers can switch on it.
 *
 * The provider-side kinds mirror the shared `@gainratio/errors` classification
 * (credits / auth / model / privacy / rate_limited / reasoning_timeout /
 * server / network / unknown); `needs_regeneration` is the app-state failure where a stored chart
 * carries no raw engine output to interpret.
 */
export type InterpretationErrorKind =
  | 'credits'
  | 'auth'
  | 'model'
  | 'privacy'
  | 'rate_limited'
  | 'reasoning_timeout'
  | 'server'
  | 'network'
  | 'needs_regeneration'
  | 'unknown';

/**
 * Deterministic inputs that may have shaped a generated reading.
 *
 * A string means the LLM received predictive facts computed for that exact
 * natal-input/day key. `null` explicitly means the reading was natal-only.
 * An absent `inputProvenance` is legacy/unknown and must not be conflated with
 * natal-only by consumers: older builds could narrate predictive facts without
 * recording which request produced them.
 */
export interface InterpretationInputProvenance {
  readonly predictiveRequestKey: string | null;
}

/** The time-sensitive prose generated separately from the stable natal reading. */
export interface CurrentTimelineContent {
  readonly upcoming_periods: readonly TitledPersona[] | null;
  readonly current_sky: readonly TitledPersona[] | null;
}

/** Independent lifecycle for the explicitly refreshed, date-sensitive timeline. */
export interface CurrentTimelineEntry {
  readonly status: InterpretationStatus;
  readonly content?: CurrentTimelineContent;
  readonly error?: string;
  readonly errorKind?: InterpretationErrorKind;
  readonly sections: Readonly<Record<string, boolean>>;
  readonly failedSections?: Readonly<Record<string, boolean>>;
  /**
   * Section key -> canonical error code (e.g. `ai.provider.server_error`) of a
   * failed section, so the partial-failure notice can name the cause instead
   * of a bare "could not be generated". Optional; cleared on each new run.
   */
  readonly failedSectionCodes?: Readonly<Record<string, string>>;
  readonly updatedAt?: string;
  readonly provenance?: ReadingProvenance;
  readonly inputProvenance?: InterpretationInputProvenance;
}

/** The persisted record for a single chart's interpretation. */
export interface ChartInterpretationEntry {
  readonly status: InterpretationStatus;
  /** The finished structured reading; present once `status === 'complete'`. */
  readonly interpretation?: NatalInterpretation;
  /** Failure message; present once `status === 'error'`. */
  readonly error?: string;
  /**
   * The typed reason behind `error`. Optional so entries persisted before this
   * field existed hydrate unchanged; consumers treat a missing kind as unknown.
   */
  readonly errorKind?: InterpretationErrorKind;
  /** Section key -> completed. Lets the dashboard show progressive progress. */
  readonly sections: Readonly<Record<string, boolean>>;
  /**
   * Section key -> failed. Per-section LLM failures degrade that section to
   * empty while the run still completes; recording them here lets the UI stay
   * honest about the gap (and offer a regenerate) instead of rendering a blank
   * section with no signal. Optional so pre-existing persisted entries load
   * unchanged; cleared by `startInterpretation`.
   */
  readonly failedSections?: Readonly<Record<string, boolean>>;
  /** ISO-8601 timestamp of the last mutation; supplied by the caller. */
  readonly updatedAt?: string;
  /**
   * The display-friendly identity of the resolved LLM provider config that
   * produced this reading (`configProvenance` from `@almamesh/llm`:
   * engine/model/endpoint, NEVER a key). Lets the UI caption the reading
   * ("Generated by <model>") and the dashboard detect "the configured AI
   * changed since this reading was generated" and regenerate. Absent on
   * pre-v3 persisted entries — treated as a mismatch by the consumer.
   */
  readonly provenance?: ReadingProvenance;
  /** Exact predictive input used for this reading, or explicit natal-only. */
  readonly inputProvenance?: InterpretationInputProvenance;
  /** Owning profile, retained across chart regeneration for complete deletion. */
  readonly profileId?: string;
  /**
   * RAW, UNVALIDATED model output for the evidence-backed report: prose the
   * model attached to observations the deterministic engine already computed.
   *
   * Stored raw on purpose. `apps/web/src/lib/evidence/ledger.ts` is the single
   * validation site — it rejects any statement citing an id this chart does not
   * contain — so validating here too would create a second place for that rule
   * to drift. Nothing renders from this field without going through the ledger.
   *
   * Optional and purely additive: the annotation call is a separate, best-effort
   * step AFTER the reading is already saved, so an entry with no annotations is
   * the normal shape (no key, call failed, older build). Consumers render the
   * evidence table keyless — observation/evidence/confidence/alternative with an
   * empty interpretation cell — which loses nothing deterministic.
   */
  readonly evidenceAnnotations?: RawEvidenceAnnotationPayload;
  /** Explicitly refreshed timing prose; independent from the stable natal reading. */
  readonly timeline?: CurrentTimelineEntry;
}

/** Ephemeral identity for one generation attempt; never persisted. */
export type InterpretationRunToken = number;

export interface InterpretationStore {
  /** All interpretation entries, keyed by `chartId`. */
  readonly byChart: Readonly<Record<string, ChartInterpretationEntry>>;

  /**
   * Begin generation: status -> 'generating', clearing progress + error. A
   * previously completed reading (and its provenance/updatedAt) is KEPT on the
   * entry — keep-old-until-success — so a regeneration never destroys the
   * reading on screen; only a successful `setInterpretation` replaces it.
   */
  startInterpretation: (chartId: string, profileId?: string) => InterpretationRunToken;
  /** Record that one named section finished (progressive progress). */
  markSectionComplete: (
    chartId: string,
    section: string,
    runToken?: InterpretationRunToken,
  ) => void;
  /** Record that one named section FAILED (degraded to empty; run continues). */
  markSectionFailed: (
    chartId: string,
    section: string,
    runToken?: InterpretationRunToken,
  ) => void;
  /**
   * Store the finished reading: status -> 'complete'. `provenance` is the
   * identity of the config that produced it; omitting it (legacy callers)
   * stores an unattributed reading, which consumers treat as config-mismatched.
   * `inputProvenance` independently records whether the LLM received an exact
   * predictive request or a natal-only chart. Omitting it means legacy/unknown.
   */
  setInterpretation: (
    chartId: string,
    interpretation: VedicInterpretation,
    updatedAt: string,
    provenance?: ReadingProvenance,
    inputProvenance?: InterpretationInputProvenance,
    runToken?: InterpretationRunToken,
  ) => Promise<void>;
  /**
   * Attach RAW evidence annotations to a chart's entry. Separate from
   * `setInterpretation` because the annotation call happens AFTER the reading is
   * already stored and shown: it is an enhancement, never a precondition, and a
   * failure to make it leaves the entry exactly as it is. Pass the `runToken`
   * from `startInterpretation` so a slow call from a superseded run cannot land
   * its prose on a newer reading.
   */
  setEvidenceAnnotations: (
    chartId: string,
    annotations: RawEvidenceAnnotationPayload,
    runToken?: InterpretationRunToken,
  ) => Promise<void>;
  /**
   * Record a failure: status -> 'error'. `kind` is the typed verdict behind the
   * message (omitted by legacy callers, which consumers read as unknown).
   */
  setError: (
    chartId: string,
    error: string,
    kind?: InterpretationErrorKind,
    runToken?: InterpretationRunToken,
  ) => void;
  /** Begin an explicit current-timeline refresh without touching natal state. */
  startCurrentTimeline: (chartId: string, profileId?: string) => InterpretationRunToken;
  markCurrentTimelineSectionComplete: (
    chartId: string,
    section: string,
    runToken?: InterpretationRunToken,
  ) => void;
  markCurrentTimelineSectionFailed: (
    chartId: string,
    section: string,
    runToken?: InterpretationRunToken,
    /** Canonical error code of the failure, shown next to the section name. */
    code?: string,
  ) => void;
  setCurrentTimeline: (
    chartId: string,
    content: CurrentTimelineContent,
    updatedAt: string,
    provenance?: ReadingProvenance,
    inputProvenance?: InterpretationInputProvenance,
    runToken?: InterpretationRunToken,
  ) => Promise<void>;
  setCurrentTimelineError: (
    chartId: string,
    error: string,
    kind?: InterpretationErrorKind,
    runToken?: InterpretationRunToken,
  ) => void;
  /**
   * End a timeline run nobody is waiting for any more (the page unmounted and
   * aborted its stream). Without this the entry stays 'generating' with no
   * stream behind it. A previous timeline is kept as 'complete'; a first run
   * leaves no timeline. A superseded run token is ignored.
   */
  abandonCurrentTimeline: (chartId: string, runToken: InterpretationRunToken) => void;
  /** Read one chart's entry, or `undefined` if none exists. */
  getEntry: (chartId: string) => ChartInterpretationEntry | undefined;
  /** Drop one chart's entry entirely. */
  reset: (chartId: string) => void;
  /**
   * The chart was replaced (a regeneration gave it a new id): drop its entry
   * AND refuse every later write for it until a new run starts for that id,
   * so a reading still streaming cannot write a reading for a chart that no
   * longer exists (which Export refused, 2026-10-05).
   */
  forgetChart: (chartId: string) => void;
  /** Drop current and historical chart entries owned by one profile. */
  deleteForProfile: (profileId: string, currentChartIds: readonly string[]) => void;
  /** Attribute legacy entries only when current chart/thread ownership is unambiguous. */
  backfillProfileOwnership: (ownersByChart: Readonly<Record<string, string>>) => void;
  /** Drop every chart's entry — the "start fresh" reset. */
  clearAll: () => void;
}

/** One canonical SQLite row holding every interpretation, persisted by Zustand. */
export const INTERPRETATION_PERSIST_NAME = 'almamesh-interpretations';

/**
 * Bump when the persisted shape changes; always pair with `migrate`.
 * v2: `VedicInterpretation.summary` went from a bare `string` to a dual-mode
 * `Persona` ({ layman, technical }). The migration normalizes any old string
 * summary into both voices — no regeneration; the old text renders in both.
 * v3: entries gained an optional `provenance` config fingerprint. Purely
 * additive: v2 entries hydrate unchanged with `provenance: undefined` and keep
 * rendering; the dashboard treats the missing fingerprint as a config
 * mismatch and regenerates once when an AI capable of readings is configured.
 * v4: entries gained optional `inputProvenance`, distinguishing an exact
 * predictive request from explicit natal-only generation. Existing entries
 * remain unknown so consumers can fail closed instead of reusing possibly
 * stale predictive prose.
 * v5: entries may carry `profileId` ownership. Legacy ownerless readings are
 * preserved; deletion removes them only when chart/thread ownership proves
 * they belong to the deleted profile.
 * v6: date-sensitive `upcoming_periods` + `current_sky` move out of the natal
 * interpretation into an independent timeline lifecycle. Existing combined
 * readings are split losslessly on hydration; the natal record becomes stable
 * and the saved timeline remains visible until the user explicitly refreshes it.
 *
 * NOT a version: `evidenceAnnotations` is OPTIONAL and additive, so an entry
 * written before it existed hydrates byte-identical and renders a keyless
 * evidence table. A bump here would force a needless migration pass for a field
 * whose absence is already a valid, fully-supported state.
 */
export const INTERPRETATION_PERSIST_VERSION = 6;

/** The slice of the store that `partialize` actually persists. */
export interface PersistedInterpretationState {
  readonly byChart: Readonly<Record<string, ChartInterpretationEntry>>;
}

/** A plain (non-array) object — the only shape `byChart` may safely take. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Defensive hydration: tolerate ANY old/unknown/corrupt persisted blob and
 * always return a valid `{ byChart }`. A returning visitor whose stored reading
 * map is malformed (a string, an array, a missing field) must never crash the
 * dashboard — we fall back to an empty map and the reading regenerates.
 */
export function migrateInterpretationPersistedState(
  persisted: unknown,
  _fromVersion: number,
): PersistedInterpretationState {
  if (!isPlainRecord(persisted)) {
    return { byChart: {} };
  }
  const byChart = persisted.byChart;
  if (!isPlainRecord(byChart)) {
    return { byChart: {} };
  }
  const normalized: Record<string, ChartInterpretationEntry> = {};
  for (const [chartId, entry] of Object.entries(byChart)) {
    const healed = healInterruptedEntry(splitLegacyTimeline(normalizeEntrySummary(entry)));
    if (healed) {
      normalized[chartId] = healed;
    }
  }
  return { byChart: normalized };
}

/** Losslessly split the pre-v6 combined reading into stable natal + timeline. */
function splitLegacyTimeline(entry: ChartInterpretationEntry): ChartInterpretationEntry {
  if (!isPlainRecord(entry) || !entry.interpretation) {
    return entry;
  }
  // Persisted pre-v6 entries may contain any of the legacy timing fields even
  // though the current in-memory contract is natal-only.
  const legacyInterpretation = entry.interpretation as VedicInterpretation;
  const { upcoming_periods, current_sky, current_period_guidance } = legacyInterpretation;
  if (
    upcoming_periods === undefined &&
    current_sky === undefined &&
    current_period_guidance === undefined
  ) {
    return entry;
  }
  const timelineSections = Object.fromEntries(
    Object.entries(entry.sections).filter(([key]) =>
      key === 'upcoming_periods' || key === 'current_sky'),
  );
  const timelineFailedSections = Object.fromEntries(
    Object.entries(entry.failedSections ?? {}).filter(([key]) =>
      key === 'upcoming_periods' || key === 'current_sky'),
  );
  // Every pre-v6 combined artifact is potentially timing-contaminated: even
  // entries with missing or explicit-null provenance came from prompts that
  // asked natal guidance sections to discuss the current dasha.
  const invalidatedNatal: ChartInterpretationEntry = {
    ...entry,
    status: 'idle',
    interpretation: undefined,
    sections: {},
    failedSections: undefined,
    inputProvenance: undefined,
    error: undefined,
    errorKind: undefined,
  };
  // A v6 entry may already have a newer independently generated timeline.
  // Preserve it exactly while removing any legacy timing-contaminated natal prose.
  if (entry.timeline) {
    return invalidatedNatal;
  }
  // `current_period_guidance` has no lossless mapping to the two current timeline
  // sections. Invalidate the natal reading but do not manufacture an empty timeline.
  if (upcoming_periods === undefined && current_sky === undefined) {
    return invalidatedNatal;
  }
  return {
    ...invalidatedNatal,
    timeline: {
      // Extracted content is a previously completed artifact even when a newer
      // combined regeneration was interrupted or failed.
      status: 'complete',
      content: {
        upcoming_periods: upcoming_periods ?? null,
        current_sky: current_sky ?? null,
      },
      sections: timelineSections,
      ...(Object.keys(timelineFailedSections).length > 0
        ? { failedSections: timelineFailedSections }
        : {}),
      ...(entry.updatedAt !== undefined ? { updatedAt: entry.updatedAt } : {}),
      ...(entry.provenance !== undefined ? { provenance: entry.provenance } : {}),
      ...(entry.inputProvenance !== undefined
        ? { inputProvenance: entry.inputProvenance }
        : {}),
    },
  };
}

/**
 * A persisted `status: 'generating'` can never be truly in flight after a
 * reload — streams do not survive page unloads. Left alone it renders an
 * eternal "Generating…" card that the auto-generate effect refuses to replace
 * (a dead-end with no in-app recovery). Heal on every hydrate: a kept reading
 * means the run was a regeneration — surface it as 'complete'; no reading
 * means nothing was ever produced — drop the entry so auto-generate fires.
 */
function healInterruptedEntry(
  entry: ChartInterpretationEntry,
): ChartInterpretationEntry | undefined {
  if (!isPlainRecord(entry)) {
    return entry;
  }
  let healed = entry;
  if (entry.timeline?.status === 'generating') {
    healed = {
      ...healed,
      timeline: entry.timeline.content
        ? { ...entry.timeline, status: 'complete', error: undefined, errorKind: undefined }
        : undefined,
    };
  }
  if (healed.status !== 'generating') {
    return healed;
  }
  if (healed.interpretation) {
    const { error: _staleError, errorKind: _staleKind, ...kept } = entry;
    return { ...kept, timeline: healed.timeline, status: 'complete' };
  }
  // A chart with only an independently saved timeline remains useful even when
  // an interrupted first natal run left no reading behind.
  if (healed.timeline?.content) {
    return { ...healed, status: 'idle', sections: {}, error: undefined, errorKind: undefined };
  }
  return undefined;
}

/**
 * zustand-persist `merge`: runs on EVERY rehydrate (unlike `migrate`, which
 * only runs on a version bump), so same-version reloads also heal interrupted
 * generations. Reuses the defensive migrate pipeline — idempotent for healthy
 * current-shape blobs — and layers the persisted map over the live store so
 * actions survive.
 */
export function mergeInterpretationPersistedState(
  persisted: unknown,
  current: InterpretationStore,
): InterpretationStore {
  const healed = migrateInterpretationPersistedState(persisted, INTERPRETATION_PERSIST_VERSION);
  return { ...current, byChart: healed.byChart };
}

/**
 * v1 -> v2: a persisted `interpretation.summary` may be a bare `string` (the
 * pre-dual-voice shape). Normalize it to a dual-mode `Persona` so the same text
 * renders in both the "For You" and "For Astrologer" voices. Entries with no
 * interpretation, or an already-dual summary, pass through unchanged.
 */
function normalizeEntrySummary(entry: unknown): ChartInterpretationEntry {
  if (!isPlainRecord(entry)) {
    return entry as unknown as ChartInterpretationEntry;
  }
  const interpretation = entry.interpretation;
  if (!isPlainRecord(interpretation) || typeof interpretation.summary !== 'string') {
    return entry as unknown as ChartInterpretationEntry;
  }
  const summary = interpretation.summary;
  return {
    ...(entry as unknown as ChartInterpretationEntry),
    interpretation: {
      ...(interpretation as unknown as VedicInterpretation),
      summary: { layman: summary, technical: summary },
    },
  };
}

/**
 * Zustand `StateStorage` backed by portable SQLite. A verified, one-time legacy
 * localStorage migration retires the old row. Outside a browser (SSR, unit
 * tests), the durable adapter's test seam lets the store run in memory.
 */
function retireLegacyInterpretation(
  storage: Pick<Storage, 'removeItem'> | undefined,
  name: string,
): void {
  try {
    storage?.removeItem(name);
  } catch {
    // SQLite is authoritative. A blocked disposable mirror must not make
    // hydration or a durable delete fail.
  }
}

/**
 * Read the authoritative interpretation row and retire the legacy mirror once
 * a durable read proves SQLite owns it. Exported to keep the migration contract
 * directly regression-testable without replacing the Zustand storage adapter.
 */
export async function readInterpretationPersistedValue(
  name: string,
  durable: Pick<StateStorage, 'getItem' | 'setItem'> = deletionAwareIdbStorage,
  legacyStorage: LegacyWebStorage | undefined = browserLocalStorage(),
  retireLegacy: boolean | (() => boolean) = true,
  quarantine: (entry: UnreadableInterpretation) => Promise<boolean> = quarantineUnreadableInterpretation,
): Promise<string | null> {
  const shouldRetireLegacy = () =>
    typeof retireLegacy === 'function' ? retireLegacy() : retireLegacy;
  await prepareInterpretationQuarantine(legacyStorage);
  const durableValue = await durable.getItem(name);
  if (durableValue !== null) {
    // A row a previous build copied in unparsed would fail JSON.parse on every
    // boot. Set it aside and start from empty; the next save replaces it.
    if (!isPersistedEnvelope(durableValue)) {
      if (!(await setAside(quarantine, { source: 'canonical-sqlite', raw: durableValue }))) {
        throw new InterpretationSetAsideError('failed');
      }
      return null;
    }
    hydratingRaw = durableValue;
    if (shouldRetireLegacy()) retireLegacyInterpretation(legacyStorage, name);
    return durableValue;
  }

  // TODO(remove after 2026-11-04, one release after the SQLite-only move):
  // legacy localStorage interpretations reader; SQLite owns the row after it.
  let legacy: string | null = null;
  try {
    legacy = legacyStorage?.getItem(name) ?? null;
  } catch {
    return null;
  }
  if (legacy === null) return null;
  if (!isPersistedEnvelope(legacy)) {
    // Never copy an unreadable row into canonical SQLite. Retire the legacy
    // copy only once the quarantine provably holds it.
    if (!(await setAside(quarantine, { source: 'legacy-local-storage', raw: legacy }))) {
      throw new InterpretationSetAsideError('failed');
    }
    if (shouldRetireLegacy()) retireLegacyInterpretation(legacyStorage, name);
    return null;
  }

  await durable.setItem(name, legacy);
  const verified = await durable.getItem(name);
  hydratingRaw = verified;
  if (verified !== null && shouldRetireLegacy()) retireLegacyInterpretation(legacyStorage, name);
  return verified;
}

/**
 * Before reading: move an older build's localStorage quarantine into SQLite
 * (copy, verify, then retire — also when SQLite is session-only) and drop rows
 * past their 30-day expiry. A failed move keeps the source until it expires
 * and never blocks hydration: the boot notice and app must still load.
 */
async function prepareInterpretationQuarantine(
  legacyStorage: LegacyWebStorage | undefined,
): Promise<void> {
  try {
    const rows = await interpretationQuarantineRows();
    await migrateLegacyInterpretationQuarantine(legacyStorage, rows);
    await pruneExpiredInterpretationQuarantine(rows);
  } catch (error) {
    safeWarn('storage.interpretation_quarantine_migration_failed', error);
    retireExpiredLegacyQuarantine(legacyStorage);
  }
}

/** Hold an unreadable row in the SQLite quarantine; true only once it is provably held. */
export async function quarantineUnreadableInterpretation(
  entry: UnreadableInterpretation,
): Promise<boolean> {
  try {
    return await holdUnreadableInterpretation(entry, await interpretationQuarantineRows());
  } catch (error) {
    // SQLite itself could not be opened: not held, so writes stay refused.
    safeWarn('storage.interpretation_quarantine_hold_failed', error);
    return false;
  }
}

let interpretationsSetAside = false;

/**
 * Where this page load stands with an unreadable saved row. `pending`: a
 * hydration is reading the row and has not yet proven it readable or held it.
 * `failed`: the row could not be read or held. In both, the saved row may be
 * the only copy, so persisting the (empty) live map would destroy it.
 */
export type InterpretationSetAsideStatus = 'none' | 'pending' | 'held' | 'failed';

/** Typed refusal: interpretation writes are blocked to protect an unheld saved row. */
export class InterpretationSetAsideError extends Error {
  override readonly name = 'InterpretationSetAsideError';

  constructor(readonly status: 'pending' | 'failed') {
    super(
      status === 'failed'
        ? 'Saved interpretations could not be read or set aside; saving is paused to protect them.'
        : 'Saved interpretations are still loading; saving is paused until they are read.',
    );
  }
}

let setAsideStatus: InterpretationSetAsideStatus = 'none';
/** The exact bytes the current hydration handed to zustand (held if it then fails). */
let hydratingRaw: string | null = null;

/** Why interpretation writes are refused right now, or undefined when they are safe. */
export function interpretationWriteRefusal(): InterpretationSetAsideError | undefined {
  return setAsideStatus === 'pending' || setAsideStatus === 'failed'
    ? new InterpretationSetAsideError(setAsideStatus)
    : undefined;
}

function beginInterpretationHydration(): void {
  hydratingRaw = null;
  setAsideStatus = 'pending';
}

function finishInterpretationHydration(): void {
  hydratingRaw = null;
  if (setAsideStatus === 'pending') setAsideStatus = 'none';
}

/**
 * Hydration threw after the row was read (or while reading it). Hold the raw
 * bytes before anything else can touch the key; if nothing can be held, keep
 * writes refused for this page load.
 */
function holdRowAfterHydrationFailure(
  quarantine: (entry: UnreadableInterpretation) => Promise<boolean> = quarantineUnreadableInterpretation,
): void {
  const raw = hydratingRaw;
  hydratingRaw = null;
  interpretationsSetAside = true;
  if (setAsideStatus === 'failed') return;
  if (raw === null) {
    setAsideStatus = 'failed';
    return;
  }
  // Writes stay refused ('pending') until SQLite confirms it holds the row.
  setAsideStatus = 'pending';
  void quarantine({ source: 'canonical-sqlite', raw }).then((held) => {
    setAsideStatus = held ? 'held' : 'failed';
  });
}

/** True once this page load set aside unreadable saved interpretations (drives the boot notice). */
export function interpretationsWereSetAside(): boolean {
  return interpretationsSetAside;
}

async function setAside(
  quarantine: (entry: UnreadableInterpretation) => Promise<boolean>,
  entry: UnreadableInterpretation,
): Promise<boolean> {
  interpretationsSetAside = true;
  safeWarn('storage.interpretation_quarantined');
  setAsideStatus = 'pending';
  const held = await quarantine(entry);
  setAsideStatus = held ? 'held' : 'failed';
  return held;
}

/** A zustand persist envelope: parseable JSON whose top level is an object. */
function isPersistedEnvelope(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

const interpretationStorage: StateStorage = {
  getItem: (name) => readInterpretationPersistedValue(
    name,
    deletionAwareIdbStorage,
    browserLocalStorage(),
    () => portableStatePersistence() === 'opfs',
  ),
  setItem: (name, value) => {
    // Never overwrite a saved row that is still pending or failed to be held.
    if (interpretationWriteRefusal() !== undefined) {
      safeWarn('storage.interpretation_write_refused');
      return Promise.resolve();
    }
    return deletionAwareIdbStorage.setItem(name, value);
  },
  removeItem: async (name) => {
    await deletionAwareIdbStorage.removeItem(name);
    retireLegacyInterpretation(browserLocalStorage(), name);
  },
};

async function persistInterpretationSnapshot(state: InterpretationStore): Promise<void> {
  await useInterpretationStore.persist.getOptions().storage?.setItem(
    INTERPRETATION_PERSIST_NAME,
    { state: { byChart: state.byChart }, version: INTERPRETATION_PERSIST_VERSION },
  );
}

/** The entry a chart starts from before any section has completed. */
const EMPTY_ENTRY: ChartInterpretationEntry = { status: 'idle', sections: {} };

/** Read the current entry for a chart, defaulting to the empty entry. */
function entryOf(
  byChart: Record<string, ChartInterpretationEntry>,
  chartId: string,
): ChartInterpretationEntry {
  return byChart[chartId] ?? EMPTY_ENTRY;
}

/** Pure: write one chart's entry, leaving the rest of the map untouched. */
function withEntry(
  byChart: Record<string, ChartInterpretationEntry>,
  chartId: string,
  entry: ChartInterpretationEntry,
): Record<string, ChartInterpretationEntry> {
  return { ...byChart, [chartId]: entry };
}

export const interpretationStoreCreator: StateCreator<InterpretationStore> = (set, get) => {
  const activeRuns = new Map<string, InterpretationRunToken>();
  const activeTimelineRuns = new Map<string, InterpretationRunToken>();
  let nextRunToken = 0;

  // Charts replaced by a regeneration: no write lands for them until a new
  // run starts for the same id.
  const forgotten = new Set<string>();
  const acceptsRun = (chartId: string, runToken?: InterpretationRunToken): boolean =>
    !forgotten.has(chartId) && (runToken === undefined || activeRuns.get(chartId) === runToken);
  const acceptsTimelineRun = (chartId: string, runToken?: InterpretationRunToken): boolean =>
    !forgotten.has(chartId) &&
    (runToken === undefined || activeTimelineRuns.get(chartId) === runToken);

  return {
    byChart: {},

    startInterpretation: (chartId, profileId) => {
      forgotten.delete(chartId);
      nextRunToken += 1;
      const runToken = nextRunToken;
      activeRuns.set(chartId, runToken);
      set((state) => {
        const current = entryOf(state.byChart, chartId);
        // Keep-old-until-success: progress, error and failed sections reset, but
        // a previously completed reading (with its provenance + timestamp) stays
        // on the entry so the UI keeps showing it while — and after, if — the
        // new run fails. A brand-new chart starts from the empty entry as before.
        const kept =
          current.interpretation !== undefined
            ? {
                interpretation: current.interpretation,
                ...(current.provenance !== undefined ? { provenance: current.provenance } : {}),
                ...(current.inputProvenance !== undefined
                  ? { inputProvenance: current.inputProvenance }
                  : {}),
                ...(current.updatedAt !== undefined ? { updatedAt: current.updatedAt } : {}),
                // The kept reading keeps its own annotations while the new run
                // is in flight; only a successful `setInterpretation` drops them.
                ...(current.evidenceAnnotations !== undefined
                  ? { evidenceAnnotations: current.evidenceAnnotations }
                  : {}),
                ...(current.timeline !== undefined ? { timeline: current.timeline } : {}),
              }
            : current.timeline !== undefined
              ? { timeline: current.timeline }
              : {};
        const owner = profileId ?? current.profileId;
        return {
          byChart: withEntry(state.byChart, chartId, {
            status: 'generating',
            sections: {},
            ...kept,
            ...(owner !== undefined ? { profileId: owner } : {}),
          }),
        };
      });
      return runToken;
    },

    markSectionComplete: (chartId, section, runToken) => {
      set((state) => {
        if (!acceptsRun(chartId, runToken)) {
          return state;
        }
        const current = entryOf(state.byChart, chartId);
        const sections = { ...current.sections, [section]: true };
        return { byChart: withEntry(state.byChart, chartId, { ...current, sections }) };
      });
    },

    markSectionFailed: (chartId, section, runToken) => {
      set((state) => {
        if (!acceptsRun(chartId, runToken)) {
          return state;
        }
        const current = entryOf(state.byChart, chartId);
        const failedSections = { ...current.failedSections, [section]: true };
        return { byChart: withEntry(state.byChart, chartId, { ...current, failedSections }) };
      });
    },

    setInterpretation: async (
      chartId,
      interpretation,
      updatedAt,
      provenance,
      inputProvenance,
      runToken,
    ) => {
      // Enforce the stable-natal boundary at runtime too. Structural typing can
      // still let a legacy VedicInterpretation variable carry optional timing
      // fields through a narrower TypeScript signature.
      const natalInterpretation: NatalInterpretation =
        interpretation.upcoming_periods === undefined &&
        interpretation.current_sky === undefined &&
        interpretation.current_period_guidance === undefined
          ? interpretation
          : (({
              upcoming_periods: _legacyPeriods,
              current_sky: _legacySky,
              current_period_guidance: _legacyPeriodGuidance,
              ...stableNatal
            }) => stableNatal)(interpretation);
      set((state) => {
        if (!acceptsRun(chartId, runToken)) {
          return state;
        }
        const current = entryOf(state.byChart, chartId);
        // `provenance` always overwrites (including with undefined): the stored
        // fingerprint must describe THIS reading, never a stale predecessor's.
        // `evidenceAnnotations` is cleared for the same reason: the previous
        // reading's model prose must never appear beside a reading it was not
        // written for. The annotation step re-runs after this and refills it.
        const entry: ChartInterpretationEntry = {
          ...current,
          status: 'complete',
          interpretation: natalInterpretation,
          error: undefined,
          updatedAt,
          provenance,
          inputProvenance,
          evidenceAnnotations: undefined,
        };
        return { byChart: withEntry(state.byChart, chartId, entry) };
      });
      await persistInterpretationSnapshot(get());
    },

    setEvidenceAnnotations: async (chartId, annotations, runToken) => {
      set((state) => {
        if (!acceptsRun(chartId, runToken)) {
          return state;
        }
        const current = entryOf(state.byChart, chartId);
        return {
          byChart: withEntry(state.byChart, chartId, { ...current, evidenceAnnotations: annotations }),
        };
      });
      await persistInterpretationSnapshot(get());
    },

    setError: (chartId, error, kind, runToken) => {
      set((state) => {
        if (!acceptsRun(chartId, runToken)) {
          return state;
        }
        const current = entryOf(state.byChart, chartId);
        return {
          byChart: withEntry(state.byChart, chartId, {
            ...current,
            status: 'error',
            error,
            ...(kind !== undefined ? { errorKind: kind } : {}),
          }),
        };
      });
    },

    startCurrentTimeline: (chartId, profileId) => {
      forgotten.delete(chartId);
      nextRunToken += 1;
      const runToken = nextRunToken;
      activeTimelineRuns.set(chartId, runToken);
      set((state) => {
        const current = entryOf(state.byChart, chartId);
        const previous = current.timeline;
        const kept = previous?.content
          ? {
              content: previous.content,
              ...(previous.updatedAt !== undefined ? { updatedAt: previous.updatedAt } : {}),
              ...(previous.provenance !== undefined ? { provenance: previous.provenance } : {}),
              ...(previous.inputProvenance !== undefined
                ? { inputProvenance: previous.inputProvenance }
                : {}),
            }
          : {};
        return {
          byChart: withEntry(state.byChart, chartId, {
            ...current,
            ...(profileId !== undefined && current.profileId === undefined
              ? { profileId }
              : {}),
            timeline: { status: 'generating', sections: {}, ...kept },
          }),
        };
      });
      return runToken;
    },

    markCurrentTimelineSectionComplete: (chartId, section, runToken) => {
      set((state) => {
        if (!acceptsTimelineRun(chartId, runToken)) return state;
        const current = entryOf(state.byChart, chartId);
        const timeline = current.timeline ?? { status: 'idle' as const, sections: {} };
        return {
          byChart: withEntry(state.byChart, chartId, {
            ...current,
            timeline: {
              ...timeline,
              sections: { ...timeline.sections, [section]: true },
            },
          }),
        };
      });
    },

    markCurrentTimelineSectionFailed: (chartId, section, runToken, code) => {
      set((state) => {
        if (!acceptsTimelineRun(chartId, runToken)) return state;
        const current = entryOf(state.byChart, chartId);
        const timeline = current.timeline ?? { status: 'idle' as const, sections: {} };
        return {
          byChart: withEntry(state.byChart, chartId, {
            ...current,
            timeline: {
              ...timeline,
              failedSections: { ...timeline.failedSections, [section]: true },
              ...(code === undefined
                ? {}
                : { failedSectionCodes: { ...timeline.failedSectionCodes, [section]: code } }),
            },
          }),
        };
      });
    },

    setCurrentTimeline: async (
      chartId,
      content,
      updatedAt,
      provenance,
      inputProvenance,
      runToken,
    ) => {
      set((state) => {
        if (!acceptsTimelineRun(chartId, runToken)) return state;
        const current = entryOf(state.byChart, chartId);
        const previous = current.timeline;
        return {
          byChart: withEntry(state.byChart, chartId, {
            ...current,
            timeline: {
              status: 'complete',
              content,
              sections: previous?.sections ?? {},
              ...(previous?.failedSections !== undefined
                ? { failedSections: previous.failedSections }
                : {}),
              ...(previous?.failedSectionCodes !== undefined
                ? { failedSectionCodes: previous.failedSectionCodes }
                : {}),
              updatedAt,
              provenance,
              inputProvenance,
            },
          }),
        };
      });
      await persistInterpretationSnapshot(get());
    },

    setCurrentTimelineError: (chartId, error, kind, runToken) => {
      set((state) => {
        if (!acceptsTimelineRun(chartId, runToken)) return state;
        const current = entryOf(state.byChart, chartId);
        const timeline = current.timeline ?? { status: 'idle' as const, sections: {} };
        return {
          byChart: withEntry(state.byChart, chartId, {
            ...current,
            timeline: {
              ...timeline,
              status: 'error',
              error,
              ...(kind !== undefined ? { errorKind: kind } : {}),
            },
          }),
        };
      });
    },

    abandonCurrentTimeline: (chartId, runToken) => {
      if (!acceptsTimelineRun(chartId, runToken)) return;
      activeTimelineRuns.delete(chartId);
      set((state) => {
        const current = state.byChart[chartId];
        if (current?.timeline?.status !== 'generating') return state;
        const { content } = current.timeline;
        return {
          byChart: withEntry(state.byChart, chartId, {
            ...current,
            timeline: content ? { ...current.timeline, status: 'complete', sections: {} } : undefined,
          }),
        };
      });
    },

    getEntry: (chartId) => get().byChart[chartId],

    reset: (chartId) => {
      activeRuns.delete(chartId);
      activeTimelineRuns.delete(chartId);
      set((state) => {
        const byChart = { ...state.byChart };
        delete byChart[chartId];
        return { byChart };
      });
    },

    forgetChart: (chartId) => {
      forgotten.add(chartId);
      get().reset(chartId);
    },

    deleteForProfile: (profileId, currentChartIds) => {
      const targetIds = new Set(currentChartIds);
      set((state) => {
        const byChart: Record<string, ChartInterpretationEntry> = {};
        for (const [chartId, entry] of Object.entries(state.byChart)) {
          if (targetIds.has(chartId) || entry.profileId === profileId) {
            activeRuns.delete(chartId);
            activeTimelineRuns.delete(chartId);
          } else {
            byChart[chartId] = entry;
          }
        }
        for (const chartId of targetIds) {
          activeRuns.delete(chartId);
          activeTimelineRuns.delete(chartId);
        }
        return { byChart };
      });
    },

    backfillProfileOwnership: (ownersByChart) => {
      set((state) => ({
        byChart: Object.fromEntries(
          Object.entries(state.byChart).map(([chartId, entry]) => {
            const owner = ownersByChart[chartId];
            return [
              chartId,
              entry.profileId === undefined && owner !== undefined
                ? { ...entry, profileId: owner }
                : entry,
            ];
          }),
        ),
      }));
    },

    clearAll: () => {
      activeRuns.clear();
      activeTimelineRuns.clear();
      set({ byChart: {} });
    },
  };
};

/**
 * Interpretation store, persisted in SQLite under `almamesh-interpretations`.
 */
export const useInterpretationStore = create<InterpretationStore>()(
  persist<InterpretationStore, [], [], PersistedInterpretationState>(interpretationStoreCreator, {
    name: INTERPRETATION_PERSIST_NAME,
    version: INTERPRETATION_PERSIST_VERSION,
    migrate: migrateInterpretationPersistedState,
    merge: (persisted, current) => {
      const merged = mergeInterpretationPersistedState(persisted, current);
      // The row parsed and merged: the live map now holds it, so saves are safe.
      finishInterpretationHydration();
      return merged;
    },
    storage: createJSONStorage(() => interpretationStorage),
    partialize: (state) => ({ byChart: state.byChart }),
    onRehydrateStorage: () => {
      beginInterpretationHydration();
      return (_state, error) => {
        if (error === undefined) return;
        holdRowAfterHydrationFailure();
        safeWarn('storage.hydration_failed');
        reportHydrationFailure(useInterpretationStore.persist, error);
      };
    },
  }),
);

/** Wait until canonical SQLite state has rehydrated before starting a paid run. */
export function whenInterpretationHydrated(): Promise<HydrationOutcome> {
  return whenHydrated(useInterpretationStore.persist);
}
