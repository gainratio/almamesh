/**
 * Zustand stores for browser-local persisted state and UI state
 *
 * Architecture:
 * - one OPFS SQLite database owns all durable user data and preferences
 * - synchronous readers use boot-hydrated in-memory snapshots
 * - legacy Web Storage/IndexedDB is migration-only and removed after verification
 * - in-memory stores own ephemeral UI selections
 *
 * Stores:
 * - useOnboardingStore: Onboarding flow state
 * - useChartUIStore: Chart display preferences and UI state
 * - useChartLibraryStore: On-device chart library (SQLite-backed)
 * - useChatStore: Per-profile chat history (threads + messages, SQLite-backed)
 * - useContentModeStore: "For You" vs "For Astrologer" toggle
 * - useLanguageStore: UI + AI language preference (SQLite-backed)
 * - useSettingsStore: Pending settings changes
 *
 * @packageDocumentation
 */

export * from './onboarding';
export * from './chart';
export * from './chartLibrary';
export * from './lifeEvents';
export * from './chat';
export * from './profiles';
export * from './adapters/chart';
export * from './adapters/localBirthTime';
export * from './adapters/chartGeometry';
// The one sanctioned clock read on the chart path (see the module docstring).
export * from './chartReferenceInstant';
export * from './adapters/energy';
export * from './adapters/mesh';
export * from './adapters/predictive';
export * from './adapters/rectification';
export * from './predictive';
export * from './mesh';
export * from './meshReadings';
export * from './rectification';
export * from './rectificationRecords';
export * from './contentMode';
export * from './language';
export {
  checkPortableStorageAgain,
  markPortableStorageBlockedByEngine,
  portableStatePersistence,
  subscribePortableStatePersistence,
  type PortableStatePersistence,
} from './portablePersistence';
export * from './interpretation';
export {
  holdUnreadableInterpretation,
  readInterpretationQuarantine,
  type QuarantinedInterpretation,
} from './interpretationQuarantine';
export * from './settings';
export * from './events';
export * from './regenerate';
export * from './regenerationRequests';
export * from './durablePersistence';
export * from './deletionTombstones';
export { deleteLegacyKeyval } from './legacyKeyval';
export * from './portableState';
export * from './webStorage';
// Backup & Restore (Spec 061): export/import all user data. `backup` = storage
// collect/apply + registry; `backupSealing` = passphrase encryption: new files
// are age files, and every older format still opens (all crypto lives behind
// the `passphraseSeal` seam).
export * from './backup';
export * from './backupSealing';
export {
  checkBackupPassphrase,
  MIN_BACKUP_PASSPHRASE_LENGTH,
  type BackupPassphraseProblem,
} from './passphraseSeal';
export * from './portableSettings';
export * from './setAsideRecords';
// Writes the dataset generation fence refused for another realm, surfaced in the UI.
export * from './droppedWrites';
