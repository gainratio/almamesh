/**
 * Production diagnostics that remain useful without exposing user or provider data.
 * Raw causes are accepted at this boundary but are intentionally never formatted,
 * serialized, or sent to the console.
 */
export const SAFE_DIAGNOSTIC_CODES = [
  'app.typed_error',
  'backup.local_mirror_deferred',
  'backup.memory_rebuild_deferred',
  'cache.query_not_found',
  'chart.regeneration_failed',
  'chart.save_failed',
  'chart.save_timed_out',
  'chat.stream_failed',
  'chat.summary_failed',
  'dashboard.chart_fetch_failed',
  'dashboard.interpretation_failed',
  'engine.prewarm_failed',
  'engine.warming',
  'error_boundary.caught',
  'feedback.storage_binding_missing',
  'feedback.storage_write_failed',
  'feedback.turnstile_init_failed',
  'geo.city_lookup_failed',
  'geo.online_lookup_failed',
  'interpretation.stream_failed',
  'lifecycle.portable_references_repaired',
  'lifecycle.memory_drain_failed',
  'lifecycle.remote_deletion_failed',
  'memory.index_failed',
  'memory.retrieve_failed',
  'memory.search_failed',
  'onboarding.progress_save_failed',
  'onboarding.save_failed',
  'people.add_failed',
  'provider.connection_test_failed',
  'provider.credits_failed',
  'provider.disable_failed',
  'provider.models_failed',
  'provider.settings_save_failed',
  'rectify.apply_failed',
  'render.webgl_unavailable',
  'report.evidence_annotation_failed',
  'report.pdf_generation_failed',
  'storage.hydration_failed',
  'storage.interpretation_quarantined',
  'storage.interpretation_quarantine_migration_failed',
  'storage.interpretation_quarantine_hold_failed',
  'storage.interpretation_quarantine_prune_failed',
  'storage.interpretation_quarantine_legacy_unreadable',
  'storage.interpretation_write_refused',
  'storage.opfs_unavailable',
  'storage.state_open_failed',
  'stream.invalid_event',
  'sw.get_registration_failed',
  'sw.heal_failed',
  'sw.shell_cleanup_failed',
  'sw.update_check_failed',
] as const;

export type SafeDiagnosticCode = (typeof SAFE_DIAGNOSTIC_CODES)[number];

export function safeError(code: SafeDiagnosticCode, _cause?: unknown): void {
  console.error(`[almamesh:error:${code}]`);
}

export function safeWarn(code: SafeDiagnosticCode, _cause?: unknown): void {
  console.warn(`[almamesh:warn:${code}]`);
}
