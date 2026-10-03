/**
 * GatheredTray — collapsible sticky tray for the conversational rectification flow.
 *
 * Collapsed: shows the count of structured life events gathered so far with a
 * "review" affordance. The whole bar is a toggle button with `aria-expanded`.
 *
 * Expanded: renders the existing `EventRow` list (same wiring as `EventEntryStep`),
 * an "Add Event" button, an honesty note, and the primary "Find my rising sign" CTA
 * (disabled until ≥1 structured event — same gate as `EventEntryStep`).
 *
 * Sticky positioning (`sticky bottom-0`) keeps the tray anchored to the viewport
 * bottom within the scrolling wizard body.
 */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { useLifeEventsStore, isStructuredLifeEvent } from '@almamesh/store';
import type { LifeEvent } from '@almamesh/store';
import type { LifeEventCategory } from '@almamesh/shared-types';
import { EventRow } from './EventRow';

/** Stable empty array — prevents spurious re-renders when the profile has no events yet. */
const EMPTY_EVENTS: readonly LifeEvent[] = [];

export interface GatheredTrayProps {
  /** Profile whose life events are being reviewed. */
  readonly profileId: string;
  /** Whether the tray is currently expanded to show event rows. */
  readonly expanded: boolean;
  /** Called when the user clicks the collapsed/expanded toggle bar. */
  readonly onToggle: () => void;
  /** Called when the user clicks the "Find my rising sign" CTA (≥1 structured event required). */
  readonly onContinue: () => void;
  /**
   * Optional external gate: when true the "Find my rising sign" CTA is disabled
   * regardless of the internal structured-event count.  Used by the parent (e.g.
   * Task 5) to suppress the CTA while the interview is still streaming.
   * Never enables the CTA — only adds an additional reason to disable it.
   */
  readonly continueDisabled?: boolean;
}

export function GatheredTray({
  profileId,
  expanded,
  onToggle,
  onContinue,
  continueDisabled = false,
}: GatheredTrayProps): ReactElement {
  const { t } = useTranslation('rectify');

  const events = useLifeEventsStore(
    (s) => s.eventsByProfile[profileId] ?? EMPTY_EVENTS,
  );
  const addEvent = useLifeEventsStore((s) => s.addEvent);
  const editEvent = useLifeEventsStore((s) => s.editEvent);
  const removeEvent = useLifeEventsStore((s) => s.removeEvent);

  const gatheredCount = events.filter(isStructuredLifeEvent).length;
  const hasStructured = gatheredCount >= 1;

  const handleAdd = () => {
    addEvent(profileId, { description: 'new' });
  };

  const reviewLabel = t('tray.review', { count: gatheredCount });

  return (
    <div className="sticky bottom-0 border-t border-border-subtle bg-background-elevated shadow-lg">
      {/* Toggle bar — the entire bar is a button for keyboard + pointer accessibility */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={reviewLabel}
        className="flex w-full items-center justify-between px-4 py-3 text-sm text-text-primary hover:bg-surface-secondary focus:outline-hidden focus:ring-1 focus:ring-inset focus:ring-accent-primary"
      >
        <span className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={`inline-block transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
          >
            ▸
          </span>
          <span>{reviewLabel}</span>
        </span>
        <span aria-hidden="true" className="text-xs text-text-tertiary">
          {expanded ? '▲' : '▼'}
        </span>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="flex flex-col gap-4 px-4 pb-5 pt-1">
          {/* Event rows — same mapping as EventEntryStep, each led by a
              prominent, editable "what happened" summary so events with the
              same date + category are distinguishable at a glance. */}
          <div className="flex flex-col gap-4">
            {events.map((event) => (
              <div key={event.id} className="flex flex-col gap-2">
                <div className="flex flex-col gap-1">
                  <label
                    htmlFor={`summary-${event.id}`}
                    className="text-xs font-medium uppercase tracking-wider text-text-tertiary"
                  >
                    {t('summary.label')}
                  </label>
                  <input
                    id={`summary-${event.id}`}
                    type="text"
                    value={event.summary ?? ''}
                    onChange={(e) => editEvent(profileId, event.id, { summary: e.target.value })}
                    aria-label={t('summary.label')}
                    placeholder={t('summary.placeholder')}
                    data-testid="event-summary-input"
                    className="rounded-sm border border-border-subtle bg-surface-primary px-3 py-2 text-sm font-medium text-text-primary placeholder:font-normal placeholder:text-text-tertiary focus:outline-hidden focus:ring-1 focus:ring-accent-primary"
                  />
                </div>
                <EventRow
                  event={event}
                  onDateChange={(date) => editEvent(profileId, event.id, { date })}
                  onCategoryChange={(category: LifeEventCategory | undefined) =>
                    editEvent(profileId, event.id, { category })
                  }
                  onNoteChange={(note) => editEvent(profileId, event.id, { note })}
                  onPrecisionChange={(precision) =>
                    editEvent(profileId, event.id, { precision })
                  }
                  onDelete={() => removeEvent(profileId, event.id)}
                />
              </div>
            ))}
          </div>

          {/* Add event — reuses entry.add key ("Add Event") */}
          <button
            type="button"
            onClick={handleAdd}
            className="w-fit rounded-lg border border-dashed border-border-subtle px-4 py-2 text-sm text-text-secondary hover:border-accent-primary hover:text-accent-primary focus:outline-hidden focus:ring-1 focus:ring-accent-primary"
          >
            {t('entry.add')}
          </button>

          {/* Honesty note */}
          <p className="text-xs text-text-tertiary">{t('tray.honesty')}</p>

          {/* Primary CTA — disabled until ≥1 structured event, or externally gated */}
          <button
            type="button"
            onClick={onContinue}
            disabled={!hasStructured || continueDisabled}
            className="w-fit rounded-lg bg-accent-primary px-6 py-2 text-sm font-medium text-white focus:outline-hidden focus:ring-2 focus:ring-accent-primary focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t('tray.cta')}
          </button>
        </div>
      )}
    </div>
  );
}
