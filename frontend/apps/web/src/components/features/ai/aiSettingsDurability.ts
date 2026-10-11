/**
 * Which in-memory AI settings are safe to fall back to after a failed save.
 *
 * The @almamesh/llm settings snapshot is module-global, so this record is too:
 * every AiSetupPanel instance (Settings, onboarding, a remount) shares it. Two
 * facts are tracked:
 *
 * - the write counter: bumped by every WRITE to the in-memory snapshot (a save,
 *   a turn-off, a remote Replace). A failed save restores memory only if no
 *   newer write has claimed it since.
 * - the restore target: the newest write known to be durable (the boot read, a
 *   flushed save, a Replace), or the off snapshot of a turn-off, which is set
 *   before its flush so a failed turn-off still fails CLOSED.
 *
 * Lazily initialised from the durable boot read on first use.
 */

import { readLlmSettings, type LlmSettings } from '@almamesh/llm';
import { LLM_SETTINGS_CHANGED_EVENT } from '../../../lib/llmSettingsEvents';

interface RestoreTarget {
  readonly writeId: number;
  readonly settings: LlmSettings;
}

let writeCounter = 0;
let target: RestoreTarget | undefined;
let listening = false;

// A remote Replace rebuilt memory from the canonical row: it owns memory now and
// is the restore target, whether or not a panel is mounted to see it.
function onSettingsChanged(event: Event): void {
  if (!(event instanceof CustomEvent) || event.detail?.replace !== true) return;
  writeCounter += 1;
  target = { writeId: writeCounter, settings: readLlmSettings() }; // Replace is the restore target
}

function ensureTarget(): RestoreTarget {
  if (!listening && typeof window !== 'undefined') {
    window.addEventListener(LLM_SETTINGS_CHANGED_EVENT, onSettingsChanged);
    listening = true;
  }
  target ??= { writeId: 0, settings: readLlmSettings() };
  return target;
}

/** Claim the in-memory snapshot for a write about to happen; returns its id. */
export function beginSettingsWrite(): number {
  ensureTarget(); // read the durable state BEFORE the first write changes memory
  writeCounter += 1;
  return writeCounter;
}

/** True while no newer write has claimed the in-memory snapshot. */
export function ownsSettingsMemory(writeId: number): boolean {
  return writeId === writeCounter;
}

/** Record `settings` as the restore target; an older write never replaces a newer one. */
export function markRestoreTarget(writeId: number, settings: LlmSettings): void {
  if (writeId < ensureTarget().writeId) return;
  target = { writeId, settings };
}

/** The settings a failed save should put back into memory. */
export function restoreTargetSettings(): LlmSettings {
  return ensureTarget().settings;
}

/** Unit-test seam: forget the record so the next use re-reads the hydrated state. */
export function resetSettingsDurabilityForTests(): void {
  writeCounter = 0;
  target = undefined;
}
