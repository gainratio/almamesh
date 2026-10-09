/**
 * PredictiveStatusCard — the honest non-ready states of the lazy predictive
 * layer. Renders `null` once contexts are ready (the caller then renders the
 * real panels). The loading state shows live elapsed time and says WHAT is
 * being computed and WHERE (on-device) — never a bare spinner.
 */

import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Card, Spinner } from '../../ui';
import { useElapsedSeconds, formatElapsed } from '../../../hooks/useElapsedSeconds';
import type { PredictiveLayer } from '../../../hooks/usePredictiveLayer';
import { BirthZoneMissingCard } from './BirthZoneMissingCard';

interface PredictiveStatusCardProps {
  readonly layer: PredictiveLayer;
  /**
   * Auto mode (the Sky & Timing panel): computation starts by itself, so the
   * idle state shows the engine-warming note instead of a "Compute" button.
   */
  readonly auto?: boolean;
}

export function PredictiveStatusCard({
  layer,
  auto = false,
}: PredictiveStatusCardProps): ReactElement | null {
  const { t } = useTranslation('predictive');
  const elapsed = useElapsedSeconds(layer.status === 'loading');

  if (layer.status === 'ready') {
    return null;
  }

  if (layer.status === 'loading') {
    return (
      <Card title={t('gate.computing_title')} data-testid="predictive-loading">
        <div className="flex items-start gap-3">
          <Spinner size="sm" className="mt-0.5 shrink-0" />
          <p className="text-sm leading-relaxed text-text-secondary">
            {t('gate.computing_body', { elapsed: formatElapsed(elapsed) })}
          </p>
        </div>
      </Card>
    );
  }

  if (layer.status === 'error') {
    return (
      <Card title={t('gate.error_title')} data-testid="predictive-error">
        {layer.error && <p className="mb-4 text-sm text-status-error">{layer.error}</p>}
        <Button onClick={layer.compute} disabled={!layer.canCompute} data-testid="predictive-retry">
          {t('gate.retry')}
        </Button>
      </Card>
    );
  }

  // idle
  if (layer.birthZoneMissing) {
    return <BirthZoneMissingCard />;
  }
  if (!layer.hasBirthData) {
    return (
      <Card title={t('gate.title')} data-testid="predictive-no-chart">
        <p className="text-sm leading-relaxed text-text-secondary">{t('gate.no_chart')}</p>
      </Card>
    );
  }

  return (
    <Card title={t('gate.title')} data-testid="predictive-gate">
      <p className="mb-4 max-w-prose text-sm leading-relaxed text-text-secondary">
        {t('gate.body')}
      </p>
      {layer.engineReady && !auto && (
        <Button onClick={layer.compute} data-testid="predictive-compute">
          {t('gate.compute')}
        </Button>
      )}
      {!layer.engineReady && (
        <p className="flex items-center gap-2 text-sm text-text-tertiary" data-testid="predictive-engine-warming">
          <Spinner size="sm" />
          {t('gate.engine_warming')}
        </p>
      )}
    </Card>
  );
}
