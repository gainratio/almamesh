import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

import { LegalPageLayout } from './LegalPageLayout';
import { RETRODICTION_RESULTS, type AreaTechniqueResult, type TechniqueResult } from './howWeTestResults';

/** The lift axis: chance (1.0) sits in the middle. */
const AXIS = { min: 0.25, max: 1.75 } as const;
const TICKS = [0.5, 1, 1.5] as const;

const at = (value: number): string => `${((value - AXIS.min) / (AXIS.max - AXIS.min)) * 100}%`;

interface Formats {
  readonly lift: Intl.NumberFormat;
  readonly count: Intl.NumberFormat;
}

/** "1.03 (0.90–1.16)" in the page's number format. */
function liftText(result: Pick<TechniqueResult, 'lift' | 'low' | 'high'>, lift: Intl.NumberFormat): string {
  return `${lift.format(result.lift)} (${lift.format(result.low)}–${lift.format(result.high)})`;
}

interface LiftRowProps {
  readonly result: TechniqueResult;
  readonly formats: Formats;
}

function LiftRow({ result, formats }: LiftRowProps): ReactElement {
  const { t } = useTranslation('legal');
  return (
    <li className="grid gap-x-5 gap-y-1.5 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_11rem] sm:items-center">
      <span className="text-sm leading-snug text-text-primary">
        {t(`how_we_test.techniques.${result.key}`)}
        <span className="block text-xs text-text-muted">
          {t('how_we_test.events', { n: formats.count.format(result.events) })}
        </span>
      </span>
      <span aria-hidden="true" className="relative h-5">
        <span className="absolute inset-x-0 top-1/2 h-px bg-ui-border" />
        <span className="absolute inset-y-0 border-l border-dashed border-accent-gold/50" style={{ left: at(1) }} />
        <span
          className="absolute top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-text-muted"
          style={{ left: at(result.low), width: `calc(${at(result.high)} - ${at(result.low)})` }}
        />
        <span
          className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent-gold ring-2 ring-background-primary"
          style={{ left: at(result.lift) }}
        />
      </span>
      <span className="text-sm tabular-nums text-text-secondary sm:text-right">{liftText(result, formats.lift)}</span>
    </li>
  );
}

/** The classical dasha rules: one lane per life area, because the run published a lift for each area, not one for all. */
function AreaRow({ result, formats }: { readonly result: AreaTechniqueResult; readonly formats: Formats }): ReactElement {
  const { t } = useTranslation('legal');
  return (
    <li className="grid gap-x-5 gap-y-1.5 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_11rem] sm:items-start">
      <span className="text-sm leading-snug text-text-primary">
        {t(`how_we_test.techniques.${result.key}`)}
        <span className="block text-xs text-text-muted">{t('how_we_test.events_areas', { n: formats.count.format(result.events) })}</span>
      </span>
      <span aria-hidden="true" className="relative block">
        {result.areas.map((area) => (
          <span key={area.area} className="relative block h-5">
            <span className="absolute inset-x-0 top-1/2 h-px bg-ui-border" />
            <span className="absolute inset-y-0 border-l border-dashed border-accent-gold/50" style={{ left: at(1) }} />
            <span
              className="absolute top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-text-muted"
              style={{ left: at(area.low), width: `calc(${at(area.high)} - ${at(area.low)})` }}
            />
            <span className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent-gold ring-2 ring-background-primary" style={{ left: at(area.lift) }} />
          </span>
        ))}
      </span>
      <span className="block text-sm tabular-nums text-text-secondary sm:text-right">
        {result.areas.map((area) => (
          <span key={area.area} className="block h-5 leading-5">
            {t(`how_we_test.areas.${area.area}`)} {liftText(area, formats.lift)}
          </span>
        ))}
      </span>
    </li>
  );
}

function LiftAxis({ lift }: { readonly lift: Intl.NumberFormat }): ReactElement {
  const { t } = useTranslation('legal');
  return (
    <div aria-hidden="true" className="grid sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_11rem] sm:gap-x-5">
      <span className="hidden sm:block" />
      <span className="relative h-8 text-xs text-text-muted">
        {TICKS.map((tick) => (
          <span key={tick} className="absolute top-1 -translate-x-1/2 whitespace-nowrap text-center" style={{ left: at(tick) }}>
            {lift.format(tick)}
            {tick === 1 && <span className="block text-accent-gold">{t('how_we_test.axis_chance')}</span>}
          </span>
        ))}
      </span>
    </div>
  );
}

function LiftChart({ formats }: { readonly formats: Formats }): ReactElement {
  const { t } = useTranslation('legal');
  const title = t('how_we_test.chart_title');
  return (
    <figure className="my-10 rounded-lg border border-ui-border bg-background-secondary px-4 py-6 sm:px-6">
      <figcaption className="mb-5">
        <span className="block text-base font-semibold text-text-primary">{title}</span>
        <span className="mt-1 block text-sm text-text-muted">{t('how_we_test.chart_caption')}</span>
      </figcaption>
      <ul aria-label={title} className="flex flex-col gap-5">
        {RETRODICTION_RESULTS.techniques.map((result) => (
          <LiftRow key={result.key} result={result} formats={formats} />
        ))}
        <AreaRow result={RETRODICTION_RESULTS.classicalDasha} formats={formats} />
      </ul>
      <LiftAxis lift={formats.lift} />
    </figure>
  );
}

export default function HowWeTest(): ReactElement {
  const { t, i18n } = useTranslation('legal');
  const formats: Formats = {
    lift: new Intl.NumberFormat(i18n.language, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    count: new Intl.NumberFormat(i18n.language),
  };
  const results = RETRODICTION_RESULTS;
  const baseline = results.techniques[0];
  const lead = (
    <>
      <p className="max-w-[65ch] text-lg leading-relaxed text-text-primary">{t('how_we_test.lede')}</p>
      <LiftChart formats={formats} />
    </>
  );

  return (
    <LegalPageLayout title={t('how_we_test.title')} lastUpdated={t('how_we_test.last_updated')} lead={lead} translationNote={false}>
      <h2>{t('how_we_test.what_heading')}</h2>
      <p>{t('how_we_test.what_p1', { window: results.windowMonths, top: results.topMonths })}</p>
      <p>{t('how_we_test.what_p2', { window: results.windowMonths, top: results.topMonths })}</p>

      <h2>{t('how_we_test.data_heading')}</h2>
      <p>
        {t('how_we_test.data_p1', { events: formats.count.format(results.events), people: formats.count.format(results.people) })}
      </p>
      <p>{t('how_we_test.data_p2')}</p>

      <h2>{t('how_we_test.result_heading')}</h2>
      <p>{t('how_we_test.result_p1', { baseline: baseline ? formats.lift.format(baseline.lift) : '' })}</p>

      <h2>{t('how_we_test.meaning_heading')}</h2>
      <p>{t('how_we_test.meaning_p1')}</p>
      <p>{t('how_we_test.meaning_p2')}</p>

      <h2>{t('how_we_test.bar_heading')}</h2>
      <p>{t('how_we_test.bar_p1')}</p>

      <h2>{t('how_we_test.rerun_heading')}</h2>
      <p>{t('how_we_test.rerun_p1')}</p>
    </LegalPageLayout>
  );
}
