/**
 * Zustand stores for browser-local persisted state and UI state
 *
 * Architecture:
 * - one OPFS SQLite database owns canonical charts, profiles, chat, and language
 * - localStorage holds disposable boot mirrors and device-only provider settings
 * - in-memory stores own ephemeral UI selections
 *
 * Stores:
 * - useOnboardingStore: Onboarding flow state
 * - useChartUIStore: Chart display preferences and UI state
 * - useChartLibraryStore: On-device chart library (SQLite-backed)
 * - useChatStore: Per-profile chat history (threads + messages, SQLite-backed)
 * - useContentModeStore: "For You" vs "For Astrologer" toggle
 * - useLanguageStore: UI + AI language preference (SQLite + boot mirror)
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
export * from './adapters/chartGeometry';
// The one sanctioned clock read on the chart path (see the module docstring).
export * from './chartReferenceInstant';
export * from './adapters/energy';
export * from './adapters/mesh';
export * from './adapters/predictive';
export * from './adapters/rectification';
export * from './predictive';
export * from './mesh';
export * from './rectification';
export * from './rectificationRecords';
export * from './contentMode';
export * from './language';
export * from './interpretation';
export * from './settings';
export * from './events';
export * from './regenerate';
export * from './durablePersistence';
export * from './deletionTombstones';
export * from './portableState';
// Backup & Restore (Spec 061): export/import all user data. `backup` = storage
// collect/apply + registry; `backupCrypto` = optional passphrase encrypt/decode.
export * from './backup';
export * from './backupCrypto';
