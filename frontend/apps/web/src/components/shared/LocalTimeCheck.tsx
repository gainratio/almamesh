/**
 * LocalTimeCheck — surfaces daylight-saving edges of an entered birth time.
 *
 * A wall-clock time can fail to exist (spring-forward gap) or happen twice
 * (fall-back overlap). The chart engine needs one instant, so instead of
 * silently shifting or picking, this shows a refusal for a gap time and asks the
 * user which occurrence they meant for a repeated one. Renders nothing for an
 * ordinary time, an incomplete entry, or an unknown zone (other checks own those).
 */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { type DstFold, type LocalTimeResolution, resolveLocalTime } from '@almamesh/store';

export interface LocalTimeCheckProps {
  /** Local civil date `YYYY-MM-DD` (empty when not yet entered). */
  readonly date: string;
  /** Local civil time `HH:MM` (empty when not yet entered). */
  readonly time: string;
  /** IANA zone of the birthplace. */
  readonly timeZone: string;
  /** The occurrence already chosen, if any. */
  readonly fold?: DstFold;
  readonly onFoldChange: (fold: DstFold) => void;
}

const FOLDS: readonly DstFold[] = ['earlier', 'later'];

/** `+330` -> `UTC+05:30`, `-420` -> `UTC−07:00` (true minus sign). */
export function formatUtcOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '−' : '+';
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `UTC${sign}${hh}:${mm}`;
}

function safeResolve(date: string, time: string, timeZone: string): LocalTimeResolution | null {
  if (!date || !time || !timeZone) return null;
  try {
    return resolveLocalTime(date, time, timeZone);
  } catch {
    return null;
  }
}

export function LocalTimeCheck({
  date,
  time,
  timeZone,
  fold,
  onFoldChange,
}: LocalTimeCheckProps): ReactElement | null {
  const { t } = useTranslation('onboarding');
  const resolution = safeResolve(date, time, timeZone);
  if (!resolution || resolution.kind === 'unique') return null;

  if (resolution.kind === 'nonexistent') {
    return (
      <div
        role="alert"
        data-testid="dst-gap-notice"
        className="rounded-lg border border-status-warning/60 bg-status-warning/10 p-4 text-sm text-text-primary"
      >
        {t('birth_time.dst_gap', { time, zone: timeZone })}
      </div>
    );
  }

  return (
    <fieldset
      data-testid="dst-fold-choice"
      className="rounded-lg border border-status-warning/60 bg-status-warning/10 p-4 text-sm"
    >
      <legend className="px-1 font-medium text-text-primary">
        {t('birth_time.dst_overlap', { time, zone: timeZone })}
      </legend>
      <div className="mt-2 space-y-2">
        {FOLDS.map((option) => (
          <label key={option} className="flex cursor-pointer items-center gap-2 text-text-secondary">
            <input
              type="radio"
              name="dst-fold"
              value={option}
              checked={fold === option}
              onChange={() => onFoldChange(option)}
              data-testid={`dst-fold-${option}`}
            />
            {t(`birth_time.dst_${option}`, {
              time,
              offset: formatUtcOffset(resolution[option].offsetMinutes),
            })}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
