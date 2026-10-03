/**
 * EventRow — one editable life-event row in the rectification wizard.
 *
 * Renders three fields (date, category, optional note) and a delete control.
 * All labels are localized from the `rectify` namespace; category option text
 * uses `rectify:categories.<category>` keys — never raw enum values.
 *
 * This component is purely presentational: state lives in the caller
 * (EventEntryStep → useLifeEventsStore).
 */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { LifeEvent } from '@almamesh/store';
import type { EventDatePrecision, LifeEventCategory } from '@almamesh/shared-types';
import { LIFE_EVENT_CATEGORIES } from '@almamesh/shared-types';

export interface EventRowProps {
  readonly event: LifeEvent;
  readonly onDateChange: (date: string) => void;
  readonly onCategoryChange: (category: LifeEventCategory | undefined) => void;
  readonly onNoteChange: (note: string) => void;
  readonly onPrecisionChange: (precision: EventDatePrecision) => void;
  readonly onDelete: () => void;
}

export function EventRow({
  event,
  onDateChange,
  onCategoryChange,
  onNoteChange,
  onPrecisionChange,
  onDelete,
}: EventRowProps): ReactElement {
  const { t } = useTranslation('rectify');

  const handleCategoryChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    onCategoryChange(val !== '' ? (val as LifeEventCategory) : undefined);
  };

  return (
    <div
      className="grid grid-cols-1 sm:grid-cols-[8rem_minmax(0,1fr)_8rem_minmax(0,1.5fr)_auto] sm:items-end gap-3 rounded-lg border border-border-subtle bg-surface-secondary p-3"
      data-testid="event-row"
    >
      {/* Date */}
      <div className="flex flex-col gap-1">
        <label
          htmlFor={`date-${event.id}`}
          className="text-xs font-medium uppercase tracking-wider text-text-tertiary"
        >
          {t('entry.date_label')}
        </label>
        <input
          id={`date-${event.id}`}
          type="date"
          value={event.date}
          onChange={(e) => onDateChange(e.target.value)}
          aria-label={t('entry.date_label')}
          className="rounded-sm border border-border-subtle bg-surface-primary px-2 py-1 text-sm text-text-primary focus:outline-hidden focus:ring-1 focus:ring-accent-primary"
        />
      </div>

      {/* Category */}
      <div className="flex flex-col gap-1">
        <label
          htmlFor={`category-${event.id}`}
          className="text-xs font-medium uppercase tracking-wider text-text-tertiary"
        >
          {t('entry.category_label')}
        </label>
        <select
          id={`category-${event.id}`}
          value={event.category ?? ''}
          onChange={handleCategoryChange}
          aria-label={t('entry.category_label')}
          className="rounded-sm border border-border-subtle bg-surface-primary px-2 py-1 text-sm text-text-primary focus:outline-hidden focus:ring-1 focus:ring-accent-primary"
        >
          <option value="">{t('entry.category_placeholder')}</option>
          {LIFE_EVENT_CATEGORIES.map((cat) => (
            <option key={cat} value={cat}>
              {t(`categories.${cat}`)}
            </option>
          ))}
        </select>
      </div>

      {/* Precision — fixed-width column, sits between Category and Note */}
      <div className="flex flex-col gap-1">
        <label
          htmlFor={`precision-${event.id}`}
          className="text-xs font-medium uppercase tracking-wider text-text-tertiary"
        >
          {t('entry.precision_label')}
        </label>
        <select
          id={`precision-${event.id}`}
          value={event.precision ?? 'exact'}
          onChange={(e) => onPrecisionChange(e.target.value as EventDatePrecision)}
          aria-label={t('entry.precision_label')}
          className="rounded-sm border border-border-subtle bg-surface-primary px-2 py-1 text-sm text-text-primary focus:outline-hidden focus:ring-1 focus:ring-accent-primary"
        >
          <option value="exact">{t('entry.precision_exact')}</option>
          <option value="month">{t('entry.precision_month')}</option>
          <option value="year">{t('entry.precision_year')}</option>
          <option value="approx">{t('entry.precision_approx')}</option>
        </select>
      </div>

      {/* Note — flexible column, takes remaining width */}
      <div className="flex flex-col gap-1">
        <label
          htmlFor={`note-${event.id}`}
          className="text-xs font-medium uppercase tracking-wider text-text-tertiary"
        >
          {t('entry.note_label')}
        </label>
        <input
          id={`note-${event.id}`}
          type="text"
          value={event.note ?? ''}
          onChange={(e) => onNoteChange(e.target.value)}
          aria-label={t('entry.note_label')}
          placeholder={t('entry.note_label')}
          className="rounded-sm border border-border-subtle bg-surface-primary px-2 py-1 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-hidden focus:ring-1 focus:ring-accent-primary"
        />
      </div>

      {/* Delete — auto-width, bottom-aligned via sm:items-end on the grid */}
      <div className="flex items-end">
        <button
          type="button"
          onClick={onDelete}
          aria-label={t('entry.delete')}
          className="rounded-sm px-2 py-1 text-xs text-status-error hover:bg-status-error/10 focus:outline-hidden focus:ring-1 focus:ring-status-error"
        >
          {t('entry.delete')}
        </button>
      </div>
    </div>
  );
}
