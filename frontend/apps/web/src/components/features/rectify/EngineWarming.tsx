/**
 * EngineWarming — the honest, RECOVERABLE "engine not ready" surface for the
 * rectification wizard's fit step.
 *
 * The in-browser engine (sync the signed bundle into OPFS + boot Pyodide) can
 * take a minute or two on a cold first boot, so this mirrors the dashboard's
 * Life-Atlas pattern: a live elapsed timer + plain-language reassurance, never
 * a bare "warming up" line that looks permanently broken.
 *
 * Two recovery cues honour the engine-recovery invariant (no permanent
 * dead-end):
 *  - `engineError` non-null → the boot actually FAILED; show the failure + a
 *    reset-and-reload button.
 *  - `timedOut` → warming has dragged past a generous threshold; show a stalled
 *    message + the same reset-and-reload button.
 *
 * Both paths call `onRetry`, which reboots the engine and re-runs.
 *
 * A boot ERROR additionally offers "clear the downloaded engine & reload"
 * (`clearEngineBundleCache`): a reboot re-reads the same OPFS cache, so a
 * fail-closed refusal against the durable anti-rollback floor (a
 * `RollbackError`) can only be recovered by discarding that cache. It clears
 * ONLY the signed-bundle cache (user data is kept) and is an explicit click —
 * never automatic, which would defeat rollback protection. For a rollback
 * refusal (`engineErrorCode === 'rollback'`) it is further guarded by a
 * tampering warning + a two-step confirm (`RollbackResetGuard`).
 */

import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Spinner } from '../../ui';
import { useElapsedSeconds, formatElapsed } from '../../../hooks/useElapsedSeconds';
import { resetEverything } from '../../../lib/resetEverything';
import { clearEngineBundleCache } from '../../../lib/resetAppData';
import { ROLLBACK_CODE } from '../../../lib/engineLifecycle';
import { RollbackResetGuard } from '../../RollbackResetGuard';

export interface EngineWarmingProps {
  /** Engine boot failure message, or null while still warming. */
  readonly engineError: string | null;
  /** The engine failure's stable `EngineOperationError.code`, or null. */
  readonly engineErrorCode: string | null;
  /** True once warming has exceeded the generous timeout without booting. */
  readonly timedOut: boolean;
  /** Current bootstrap stage kind (e.g. 'syncing'), for an honest sub-label. */
  readonly engineStage: string | null;
  /** Reset-and-reload the engine, then re-run the rectification. */
  readonly onRetry: () => void;
}

/** Map a bootstrap stage kind to its localized sub-label key, or null. */
function stageLabelKey(stage: string | null): string | null {
  switch (stage) {
    case 'syncing':
      return 'status.stage_syncing';
    case 'reassembling':
      return 'status.stage_reassembling';
    case 'booting-engine':
      return 'status.stage_booting';
    default:
      return null;
  }
}

export function EngineWarming({
  engineError,
  engineErrorCode,
  timedOut,
  engineStage,
  onRetry,
}: EngineWarmingProps): ReactElement {
  const { t } = useTranslation('rectify');
  const needsRecovery = engineError !== null || timedOut;
  // Honest live timer — only running while we are genuinely still warming.
  const elapsed = useElapsedSeconds(!needsRecovery);

  // Secondary escape hatch: a user whose engine is permanently wedged can wipe
  // their data and re-enter onboarding (the engine bundle in OPFS is preserved,
  // so the reload is fast). Two-step inline confirm — visually secondary.
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [clearingCache, setClearingCache] = useState(false);
  const handleClearEngineCache = async (): Promise<void> => {
    setClearingCache(true);
    await clearEngineBundleCache();
    window.location.reload();
  };
  const handleStartOver = async (): Promise<void> => {
    setResetting(true);
    await resetEverything();
    // Hard navigation to the landing splash: the most reliable escape from a
    // wedged boot; `resetEverything` cleared the canonical chart row, so it re-onboards.
    window.location.assign('/');
  };

  if (needsRecovery) {
    const title = engineError !== null ? t('error.engine_failed_title') : t('status.stalled_title');
    const body = engineError !== null ? t('error.engine_failed_body') : t('status.stalled_body');
    return (
      <div data-testid="engine-recovery" className="flex flex-col gap-3">
        <p className="text-sm font-medium text-status-error">{title}</p>
        <p className="text-sm leading-relaxed text-text-secondary">{body}</p>
        {engineError !== null && (
          <p
            data-testid="engine-error-detail"
            className="break-words text-xs text-text-tertiary"
          >
            {engineError}
          </p>
        )}
        <Button
          variant="secondary"
          size="sm"
          data-testid="engine-reset-btn"
          onClick={onRetry}
          className="w-fit"
        >
          {t('status.reset_reload')}
        </Button>
        {engineError !== null && (
          <RollbackResetGuard
            rollback={engineErrorCode === ROLLBACK_CODE}
            onReset={() => void handleClearEngineCache()}
            renderTrigger={(onClick) => (
              <Button
                variant="secondary"
                size="sm"
                data-testid="engine-clear-cache-btn"
                onClick={onClick}
                disabled={clearingCache}
                className="w-fit"
              >
                {t('status.clear_engine_cache')}
              </Button>
            )}
          />
        )}
        {!confirmingReset ? (
          <button
            type="button"
            data-testid="rectify-start-over"
            onClick={() => setConfirmingReset(true)}
            className="w-fit text-xs text-text-tertiary underline-offset-2 hover:text-text-secondary hover:underline"
          >
            {t('reset.start_over')}
          </button>
        ) : (
          <div className="flex flex-col gap-2 rounded-md border border-status-error/30 bg-status-error/5 p-3">
            <p className="text-xs leading-relaxed text-text-secondary">{t('reset.warning')}</p>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setConfirmingReset(false)}
                disabled={resetting}
                className="w-fit"
              >
                {t('reset.cancel')}
              </Button>
              <button
                type="button"
                data-testid="rectify-start-over-confirm"
                onClick={() => void handleStartOver()}
                disabled={resetting}
                className="w-fit rounded-md border border-status-error/50 px-3 text-xs font-medium text-status-error hover:bg-status-error/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t('reset.confirm')}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  const stageKey = stageLabelKey(engineStage);
  return (
    <div data-testid="engine-warming" className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <Spinner size="sm" className="mt-0.5 shrink-0" />
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-text-primary">{t('status.warming_title')}</p>
          <p className="text-sm leading-relaxed text-text-secondary">
            {t('status.warming_body', { elapsed: formatElapsed(elapsed) })}
          </p>
          {stageKey !== null && (
            <p data-testid="engine-stage" className="text-xs text-text-tertiary">
              {t(stageKey)}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
