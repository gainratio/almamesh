/**
 * ReportView — the dedicated, print-first Vedic report page (`/report`).
 *
 * Reads the SAME on-device sources the dashboard uses — the active profile's
 * chart from `useChartLibraryStore` and its (optional) interpretation from the
 * persisted interpretation store — and renders a single light "paper" document
 * styled for A4 ON SCREEN (WYSIWYG). The "Download PDF" action renders the
 * @react-pdf document — the SOLE PDF path (the legacy browser-print export is
 * gone). The audience is taken from the `?mode=` query param (falling back to
 * the stored content mode). No astrology is computed here; the page is pure
 * presentation over engine + LLM output.
 *
 * GRACEFUL DEGRADATION: only a missing CHART dead-ends (there is nothing to
 * report). When the interpretation has not been generated yet, the report still
 * renders its deterministic natal halves (cover · kundli · planets · dasha ·
 * yogas) and the PDF download stays enabled. The exported document then PRINTS
 * the Interpretation section with an honest note saying a written reading
 * appears once one has been generated — it is never silently dropped, which
 * left the section numbering jumping VI → VIII with no explanation.
 *
 * The export itself lives in `hooks/useReportPdfExport` — the single assembly
 * this page and the dashboard's one-click Export PDF both call, so the two
 * entry points cannot produce two different documents.
 */

import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  useChartLibraryStore,
  useLifeEventsStore,
  useProfilesStore,
  useRectificationRecordsStore,
  type LifeEvent,
} from '@almamesh/store';
import type { LagnaData } from '@almamesh/browser/types';
import type { ProcessedBirthData, RectificationRecord } from '@almamesh/shared-types';
import { useStreamingInterpretation } from '../hooks/useStreamingInterpretation';
import { usePredictiveLayer, type PredictiveLayer } from '../hooks/usePredictiveLayer';
import { useElapsedSeconds, formatElapsed } from '../hooks/useElapsedSeconds';
import { useContentModeStore } from '../stores/contentMode';
import { resolveReportAudience } from '../lib/reportSelectors';
import { selectPrimaryStoredChart } from '../lib/predictive';
import { cuspInfo } from '../lib/lagnaCusp';
import { yogaDependsOnHouses } from '../lib/evidence';
import { rectificationDelta } from '../lib/rectification';
import { domainClaimId, reportStabilityMarkers, yogaClaimId } from '../lib/stability';
import { useReportPdfExport } from '../hooks/useReportPdfExport';
import {
  ReportAssumptions,
  ReportChartsPage,
  ReportCover,
  ReportDasha,
  ReportDomains,
  ReportEvidence,
  ReportFooter,
  ReportHouses,
  ReportInterpretation,
  ReportPlanetTable,
  ReportRectification,
  ReportStrength,
  ReportTransits,
  ReportVargas,
  ReportYogas,
} from '../components/features/report';
import '../styles/report-print.css';

/** Capitalize a sign name for the cusp lookup (matches the on-screen cover). */
function titleCaseSign(sign: string): string {
  return sign ? sign.charAt(0).toUpperCase() + sign.slice(1) : '';
}

/** Graceful fallback when there is no chart / no finished interpretation yet. */
function ReportEmpty({ message }: { message: string }): ReactElement {
  const { t } = useTranslation('report');
  return (
    <div className="report-screen">
      <div className="report-document">
        <div className="report-empty">
          <h1>{t('empty.heading')}</h1>
          <p className="report-prose">{message}</p>
          <Link to="/dashboard" className="report-toolbar-button report-toolbar-button-primary">
            {t('empty.back')}
          </Link>
        </div>
      </div>
    </div>
  );
}

/**
 * On-screen (no-print) affordance to compute the predictive sections before
 * printing: honest copy, live elapsed time, explicit retry — and silent once
 * the contexts are ready (the sections themselves render instead).
 */
function ReportPredictivePending({ layer }: { layer: PredictiveLayer }): ReactElement | null {
  const { t } = useTranslation('report');
  const elapsed = useElapsedSeconds(layer.status === 'loading');

  if (layer.status === 'ready' || !layer.hasBirthData) {
    return null;
  }

  return (
    <div className="report-pending no-print" data-testid="report-predictive-pending">
      <h2>{t('predictive_pending.title')}</h2>
      {layer.status === 'loading' ? (
        <p>{t('predictive_pending.computing', { elapsed: formatElapsed(elapsed) })}</p>
      ) : layer.status === 'error' ? (
        <>
          <p>{t('predictive_pending.error')}</p>
          <button
            type="button"
            className="report-toolbar-button"
            onClick={layer.compute}
            disabled={!layer.canCompute}
            data-testid="report-predictive-retry"
          >
            {t('predictive_pending.retry')}
          </button>
        </>
      ) : (
        <>
          <p>{t('predictive_pending.body')}</p>
          {layer.canCompute ? (
            <button
              type="button"
              className="report-toolbar-button"
              onClick={layer.compute}
              data-testid="report-predictive-compute"
            >
              {t('predictive_pending.compute')}
            </button>
          ) : (
            <p>{t('predictive_pending.engine_warming')}</p>
          )}
        </>
      )}
    </div>
  );
}

/** The print-first report page. */
export default function ReportView(): ReactElement {
  const navigate = useNavigate();
  const { t } = useTranslation('report');
  const [searchParams] = useSearchParams();
  const { contentMode } = useContentModeStore();

  // Subscribe to the chart map so the page re-renders once SQLite rehydrates.
  const activeProfileId = useProfilesStore((s) => s.activeProfileId);
  const charts = useChartLibraryStore((s) => s.charts);
  const storedChart = selectPrimaryStoredChart(charts, activeProfileId);
  const chartId = storedChart?.chart_id ?? null;
  const { interpretation, evidenceAnnotations } = useStreamingInterpretation(chartId);

  // The lazy predictive layer (transits / vargas / strength / domains): the
  // report renders these sections only when computed; otherwise it offers an
  // on-screen (never printed) affordance to compute before printing.
  const predictive = usePredictiveLayer();

  // Birth Time Authority: the profile's CONFIRMED rectification
  // record + its supporting life events, resolved in record order (read-only
  // store usage; ids that no longer resolve are simply dropped).
  const profileId = activeProfileId ?? storedChart?.profile_id ?? null;
  const rectificationRecord: RectificationRecord | undefined = useRectificationRecordsStore(
    (s) => (profileId ? s.recordsByProfile[profileId] : undefined),
  );
  const profileEvents: readonly LifeEvent[] =
    useLifeEventsStore((s) => (profileId ? s.eventsByProfile[profileId] : undefined)) ?? [];
  const supportingEvents: readonly LifeEvent[] = rectificationRecord
    ? rectificationRecord.supportingEventIds
        .map((id) => profileEvents.find((event) => event.id === id))
        .filter((event): event is LifeEvent => event !== undefined)
    : [];

  // `?mode=` wins; otherwise fall back to the dashboard's content mode.
  const fallbackMode = contentMode === 'technical' ? 'astrologer' : 'you';
  const audience = resolveReportAudience(searchParams.get('mode') ?? fallbackMode);

  // The export is assembled in ONE shared place (`useReportPdfExport`) that the
  // dashboard's one-click Export PDF also uses — so the two entry points cannot
  // drift into two different documents. `pdfError` is on-screen only, never
  // printed, and clears at the start of every attempt.
  const { exportPdf, pdfError } = useReportPdfExport(audience);

  const personName = storedChart?.person_name ?? '';

  // Only a missing CHART dead-ends — there is nothing to report. A missing
  // interpretation degrades gracefully (natal-only) below.
  const sidereal = storedChart?.sidereal_chart;
  if (!storedChart || !sidereal) {
    return <ReportEmpty message={t('empty.no_chart')} />;
  }

  // The written interpretation is OPTIONAL, and it is read from ONE stored
  // value — `interpretation` is exactly what the hook deems safe to display,
  // and exactly what the dashboard renders. Do NOT additionally gate on
  // `status === 'complete'`: a natal-only reading stays valid prose forever,
  // but its `status` is downgraded to 'idle' the moment the predictive layer
  // computes. That extra gate is what silently dropped the narrative from the
  // report and the PDF while the dashboard went on showing it. Display and
  // export now read the same field, so they cannot disagree.
  // Time-sensitive AI prose stays on the dashboard where its independent
  // generated/as-of date is visible. The report uses stable natal prose plus
  // its deterministic predictive sections; it never makes an old timeline
  // look current by flattening away that date.
  const readyInterpretation = interpretation;

  const birth = storedChart.birth_data as ProcessedBirthData | undefined;
  const lagna = sidereal.lagna as LagnaData;

  // Stage-4 stable-vs-lagna. A near-cusp ascendant means the whole-sign house
  // frame could rotate to the adjacent sign under a small birth-time correction,
  // so every house-based verdict (yoga grade, domain band) is birth-time-
  // sensitive; an unambiguous ascendant makes them all stable. This is the
  // CONSERVATIVE render-time marker — the exact dual-pass diff lives in the
  // engine's `rectification.stability`; the chip here never over-claims stability.
  const nearCusp = cuspInfo(titleCaseSign(lagna.sign), lagna.sign_degrees, 3, lagna) !== null;
  const domainsReady = predictive.status === 'ready' && predictive.domainsCtx;
  const stabilityClaims = [
    ...sidereal.yogas.map((yoga) => ({
      claimId: yogaClaimId(yoga.name),
      houseDependent: yogaDependsOnHouses(yoga),
    })),
    ...(domainsReady
      ? Object.keys(predictive.domainsCtx.forecasts).map((domain) => ({
          claimId: domainClaimId(domain),
          houseDependent: true,
        }))
      : []),
  ];
  const stability = reportStabilityMarkers(stabilityClaims, nearCusp);

  return (
    <div className="report-screen">
      <div className="report-toolbar no-print" data-testid="report-toolbar">
        <button
          type="button"
          className="report-toolbar-button report-toolbar-button-primary no-print"
          onClick={exportPdf}
          data-testid="report-download-pdf"
        >
          {t('download_pdf')}
        </button>
        <button
          type="button"
          className="report-toolbar-button no-print"
          onClick={() => navigate(-1)}
          data-testid="report-back"
        >
          {t('common:actions.back')}
        </button>
      </div>

      {/* PDF-generation failure — visible, calm, on-screen only (reuses the
          report's pending/notice treatment). */}
      {pdfError ? (
        <div className="report-pending no-print" role="alert" data-testid="report-pdf-error">
          <p>{pdfError}</p>
        </div>
      ) : null}

      {/* Natal-only hint: the report is fully usable without the written reading;
          this nudges the user to generate it for the complete report. */}
      {!readyInterpretation ? (
        <div className="report-pending no-print" data-testid="report-narrative-hint">
          <p>{t('narrative_hint')}</p>
        </div>
      ) : null}

      {/* Compute-before-printing affordance for the predictive sections. */}
      <ReportPredictivePending layer={predictive} />

      <article className="report-document" data-testid="report-document">
        {birth ? (
          <ReportCover
            personName={personName}
            audience={audience}
            birth={birth}
            lagna={lagna}
            rectification={rectificationDelta(birth)}
            profileId={profileId}
          />
        ) : null}
        {/* Section order is DECLARED once, in `lib/reportSections.ts`, and the
            export follows the same list — so the two surfaces cannot present the
            same section under different numerals (Evidence was VIII on paper and
            XII on screen). Change the order here and in the registry together;
            `__tests__/reportSectionParity.test.tsx` checks the screen's rendered
            numerals read I…XIV in order. */}
        <ReportPlanetTable chart={sidereal} />
        <ReportHouses chart={sidereal} />
        <ReportChartsPage chart={sidereal} />
        <ReportDasha dashas={sidereal.dashas} />
        <ReportYogas
          yogas={sidereal.yogas}
          interpretation={readyInterpretation}
          audience={audience}
          stability={stability}
        />
        {readyInterpretation ? (
          <ReportInterpretation interpretation={readyInterpretation} audience={audience} />
        ) : null}
        {/* Evidence & Confidence — the audit of everything above. Deterministic
            (engine chart only), so it renders whether or not a reading exists;
            without one, each row states plainly that it has no interpretation. */}
        <ReportEvidence chart={sidereal} annotations={evidenceAnnotations} />
        {/* Predictive sections — rendered only when the lazy contexts are
            computed. Their numerals come from the registry, so a section that
            does not render never leaves a hole in the sequence for the ones
            that do. */}
        {predictive.status === 'ready' && predictive.transitCtx && (
          <ReportTransits transitCtx={predictive.transitCtx} />
        )}
        {predictive.status === 'ready' && predictive.vargaCtxFull && (
          <ReportVargas vargaCtxFull={predictive.vargaCtxFull} />
        )}
        {predictive.status === 'ready' && predictive.strengthCtx && (
          <ReportStrength strengthCtx={predictive.strengthCtx} />
        )}
        {predictive.status === 'ready' && predictive.domainsCtx && (
          <ReportDomains domainsCtx={predictive.domainsCtx} stability={stability} />
        )}
        {/* Birth Time Authority — only when a rectification was confirmed. */}
        {rectificationRecord ? (
          <ReportRectification record={rectificationRecord} events={supportingEvents} />
        ) : null}
        {/* Assumptions & provenance — the four load-bearing choices every
            verdict above rests on, assembled from existing provenance. */}
        <ReportAssumptions
          lagna={lagna}
          rectification={birth ? rectificationDelta(birth) : null}
        />
        <ReportFooter personName={personName} />
      </article>
    </div>
  );
}
