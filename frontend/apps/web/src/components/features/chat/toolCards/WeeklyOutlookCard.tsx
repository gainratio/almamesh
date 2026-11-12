/**
 * Generative Panchang & Chandrabala/Tarabala card for single-day and multi-day
 * `read_period` tool results (`daily.length >= 1`).
 *
 * Zero astrology math: renders Python's deterministic `DayPanchangMark[]`
 * with distinct icon + label quality badges (never color alone).
 */
import { useTranslation } from 'react-i18next';
import type { DayPanchangMark } from '@almamesh/browser/types';

interface WeeklyOutlookPayload {
  readonly period?: { readonly label?: string; readonly start?: string; readonly end?: string };
  readonly place?: { readonly label?: string; readonly timezone?: string };
  readonly place_note?: string;
  readonly daily?: readonly DayPanchangMark[];
}

function isDayMark(value: unknown): value is DayPanchangMark {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.date === 'string' && typeof row.sign === 'string' && typeof row.nakshatra === 'string';
}

function cap(word: string): string {
  return word ? word.charAt(0).toUpperCase() + word.slice(1).replace(/_/g, ' ') : '';
}

function shortDate(isoDate: string, language: string): string {
  const noon = new Date(`${isoDate}T12:00:00Z`);
  if (Number.isNaN(noon.getTime())) return isoDate;
  return new Intl.DateTimeFormat(language || 'en', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(noon);
}

const QUALITY_STYLES = {
  supportive: { icon: '✦', cls: 'border-status-success/40 bg-status-success/10 text-status-success', key: 'cards.weekly.supportive' },
  mixed: { icon: '◐', cls: 'border-accent-gold/40 bg-accent-gold/10 text-accent-gold', key: 'cards.weekly.mixed' },
  caution: { icon: '△', cls: 'border-accent-purple/40 bg-accent-purple/10 text-accent-purple', key: 'cards.weekly.mindful' },
} as const;

function DayMarkCell({ day, single, language }: { readonly day: DayPanchangMark; readonly single: boolean; readonly language: string }) {
  const { t } = useTranslation('chat');
  const quality = day.day_quality && QUALITY_STYLES[day.day_quality] ? QUALITY_STYLES[day.day_quality] : null;
  return (
    <div
      data-testid={`weekly-day-${day.date}`}
      className={`flex flex-col justify-between rounded-lg border border-ui-border/80 bg-background-primary p-2.5 ${single ? 'w-full' : 'min-w-[138px] shrink-0'}`}
    >
      <div>
        <p className="font-semibold text-text-primary">{shortDate(day.date, language)}</p>
        <p className="mt-1 text-[11px] text-text-secondary">{cap(day.sign)} · {cap(day.nakshatra)} P{day.pada}</p>
        <p className="mt-0.5 text-[11px] text-text-muted">
          {cap(day.paksha)} {cap(day.tithi_name)}{single && day.yoga && day.karana ? ` · ${cap(day.yoga)} · ${cap(day.karana)}` : ''}
        </p>
      </div>
      {quality && (
        <div className="mt-2 flex items-center gap-1">
          <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${quality.cls}`}>
            <span aria-hidden="true">{quality.icon}</span>
            <span>{t(quality.key)}</span>
          </span>
        </div>
      )}
    </div>
  );
}

export function WeeklyOutlookCard({ result }: { readonly result: unknown }) {
  const { t, i18n } = useTranslation('chat');
  if (!result || typeof result !== 'object') return null;
  const payload = result as WeeklyOutlookPayload;
  const days = Array.isArray(payload.daily) ? payload.daily.filter(isDayMark) : [];
  if (days.length < 1) return null;

  return (
    <section
      aria-label={t('cards.weekly.title')}
      data-testid="tool-card-weekly-outlook"
      className="mb-2 rounded-xl border border-ui-border bg-background-secondary p-3 text-xs"
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 font-medium text-text-primary">
          <span aria-hidden="true" className="text-accent-gold">☀</span>
          <span>{t('cards.weekly.title')}</span>
          {payload.period?.label && <span className="text-text-muted">· {payload.period.label}</span>}
        </div>
        {payload.place?.label && (
          <span className="truncate text-[11px] text-text-muted"><span aria-hidden="true">📍 </span>{payload.place.label}</span>
        )}
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {days.map((day) => <DayMarkCell key={day.date} day={day} single={days.length === 1} language={i18n.language} />)}
      </div>
      {payload.place_note && (
        <p data-testid="weekly-place-note" className="mt-2 text-[11px] text-text-muted">
          <span aria-hidden="true">📍 </span>{t('cards.weekly.set_city_hint')}
        </p>
      )}
    </section>
  );
}
