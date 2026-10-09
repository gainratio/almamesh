/**
 * The Time travel sheet (spec Part 3). When? is Day / Month / Year (Month,
 * current month, by default). Where? shows on Day only, starts empty, and is
 * required. Go waits for the pin to be saved (plan Ruling 12).
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { devicePolicy } from '@almamesh/browser';
import { endsBeforeBirthYear } from '@almamesh/llm';
import type { ChatThreadAsOf } from '@almamesh/shared-types';

import type { PlaceLookup } from '../../../lib/geo/placeLookup';
import { asOfFromDraft, rangeOfDraft, sheetDefaults, sheetYears, type PinGranularity, type SheetDraft } from '../../../lib/timeTravelSheet';
import { PlacePicker, lookupPlaceLazily } from './PlacePicker';

interface TimeTravelSheetProps {
  readonly open: boolean;
  readonly current?: ChatThreadAsOf;
  readonly birthYear?: number;
  readonly today: string;
  /** Test seam. Default: this device's `devicePolicy().periodSkyComputeAllowed` (plan Ruling 5). */
  readonly dayAllowed?: boolean;
  /** Test seam. Default: the offline city list, loaded on first use. */
  readonly lookupPlace?: (query: string) => Promise<PlaceLookup>;
  readonly onGo: (asOf: ChatThreadAsOf) => Promise<void>;
  readonly onClose: () => void;
}

const FOCUSABLE = 'button:not([disabled]), input, select, [href], [tabindex]:not([tabindex="-1"])';

/** Keep Tab / Shift+Tab inside the open sheet (aria-modal does not do this by itself). */
function trapFocus(event: KeyboardEvent<HTMLDivElement>, root: HTMLElement | null): void {
  const items = Array.from(root?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
  const first = items[0];
  const last = items.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function moveTab(event: KeyboardEvent<HTMLElement>, tabs: readonly PinGranularity[], current: PinGranularity, select: (next: PinGranularity) => void): void {
  const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
  if (step === 0) return;
  event.preventDefault();
  const next = tabs[(tabs.indexOf(current) + step + tabs.length) % tabs.length];
  select(next);
  queueMicrotask(() => document.querySelector<HTMLElement>(`[data-testid="time-travel-tab-${next}"]`)?.focus());
}

const MONTHS = Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, '0'));

export function TimeTravelSheet(props: TimeTravelSheetProps) {
  const { t, i18n } = useTranslation('chat');
  const dayAllowed = props.dayAllowed ?? devicePolicy().periodSkyComputeAllowed;
  const [draft, setDraft] = useState<SheetDraft>(() => sheetDefaults(props.today, props.current, dayAllowed));
  const [saveFailed, setSaveFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const { open, today, current } = props;
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) setDraft(sheetDefaults(today, current, dayAllowed));
  }, [open, today, current, dayAllowed]);
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    return () => opener?.focus();
  }, [open]);
  if (!props.open) return null;

  const asOf = asOfFromDraft(draft);
  const range = rangeOfDraft(draft);
  const beforeBirth = range !== undefined && endsBeforeBirthYear(range, props.birthYear);
  const tabs: readonly PinGranularity[] = dayAllowed ? ['day', 'month', 'year'] : ['month', 'year'];
  const years = sheetYears(props.birthYear);
  const monthName = (month: string) =>
    new Intl.DateTimeFormat(i18n.language, { month: 'long', timeZone: 'UTC' }).format(new Date(`2000-${month}-15T12:00:00Z`));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') props.onClose();
    if (event.key === 'Tab') trapFocus(event, dialogRef.current);
  };

  const submit = async () => {
    if (!asOf || beforeBirth || saving) return;
    setSaving(true);
    setSaveFailed(false);
    try {
      await props.onGo(asOf);
      props.onClose();
    } catch {
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="time-travel-sheet-title" data-testid="time-travel-sheet"
      className="absolute inset-x-0 bottom-0 z-20 max-h-full overflow-y-auto rounded-t-2xl border border-ui-border bg-background-secondary p-4 shadow-xl"
      onKeyDown={onKeyDown}>
      <h4 id="time-travel-sheet-title" className="font-semibold text-text-primary">⏳ {t('time_travel.sheet.title')}</h4>
      <p className="text-xs text-text-muted">{t('time_travel.sheet.intro')}</p>
      <p className="mt-3 text-sm font-medium text-text-primary">{t('time_travel.sheet.when')}</p>
      <div role="tablist" aria-label={t('time_travel.sheet.when')} className="mt-1 flex gap-2">
        {tabs.map((tab) => (
          <button key={tab} type="button" role="tab" aria-selected={draft.granularity === tab} tabIndex={draft.granularity === tab ? 0 : -1}
            onKeyDown={(event) => moveTab(event, tabs, draft.granularity, (next) => setDraft({ ...draft, granularity: next }))} data-testid={`time-travel-tab-${tab}`}
            onClick={() => setDraft({ ...draft, granularity: tab })}
            className={`rounded-full border px-3 py-1 text-xs ${draft.granularity === tab ? 'border-accent-gold text-accent-gold' : 'border-ui-border text-text-secondary'}`}>
            {t(`time_travel.sheet.tabs.${tab}`)}
          </button>
        ))}
      </div>
      {draft.granularity === 'day' && (
        <>
          <input type="date" aria-label={t('time_travel.sheet.day_label')} data-testid="time-travel-day" value={draft.day}
            min={`${years[0]}-01-01`} max={`${years.at(-1)}-12-31`}
            onChange={(event) => setDraft({ ...draft, day: event.target.value })}
            className="mt-2 rounded-lg border border-ui-border bg-background-primary px-3 py-2 text-sm text-text-primary" />
          <PlacePicker place={draft.place} lookup={props.lookupPlace ?? lookupPlaceLazily}
            onPick={(place) => setDraft({ ...draft, place })} />
        </>
      )}
      {draft.granularity === 'month' && (
        <div className="mt-2 flex gap-2">
          <select aria-label={t('time_travel.sheet.month_label')} data-testid="time-travel-month" value={draft.month.slice(5, 7)}
            onChange={(event) => setDraft({ ...draft, month: `${draft.month.slice(0, 4)}-${event.target.value}` })}
            className="rounded-lg border border-ui-border bg-background-primary px-3 py-2 text-sm text-text-primary">
            {MONTHS.map((month) => <option key={month} value={month}>{monthName(month)}</option>)}
          </select>
          <select aria-label={t('time_travel.sheet.year_label')} data-testid="time-travel-month-year" value={draft.month.slice(0, 4)}
            onChange={(event) => setDraft({ ...draft, month: `${event.target.value}-${draft.month.slice(5, 7)}` })}
            className="rounded-lg border border-ui-border bg-background-primary px-3 py-2 text-sm text-text-primary">
            {years.map((year) => <option key={year} value={year}>{year}</option>)}
          </select>
        </div>
      )}
      {draft.granularity === 'year' && (
        <select aria-label={t('time_travel.sheet.year_label')} data-testid="time-travel-year" value={draft.year}
          onChange={(event) => setDraft({ ...draft, year: Number(event.target.value) })}
          className="mt-2 rounded-lg border border-ui-border bg-background-primary px-3 py-2 text-sm text-text-primary">
          {years.map((year) => <option key={year} value={year}>{year}</option>)}
        </select>
      )}
      {beforeBirth && <p data-testid="time-travel-before-birth" role="alert" className="mt-2 text-xs text-status-error">{t('time_travel.sheet.before_birth')}</p>}
      {saveFailed && <p data-testid="time-travel-save-failed" role="alert" className="mt-2 text-xs text-status-error">{t('time_travel.sheet.save_failed')}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" data-testid="time-travel-cancel" onClick={props.onClose} className="rounded-lg px-4 py-2 text-sm text-text-secondary">
          {t('time_travel.sheet.cancel')}
        </button>
        <button type="button" data-testid="time-travel-go" disabled={!asOf || beforeBirth || saving} onClick={() => void submit()}
          className="rounded-lg bg-accent-gold px-4 py-2 text-sm font-semibold text-background-primary disabled:opacity-50">
          {t('time_travel.sheet.go')}
        </button>
      </div>
    </div>
  );
}
