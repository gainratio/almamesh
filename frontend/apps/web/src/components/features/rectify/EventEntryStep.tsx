/**
 * EventEntryStep — slice 1 of the rectification wizard: structured event entry.
 *
 * Hybrid UX:
 *  - Primary path: <ConversationalAccelerator> — a calm, one-event-at-a-time
 *    interview that flushes extracted events into the life-events store as
 *    reviewable draft rows.
 *  - Manual fallback: "Enter events manually instead" toggle that opens the
 *    <GatheredTray> sticky tray, revealing editable EventRow controls and the
 *    "Find my rising sign" CTA. No-LLM users are never in a dead-end — the
 *    tray gives them full access to manual event entry.
 *  - <GatheredTray> also shows the gathered count and the CTA for LLM users
 *    (collapsed by default; togglable via its own bar or the manual toggle).
 *
 * `onContinue` semantics are unchanged — it triggers the fit (slice 2).
 */
import type { ReactElement } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConversationalAccelerator } from './ConversationalAccelerator';
import { GatheredTray } from './GatheredTray';

export interface EventEntryStepProps {
  /** The profile whose life events are being edited. */
  readonly profileId: string;
  /** Called when the user clicks "Find my rising sign" (≥1 structured event required). */
  readonly onContinue: () => void;
}

export function EventEntryStep({ profileId, onContinue }: EventEntryStepProps): ReactElement {
  const { t } = useTranslation('rectify');
  const [trayExpanded, setTrayExpanded] = useState(false);

  return (
    <div className="flex flex-col gap-6 pb-24">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold text-text-primary">{t('entry.title')}</h2>
        <p className="mt-1 text-sm text-text-secondary">{t('entry.subtitle')}</p>
      </div>

      {/* Primary path: conversational interview */}
      <ConversationalAccelerator profileId={profileId} />

      {/* Manual fallback — quiet affordance to open the editable tray directly.
          Ensures users without a cloud endpoint are never stuck. */}
      <button
        type="button"
        onClick={() => setTrayExpanded(true)}
        className="w-fit text-xs text-text-tertiary underline hover:text-text-secondary focus:outline-hidden focus:ring-1 focus:ring-accent-primary"
      >
        {t('entry.manual_toggle')}
      </button>

      {/* Gathered tray — sticky at bottom, collapsed by default.
          Expands to show reviewable EventRows + Add button + CTA. */}
      <GatheredTray
        profileId={profileId}
        expanded={trayExpanded}
        onToggle={() => setTrayExpanded((v) => !v)}
        onContinue={onContinue}
      />
    </div>
  );
}
