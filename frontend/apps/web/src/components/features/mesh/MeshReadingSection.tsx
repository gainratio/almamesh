/**
 * MeshReadingSection — the optional AI voice over an engine-computed edge:
 * three streamed sections (connection / timing together / care).
 *
 * With no saved reading and no model configured it shows an honest CTA into AI
 * settings (never a spinner pretending). A completed durable reading remains
 * readable even if the provider is later disconnected. With a model,
 * generation is an explicit action with live elapsed time and a per-section
 * checklist; finished sections render through the global dual-voice mode.
 */

import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { describeLlmStatus, type MeshReadingSectionKey } from '@almamesh/llm';
import type { MeshEdgeCtx, TitledPersona } from '@almamesh/shared-types';

import { Badge, Button, Card, Spinner } from '../../ui';
import { DualModeContent } from '../../ui/DualModeContent';
import { useElapsedSeconds, formatElapsed } from '../../../hooks/useElapsedSeconds';
import {
  useMeshReading,
  type MeshReadingContext,
} from '../../../hooks/useMeshReading';

export interface MeshReadingSectionProps {
  readonly edge: MeshEdgeCtx;
  readonly readingContext: MeshReadingContext;
  /** Open the edge-grounded chat panel ("discuss in chat"). */
  readonly onDiscuss: () => void;
}

const SECTION_ORDER: readonly MeshReadingSectionKey[] = [
  'connection',
  'timing_together',
  'care',
];

function ReadingBlock({
  sectionKey,
  persona,
}: {
  sectionKey: MeshReadingSectionKey;
  persona: TitledPersona;
}): ReactElement {
  const { t } = useTranslation('mesh');
  return (
    <section className="space-y-1.5" data-testid={`mesh-reading-${sectionKey}`}>
      <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-text-tertiary">
        {t(`reading.sections.${sectionKey}`)}
      </p>
      {persona.title && (
        <h3 className="font-display text-base text-text-primary">{persona.title}</h3>
      )}
      <DualModeContent layman={persona.layman} technical={persona.technical} />
    </section>
  );
}

/** Honest no-model state: the engine facts above stand on their own. */
function ConnectModelCta(): ReactElement {
  const { t } = useTranslation('mesh');
  return (
    <div className="space-y-3" data-testid="mesh-reading-cta">
      <p className="font-medium text-text-primary">{t('reading.cta_title')}</p>
      <p className="max-w-prose text-sm leading-relaxed text-text-secondary">
        {t('reading.cta_body')}
      </p>
      <Link
        to="/settings/ai"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-accent-gold transition-colors hover:text-accent-gold-bright"
      >
        {t('reading.cta_link')}
      </Link>
    </div>
  );
}

export function MeshReadingSection({
  edge,
  readingContext,
  onDiscuss,
}: MeshReadingSectionProps): ReactElement {
  const { t } = useTranslation('mesh');
  const aiConfigured = describeLlmStatus().configured;
  const { status, reading, error, completed, generate } = useMeshReading(edge, readingContext);
  const elapsed = useElapsedSeconds(status === 'streaming');

  let body: ReactElement;
  if (status === 'complete' && reading) {
    body = (
      <div className="space-y-6">
        {SECTION_ORDER.map((section) => (
          <ReadingBlock key={section} sectionKey={section} persona={reading[section]} />
        ))}
        {aiConfigured && (
          <div className="flex flex-wrap items-center gap-3 border-t border-ui-border/60 pt-4">
            <Button variant="ghost" size="sm" onClick={generate} data-testid="mesh-reading-regenerate">
              {t('reading.regenerate')}
            </Button>
          </div>
        )}
      </div>
    );
  } else if (!aiConfigured) {
    body = <ConnectModelCta />;
  } else if (status === 'streaming') {
    body = (
      <div className="space-y-4" data-testid="mesh-reading-progress">
        <p className="flex items-start gap-3 text-sm leading-relaxed text-text-secondary">
          <Spinner size="sm" className="mt-0.5 shrink-0" />
          <span>{t('reading.generating', { elapsed: formatElapsed(elapsed) })}</span>
        </p>
        <ul className="max-w-sm space-y-1 text-sm text-text-secondary">
          {SECTION_ORDER.map((section) => (
            <li key={section} className="flex items-center justify-between">
              <span>{t(`reading.sections.${section}`)}</span>
              <span className={completed.has(section) ? 'text-status-success' : 'text-text-tertiary'}>
                {completed.has(section) ? '✓' : '…'}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  } else if (status === 'error') {
    body = (
      <div className="space-y-3" data-testid="mesh-reading-error">
        {reading && (
          <div className="space-y-6 pb-3">
            {SECTION_ORDER.map((section) => (
              <ReadingBlock key={section} sectionKey={section} persona={reading[section]} />
            ))}
          </div>
        )}
        <p className="text-sm text-status-error">
          {t('reading.failed', { message: error ?? '' })}
        </p>
        <Button onClick={generate} data-testid="mesh-reading-retry">
          {t('reading.retry')}
        </Button>
      </div>
    );
  } else {
    body = (
      <div className="space-y-3">
        <p className="max-w-prose text-sm leading-relaxed text-text-secondary">
          {t('reading.cta_body')}
        </p>
        <Button onClick={generate} data-testid="mesh-reading-generate">
          {t('reading.generate')}
        </Button>
      </div>
    );
  }

  return (
    <Card
      title={t('reading.heading')}
      actions={
        <div className="flex items-center gap-3">
          <Badge>{t('reading.badge')}</Badge>
          {aiConfigured && (
            <button
              type="button"
              onClick={onDiscuss}
              className="text-sm font-medium text-accent-gold transition-colors hover:text-accent-gold-bright"
              data-testid="mesh-discuss-chat"
            >
              {t('edge.discuss')}
            </button>
          )}
        </div>
      }
      data-testid="mesh-reading"
    >
      {body}
    </Card>
  );
}
