/**
 * The single chart-regeneration handler.
 *
 * Onboarding and Settings used to inline the same four-step sequence
 * (generate → adapt → save → reset), which let Settings drift: it orphaned the
 * old chart under a new id, dropped `profile_id`, had no change-detection, and
 * never re-streamed the interpretation. This module is now the ONE place that
 * sequence lives; both pages just emit `birth-info-changed` (see `events.ts`).
 *
 * Pure-ish and dependency-injected so it is unit-testable without React, the
 * Pyodide engine, or IndexedDB: callers pass an `engine`, a `library` facade
 * (satisfied by `useChartLibraryStore.getState()`), and an `onRegenerated`
 * callback that resets ephemeral interpretation/chat and triggers the re-stream.
 */

import type { BirthInput, SiderealChart } from '@almamesh/browser/types';

import { type BirthMeta, chartId, siderealChartToChartData, toBirthInput } from './adapters/chart';
import type { StoredChart } from './chartLibrary';
import type { BirthInfoChanged } from './events';

/** The minimal engine surface the handler needs (the Pyodide chart engine). */
export interface RegenerateEngine {
  generateChart: (input: BirthInput) => Promise<SiderealChart>;
}

/** The minimal chart-library surface the handler mutates. */
export interface RegenerateLibrary {
  /** Every stored chart, independent of whichever profile is active now. */
  listAllCharts: () => StoredChart[];
  saveChart: (chart: StoredChart) => void;
  deleteChart: (chartId: string) => void;
}

/** The chat surface the handler repairs (satisfied by `useChatStore.getState()`). */
export interface RegenerateChat {
  /** Drop chat links to charts outside `liveChartIds`, keeping every message. */
  unlinkMissingCharts: (liveChartIds: ReadonlySet<string>) => readonly string[];
}

/** Everything the handler depends on; injected so it stays testable. */
export interface RegenerateDeps {
  readonly engine: RegenerateEngine;
  readonly library: RegenerateLibrary;
  /**
   * Chat threads remember the chart they were started on. Deleting the prior
   * chart without unlinking them left a dangling `chart_id` that made Export
   * refuse the whole dataset (production, 2026-10-05).
   */
  readonly chat: RegenerateChat;
  /** Reset ephemeral interpretation/chat + trigger the interpretation re-stream. */
  readonly onRegenerated: () => void;
  /**
   * The instant this chart is computed "as of" — mint it with
   * `newChartReferenceInstant()`. Injected rather than read here so this module
   * touches no clock: the same event + the same instant regenerates the same
   * chart, which is the whole determinism claim.
   */
  readonly referenceInstant: string;
}

/** Build the new primary `StoredChart`, preserving the owning profile. */
function buildPrimary(
  chart: SiderealChart,
  birth: BirthMeta,
  profileId: string | null,
  referenceInstant: string,
): StoredChart {
  const data = siderealChartToChartData(chart, birth, referenceInstant);
  return {
    ...data,
    chart_id: data.chart_id,
    person_name: birth.name,
    is_primary: true,
    ...(profileId === null ? {} : { profile_id: profileId }),
    sidereal_chart: chart,
  };
}

/** Resolve the primary in the event owner's profile, never the active UI profile. */
function primaryForProfile(
  library: RegenerateLibrary,
  profileId: string | null,
): StoredChart | undefined {
  const scoped = library
    .listAllCharts()
    .filter((stored) => (stored.profile_id ?? null) === profileId);
  return scoped.find((stored) => stored.is_primary) ?? scoped[0];
}

/**
 * Regenerate the primary chart in response to a `birth-info-changed` event.
 *
 * No-op (rename-only) when the effective birth inputs yield the same `chartId`.
 * Otherwise: compute the chart on-device, save the new primary with
 * `profile_id` PRESERVED, delete the prior primary row (the orphan), unlink chat
 * threads from it, then let
 * the caller reset ephemeral state and re-stream the interpretation.
 */
export async function regenerateOnBirthChange(
  event: BirthInfoChanged,
  deps: RegenerateDeps,
): Promise<void> {
  const { birth, profileId } = event;
  const nextId = chartId(birth);
  const prior = primaryForProfile(deps.library, profileId);
  if (prior?.chart_id === nextId) {
    return;
  }
  // ONE instant for both the engine input and the stored `calculation_timestamp`.
  const { referenceInstant } = deps;
  const chart = await deps.engine.generateChart(toBirthInput(birth, referenceInstant));
  deps.library.saveChart(buildPrimary(chart, birth, profileId, referenceInstant));
  if (prior && prior.chart_id !== nextId) {
    deps.library.deleteChart(prior.chart_id);
    deps.chat.unlinkMissingCharts(
      new Set(deps.library.listAllCharts().map((stored) => stored.chart_id)),
    );
  }
  deps.onRegenerated();
}
