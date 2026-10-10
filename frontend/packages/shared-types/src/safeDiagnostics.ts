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
  'chart.reanchor_failed',
  'chart.regeneration_failed',
  'chart.save_failed',
  'chart.save_timed_out',
  'chat.save_failed',
  'chat.save_timed_out',
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
  'life_events.save_failed',
  'life_events.save_timed_out',
  'lifecycle.portable_references_repaired',
  'lifecycle.memory_drain_failed',
  'lifecycle.remote_deletion_failed',
  'memory.index_failed',
  'memory.retrieve_failed',
  'memory.search_failed',
  'onboarding.progress_save_failed',
  'onboarding.save_failed',
  'people.add_failed',
  'people.discard_failed',
  'people.save_failed',
  'people.save_timed_out',
  'provider.connection_test_failed',
  'provider.credits_failed',
  'provider.disable_failed',
  'provider.models_failed',
  'provider.settings_save_failed',
  'rectify.apply_failed',
  'rectify.missing_timezone',
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

/*
 * Test-build cause line. `safeError` drops the raw cause, so a red CI run only
 * shows `[almamesh:error:app.typed_error]`. Behind a VITE_EXIT_GATE_HOOKS
 * guard, `safeCauseWarn` adds ONE line naming each error in the cause chain by
 * class, its `code`, and the SQLite result-code name if the message carries
 * one. Message text is never printed (it can hold names, dates and places).
 * The guard folds away in production builds, so this is tree-shaken out; the
 * frontend gate proves it (apps/web/scripts/verify-boot-fault-hook.mjs).
 */

export const TYPED_ERROR_CAUSE_MARKER = 'almamesh:diag:typed_error_cause';

const MAX_DEPTH = 8;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
const SQLITE_CODE = /\bSQLITE_[A-Z]+(?:_[A-Z]+)*\b/;

function className(error: Error): string {
  if (IDENTIFIER.test(error.name)) return error.name;
  const ctor = error.constructor?.name ?? '';
  return IDENTIFIER.test(ctor) ? ctor : 'Error';
}

function codeOf(error: Error): string | null {
  const code: unknown = (error as { code?: unknown }).code;
  if (typeof code === 'number' && Number.isFinite(code)) return String(code);
  return typeof code === 'string' && CODE.test(code) ? code : null;
}

function describeOne(error: unknown): string {
  if (!(error instanceof Error)) return error === null ? 'null' : typeof error;
  const fields: string[] = [];
  const code = codeOf(error);
  if (code !== null) fields.push(`code=${code}`);
  const sqlite = SQLITE_CODE.exec(error.message)?.[0];
  if (sqlite !== undefined) fields.push(`sqlite=${sqlite}`);
  const name = className(error);
  return fields.length === 0 ? name : `${name}(${fields.join(', ')})`;
}

/** "Outer <- Cause(code=x) <- ..." for `error` and its `.cause` chain. */
export function describeErrorCauses(error: unknown): string {
  if (error === undefined) return 'none';
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && !seen.has(current) && parts.length < MAX_DEPTH) {
    seen.add(current);
    parts.push(describeOne(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(' <- ');
}

/** One console line; call only behind the VITE_EXIT_GATE_HOOKS guard. */
export function safeCauseWarn(cause: unknown): void {
  console.warn(`[${TYPED_ERROR_CAUSE_MARKER}] ${describeErrorCauses(cause)}`);
}
