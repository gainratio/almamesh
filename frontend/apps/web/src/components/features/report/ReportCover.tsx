/**
 * ReportCover — the branded first page of the printed Vedic report.
 *
 * Shows the AlmaMesh wordmark, the audience badge (For You / For Astrologer),
 * the person's name, a birth-details box (date/time in the BIRTH timezone via
 * `formatBirthDateTime`, place via `buildPlaceString`, ascendant), and the
 * generated date via `formatReportDate(new Date())` — which is null/epoch-safe,
 * so the cover never reads "December 31, 1969" the way the old export did.
 *
 * Two honesty surfaces sit on the cover (so the screen report matches the PDF):
 *   1. The Time of Birth ALWAYS carries an "As recorded" / "Rectified +N min"
 *      badge; when a rectification is in effect it also prints BOTH wall clocks
 *      ("entered 5:45 AM → computed for 6:00 AM") — derived purely from the
 *      `RectificationDelta` the caller threads in (no astrology recomputed).
 *   2. A near-cusp Ascendant raises a PROMINENT bordered callout (not a muted
 *      footnote) that leads with the rising value and names the alternative sign
 *      + the rectification advice. The cusp signal comes from `lib/lagnaCusp`.
 */

import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { LagnaData } from '@almamesh/browser/types';
import type { ProcessedBirthData } from '@almamesh/shared-types';
import {
  buildPlaceString,
  formatBirthDateTime,
  formatDegree,
  formatReportDate,
} from '../../../lib/reportData';
import { cuspInfo } from '../../../lib/lagnaCusp';
import type { RectificationDelta } from '../../../lib/rectification';
import type { ReportAudience } from '../../../lib/reportSelectors';

function titleCase(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : '';
}

interface ReportCoverProps {
  readonly personName: string;
  readonly audience: ReportAudience;
  readonly birth: ProcessedBirthData;
  readonly lagna: LagnaData;
  /**
   * The derived entered→rectified adjustment, or null when the recorded time was
   * used verbatim. Threaded from `ReportView` (which calls `rectificationDelta`)
   * the same way the PDF builder threads it — i18n stays here in React.
   */
  readonly rectification?: RectificationDelta | null;
  /**
   * The active profile, so a near-cusp callout can LINK to `/rectify/:id` — the
   * action its own copy recommends. Null/absent simply omits the link.
   */
  readonly profileId?: string | null;
}

/**
 * The Time-of-Birth value: the effective wall clock used, an honesty badge
 * ("As recorded" vs "Rectified +N min"), and — when rectified — both clocks.
 */
function TimeOfBirthValue({
  effective,
  rectification,
}: {
  readonly effective: string;
  readonly rectification?: RectificationDelta | null;
}): ReactElement {
  const { t } = useTranslation('report');
  const rectified = rectification ?? null;
  const sign = rectified && rectified.deltaMinutes > 0 ? '+' : '−';

  return (
    <>
      {effective}
      {rectified ? (
        <span
          className="report-cover-time-badge"
          data-variant="rectified"
          data-testid="report-time-badge"
        >
          {t('cover.time_badge_rectified', {
            sign,
            minutes: Math.abs(rectified.deltaMinutes),
          })}
        </span>
      ) : (
        <span
          className="report-cover-time-badge"
          data-variant="recorded"
          data-testid="report-time-badge"
        >
          {t('cover.time_badge_recorded')}
        </span>
      )}
      {rectified ? (
        <span className="report-cover-time-detail" data-testid="report-time-rectified-detail">
          {t('cover.time_rectified_detail', {
            entered: rectified.enteredLabel,
            rectified: rectified.rectifiedLabel,
          })}
        </span>
      ) : null}
    </>
  );
}

/**
 * A PROMINENT bordered cusp callout (engine-grounded honesty, not alarmist):
 * leads with the ascendant value, names the alternative rising sign, and states
 * that house placements depend on the recorded time. Renders nothing unless the
 * lagna sits within `cuspInfo`'s near-boundary threshold.
 *
 * It also LINKS to the rectification flow. The copy recommends refining the
 * birth time before relying on house placements, and for a while there was no
 * route to it anywhere on this page — a recommended action with no way to take
 * it. The link is the same one the dashboard's `IdentityStrip` has always shown
 * (`astrology:cusp.resolve_link` → `/rectify/:profileId`); it is omitted when no
 * profile is active, since there would be nothing to rectify. Screen only — the
 * PDF has no links, and its cusp note stays as it is.
 */
function CuspCallout({
  lagna,
  profileId,
}: {
  readonly lagna: LagnaData;
  readonly profileId?: string | null;
}): ReactElement | null {
  const { t } = useTranslation(['report', 'astrology']);
  const sign = titleCase(lagna.sign);
  const cusp = cuspInfo(sign, lagna.sign_degrees, 3, lagna);
  if (!cusp) {
    return null;
  }
  return (
    <aside className="report-cover-cusp-callout" role="note" data-testid="report-cusp-note">
      <span className="report-cover-cusp-callout-title" data-testid="report-cusp-callout-title">
        {t('cover.cusp_callout_title')}
      </span>
      <span className="report-cover-cusp-callout-asc">
        {sign} {formatDegree(lagna.sign_degrees)}
      </span>
      <span className="report-cover-cusp-callout-body">
        {t('cover.cusp_note', {
          degrees: cusp.degrees.toFixed(1),
          sign: cusp.neighbourSign,
        })}
      </span>
      {profileId ? (
        <Link
          to={`/rectify/${profileId}`}
          className="report-cover-cusp-callout-link no-print"
          data-testid="report-cusp-resolve-link"
        >
          {t('astrology:cusp.resolve_link')}
        </Link>
      ) : null}
    </aside>
  );
}

/** Cover page: wordmark, audience badge, name, birth box, generated date. */
export function ReportCover({
  personName,
  audience,
  birth,
  lagna,
  rectification,
  profileId,
}: ReportCoverProps): ReactElement {
  const { t } = useTranslation('report');
  const when = formatBirthDateTime(birth);
  const place = buildPlaceString(birth);
  const effectiveTime = `${when.time || '—'}${when.tzLabel ? ` (${when.tzLabel})` : ''}`;

  return (
    <section className="report-section report-cover" data-testid="report-cover">
      <div className="report-cover-brand">
        <span className="report-cover-mark">AlmaMesh</span>
        <span className="report-cover-kicker">{t('cover.kicker')}</span>
      </div>

      <svg
        className="report-cover-ornament"
        viewBox="0 0 64 18"
        fill="none"
        aria-hidden="true"
        focusable="false"
      >
        <line x1="0" y1="9" x2="24" y2="9" stroke="currentColor" strokeWidth="0.75" />
        <line x1="40" y1="9" x2="64" y2="9" stroke="currentColor" strokeWidth="0.75" />
        <path d="M32 2 L33.4 7.6 L39 9 L33.4 10.4 L32 16 L30.6 10.4 L25 9 L30.6 7.6 Z" fill="currentColor" />
      </svg>

      <span className="report-cover-badge" data-testid="report-audience-badge">
        {t(`audience.${audience}`)}
      </span>

      <span className="report-cover-prepared">{t('cover.prepared_for')}</span>
      <h1 className="report-cover-name">{personName}</h1>

      <dl className="report-cover-birth">
        <div className="report-cover-birth-item">
          <dt>{t('cover.date_of_birth')}</dt>
          <dd data-testid="report-birth-date">{when.date || '—'}</dd>
        </div>
        <div className="report-cover-birth-item">
          <dt>{t('cover.time_of_birth')}</dt>
          <dd>
            <TimeOfBirthValue effective={effectiveTime} rectification={rectification} />
          </dd>
        </div>
        <div className="report-cover-birth-item report-cover-birth-item-full">
          <dt>{t('cover.place_of_birth')}</dt>
          <dd data-testid="report-birth-place">{place || '—'}</dd>
        </div>
        <div className="report-cover-birth-item report-cover-birth-item-full">
          <dt>{t('cover.ascendant')}</dt>
          <dd>
            {titleCase(lagna.sign)} {formatDegree(lagna.sign_degrees)}
          </dd>
        </div>
      </dl>

      {/* Promoted near-cusp caveat: a bordered callout beside the Ascendant, not
          a muted footnote. Engine-grounded (cuspInfo measures the distance) and
          honest — it names the alternative rising sign and recommends refining
          the birth time before relying on house placements. */}
      <CuspCallout lagna={lagna} profileId={profileId} />

      <p className="report-cover-generated" data-testid="report-generated-date">
        {t('cover.generated_on', { date: formatReportDate(new Date()) })}
      </p>
    </section>
  );
}
