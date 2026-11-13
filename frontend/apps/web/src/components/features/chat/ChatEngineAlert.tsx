import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

import { isEngineHeldByAnotherTab } from '../../EngineOtherTabNotice';
import { RollbackResetGuard } from '../../RollbackResetGuard';
import { engineErrorCode, ROLLBACK_CODE } from '../../../lib/engineLifecycle';
import { clearEngineBundleCache } from '../../../lib/resetAppData';
import { useOptionalChartEngine } from '../../../providers/chartEngineContext';

export interface ChatEngineAlertProps {
  readonly onReload?: () => void;
}

interface CacheResetButtonProps {
  readonly error: Error;
  readonly clearing: boolean;
  readonly label: string;
  readonly onReset: () => void;
}

function CacheResetButton({ error, clearing, label, onReset }: CacheResetButtonProps): ReactElement {
  return (
    <RollbackResetGuard
      rollback={engineErrorCode(error) === ROLLBACK_CODE}
      onReset={onReset}
      renderTrigger={(onClick) => (
        <button type="button" data-testid="chat-clear-engine-cache" disabled={clearing} onClick={onClick}
          className="min-h-6 min-w-6 [@media(pointer:coarse)]:min-h-9 rounded-md border border-ui-border px-2.5 py-1 text-xs text-text-secondary hover:bg-background-tertiary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-gold disabled:opacity-50">
          {label}
        </button>
      )}
    />
  );
}

export function ChatEngineAlert({ onReload }: ChatEngineAlertProps = {}): ReactElement | null {
  const { t } = useTranslation('chat');
  const engineCtx = useOptionalChartEngine();
  const [clearing, setClearing] = useState(false);
  const error = engineCtx?.error ?? null;
  if (!error) return null;

  const otherTab = isEngineHeldByAnotherTab(error);
  const handleClear = async () => {
    setClearing(true);
    await clearEngineBundleCache();
    (onReload ?? (() => window.location.reload()))();
  };

  return (
    <div role="alert" data-testid="chat-engine-error"
      className="mx-4 mt-3 flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-xs text-text-secondary">
      <p className="whitespace-normal break-words text-text-primary">{otherTab ? t('tools.reasons.other_tab') : t('tools.engine_error_banner')}</p>
      {!otherTab && error.message && (
        <p className="whitespace-normal break-words text-[11px] text-text-muted" data-testid="chat-engine-error-detail">{error.message}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" data-testid="chat-engine-retry" onClick={() => void engineCtx?.reboot().catch(() => undefined)}
          className="min-h-6 min-w-6 [@media(pointer:coarse)]:min-h-9 rounded-md border border-accent-gold/60 px-2.5 py-1 text-xs font-medium text-accent-gold hover:bg-accent-gold/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-gold">
          {t('tools.retry_engine')}
        </button>
        {!otherTab && <CacheResetButton error={error} clearing={clearing} label={t('tools.clear_engine_cache')} onReset={() => void handleClear()} />}
      </div>
    </div>
  );
}
