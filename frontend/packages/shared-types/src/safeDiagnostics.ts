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

/**
 * Class names that may be printed: the JS/DOM built-ins and every error class
 * AlmaMesh and @gainratio/browser declare (apps/web typedErrorCause.test.ts
 * fails when a new one is missing). Anything else prints as `Error`, because a
 * `name` can be set to user text.
 */
export const KNOWN_ERROR_CLASSES: ReadonlySet<string> = new Set([
  // ECMAScript
  'Error', 'AggregateError', 'EvalError', 'RangeError', 'ReferenceError', 'SuppressedError', 'SyntaxError',
  'TypeError', 'URIError',
  // WebAssembly (a trap relayed from the chart Worker arrives as RuntimeError)
  'CompileError', 'LinkError', 'RuntimeError', 'SuspendError',
  // Pyodide
  'FatalPyodideError', 'NoGilError', 'PythonError',
  // DOMException and the names browsers give it
  'DOMException', 'AbortError', 'DataCloneError', 'InvalidStateError', 'NetworkError', 'NoModificationAllowedError',
  'NotAllowedError', 'NotFoundError', 'NotReadableError', 'NotSupportedError', 'QuotaExceededError', 'SecurityError',
  'TimeoutError', 'TypeMismatchError', 'UnknownError',
  // AlmaMesh (apps/web, packages/browser, llm, memory, store)
  'BackupCryptoError', 'BackupError', 'ChartComputeError', 'ChartSaveError', 'ChartSnapshotError',
  'ChatSummaryGenerationError', 'EngineBootCancelledError', 'EngineBootstrapError', 'EngineCacheNotDurableError',
  'EngineNotReadyError', 'EngineStorageBlockedError', 'EngineWarmingError', 'InterpretationSetAsideError',
  'JsonBoundsError', 'LlmRequestError', 'LocalTimeError', 'PeriodSkyTimeoutError', 'PeriodSkyUnavailableError',
  'PortableImportRevisionConflictError', 'PortableStateStartupError', 'PortableStateTooNewError',
  'PortableStateUnavailableError', 'PortableStorageUnavailableError', 'PrivacyViolationError',
  'PyodidePackageLoadError', 'ReasoningTimeoutError', 'ResetIncompleteError', 'SemanticMemoryStorageUnavailableError',
  'SetAsideRestoreError', 'StoreSaveError',
  // @gainratio/browser (and the sqlite-wasm build it ships)
  'CacheFallbackRefusedError', 'EngineOperationError', 'EngineStorageUnavailableError', 'GetSyncHandleError',
  'IntegrityError', 'KeyRevokedError', 'KeyringError', 'LegacyFloorUnavailableError', 'PointerExpiredError',
  'ResponseTooLargeError', 'RollbackError', 'SQLite3Error', 'SignatureError', 'SqlImportRejectedError',
  'SqlStorageUnavailableError', 'SqlTransactionEndedError', 'SqliteStateConflictError', 'SqliteStateSchemaError',
  'StorageQuotaError', 'SyncCapError', 'UnknownKeyError', 'WasmAllocError', 'WorkerCrashError', 'WorkerTimeoutError',
]);

/**
 * `code` values that may be printed: fixed constants only. A code from
 * anywhere else (a provider's JSON body, a numeric HTTP code) prints as `?`.
 */
export const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set([
  // @gainratio/browser EngineErrorCode
  'integrity', 'rollback', 'network', 'lock', 'storage', 'internal',
  // @almamesh/llm
  'ai.reasoning_timeout', 'invalid_plan', 'malformed_json', 'invalid_shape', 'invalid_citation',
  // @almamesh/memory
  'memory.opfs_unavailable',
  // @almamesh/store: BackupCryptoErrorCode, BackupError, SetAsideRestoreErrorCode
  'bad_passphrase', 'unsupported', 'too_costly', 'out_of_memory', 'unavailable',
  'bad_format', 'too_new', 'corrupt',
  'missing', 'unreadable', 'unknown_person', 'has_record', 'not_saved',
]);

/** SQLite's primary result-code names (sqlite3.h); extended codes reduce to these. */
export const SQLITE_PRIMARY_CODES: ReadonlySet<string> = new Set([
  'SQLITE_OK', 'SQLITE_ERROR', 'SQLITE_INTERNAL', 'SQLITE_PERM', 'SQLITE_ABORT', 'SQLITE_BUSY', 'SQLITE_LOCKED',
  'SQLITE_NOMEM', 'SQLITE_READONLY', 'SQLITE_INTERRUPT', 'SQLITE_IOERR', 'SQLITE_CORRUPT', 'SQLITE_NOTFOUND',
  'SQLITE_FULL', 'SQLITE_CANTOPEN', 'SQLITE_PROTOCOL', 'SQLITE_EMPTY', 'SQLITE_SCHEMA', 'SQLITE_TOOBIG',
  'SQLITE_CONSTRAINT', 'SQLITE_MISMATCH', 'SQLITE_MISUSE', 'SQLITE_NOLFS', 'SQLITE_AUTH', 'SQLITE_FORMAT',
  'SQLITE_RANGE', 'SQLITE_NOTADB', 'SQLITE_NOTICE', 'SQLITE_WARNING', 'SQLITE_ROW', 'SQLITE_DONE',
]);

const SQLITE_TOKEN = /\bSQLITE_[A-Z]+(?:_[A-Z]+)*\b/;

/** What a property read that threw is printed as. */
const UNREADABLE = '?';

/** `read()`, or `fallback` when it throws (a hostile Proxy, a throwing getter). */
function attempt<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function className(error: Error): string {
  const name = attempt<unknown>(() => error.name, UNREADABLE);
  if (name === UNREADABLE) return UNREADABLE;
  if (typeof name === 'string' && KNOWN_ERROR_CLASSES.has(name)) return name;
  const ctor = attempt<unknown>(() => error.constructor?.name, undefined);
  return typeof ctor === 'string' && KNOWN_ERROR_CLASSES.has(ctor) ? ctor : 'Error';
}

/** null: no `code` at all. '?': a code that is not a fixed constant, or unreadable. */
function codeOf(error: Error): string | null {
  return attempt<string | null>(() => {
    if (!('code' in error) || error.code === undefined) return null;
    return typeof error.code === 'string' && KNOWN_ERROR_CODES.has(error.code) ? error.code : UNREADABLE;
  }, UNREADABLE);
}

/** The primary SQLite result-code name in the message; '?' for an unknown SQLITE_ token or an unreadable message. */
function sqliteCodeOf(error: Error): string | null {
  const message = attempt<unknown>(() => error.message, UNREADABLE);
  if (message === UNREADABLE) return UNREADABLE;
  if (typeof message !== 'string') return null;
  const token = SQLITE_TOKEN.exec(message)?.[0];
  if (token === undefined) return null;
  for (const primary of SQLITE_PRIMARY_CODES) {
    if (token === primary || token.startsWith(`${primary}_`)) return primary;
  }
  return UNREADABLE;
}

function describeOne(error: unknown): string {
  const isError = attempt<boolean | null>(() => error instanceof Error, null);
  if (isError === null) return UNREADABLE;
  if (!isError) return error === null ? 'null' : typeof error;
  const typed = error as Error;
  const fields: string[] = [];
  const code = codeOf(typed);
  if (code !== null) fields.push(`code=${code}`);
  const sqlite = sqliteCodeOf(typed);
  if (sqlite !== null) fields.push(`sqlite=${sqlite}`);
  const name = className(typed);
  return fields.length === 0 ? name : `${name}(${fields.join(', ')})`;
}

const NO_CAUSE = Symbol('no cause');
const UNREADABLE_CAUSE = Symbol('unreadable cause');

/** The next link. An error whose class cannot be read was already printed as '?' and ends the chain. */
function causeOf(error: unknown): unknown {
  if (!attempt<boolean>(() => error instanceof Error, false)) return NO_CAUSE;
  return attempt<unknown>(() => (error as Error).cause, UNREADABLE_CAUSE);
}

/** "Outer <- Cause(code=x) <- ..." for `error` and its `.cause` chain. Never throws. */
export function describeErrorCauses(error: unknown): string {
  if (error === undefined) return 'none';
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== NO_CAUSE && !seen.has(current) && parts.length < MAX_DEPTH) {
    if (current === UNREADABLE_CAUSE) {
      parts.push(UNREADABLE);
      break;
    }
    seen.add(current);
    parts.push(describeOne(current));
    current = causeOf(current);
  }
  return parts.join(' <- ');
}

/** One console line; call only behind the VITE_EXIT_GATE_HOOKS guard. Never throws. */
export function safeCauseWarn(cause: unknown): void {
  try {
    console.warn(`[${TYPED_ERROR_CAUSE_MARKER}] ${describeErrorCauses(cause)}`);
  } catch {
    // A diagnostic must never stop the caller from showing its error card.
  }
}
