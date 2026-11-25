/**
 * useReportPdfExport — the ONE place the report PDF request is assembled.
 *
 * WHY THIS EXISTS: the export used to be assembled inline inside `ReportView`,
 * which made the dashboard's "Export PDF" button a *navigation* to `/report`
 * rather than an export — the user had to arrive at a second screen and click a
 * second button. Worse, the dashboard gated that button on a finished AI
 * reading, so a keyless user could not export at all.
 *
 * Everything the report needs is ALREADY PERSISTED on the device (chart,
 * interpretation, predictive contexts, rectification record, life events). So
 * the export reads stored values and renders — it never prompts, never asks for
 * a key, and never recomputes anything the screen already computed. A second
 * implementation of a rule is how two renderers come to disagree; there is only
 * one assembly here, and both callers use it.
 *
 * Degradation is honest, never silent: a missing interpretation still exports a
 * complete deterministic report, and the document itself prints a note saying
 * the written interpretation appears once a reading has been generated.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  predictiveRequestKey,
  useAyanamsaStore,
  useChartLibraryStore,
  useInterpretationStore,
  useLifeEventsStore,
  usePredictiveStore,
  useProfilesStore,
  useRectificationRecordsStore,
  type EnsurePredictiveInput,
  type LifeEvent,
} from '@almamesh/store';
import { safeError } from '@almamesh/shared-types';
import type { LagnaData } from '@almamesh/browser/types';
import type { ProcessedBirthData, RectificationRecord } from '@almamesh/shared-types';
import { useStreamingInterpretation } from './useStreamingInterpretation';
import { awaitInFlightEvidenceAnnotations } from './evidenceAnnotations';
import { useDailyReferenceInstant } from './useDailyReferenceInstant';
import {
  buildEnsurePredictiveInput,
  predictiveProfileKeyOf,
  selectPrimaryStoredChart,
  storedChartAyanamsa,
} from '../lib/predictive';
import { storedChartReferenceInstant, viewerTimeZone } from '../lib/analysisInstant';
import { waitForPredictiveFacts } from '../lib/predictiveWait';
import { resolveReadyEngine } from '../lib/resolveReadyEngine';
import {
  useOptionalChartEngine,
  type ChartEngineContextValue,
} from '../providers/chartEngineContext';
import { cuspInfo } from '../lib/lagnaCusp';
import { rectificationDelta } from '../lib/rectification';
import { buildOmittedSectionsValue, sectionNumeral } from '../lib/reportSections';
import { domainClaimId, reportStabilityMarkers, yogaClaimId } from '../lib/stability';
import { downloadReportPdf, type ReportPdfChrome } from '../lib/downloadReportPdf';
import { buildEvidenceLedger, yogaDependsOnHouses } from '../lib/evidence';
import { buildEvidenceSection } from '../components/report-pdf/buildEvidenceSection';
import { buildRectificationPdf } from '../components/report-pdf/buildRectificationPdf';
import { glyphSafe } from '../components/report-pdf/glyphSafe';
import { ayanamsaDisplayName } from '../lib/reportData';
import { formatYogaActivation } from '../lib/yogaActivation';
import type { ReportAudience } from '../lib/reportSelectors';

/** A short ISO date (YYYY-MM-DD) for the PDF file/title. */
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Capitalize a sign name for the cusp lookup (matches the on-screen cover). */
function titleCaseSign(sign: string): string {
  return sign ? sign.charAt(0).toUpperCase() + sign.slice(1) : '';
}

/**
 * Wait on an already-in-flight `expectedKey` compute, exiting immediately if
 * the store settles, resets to `'idle'`, or gets preempted by another key.
 */
async function awaitInFlightKey(expectedKey: string, signal: AbortSignal): Promise<void> {
  const inFlightState = (): 'pending' | 'ready' | 'error' => {
    const snap = usePredictiveStore.getState();
    if (snap.requestKey !== expectedKey || snap.status === 'idle') return 'error';
    if (snap.status === 'ready') return 'ready';
    if (snap.status === 'error') return 'error';
    return 'pending';
  };
  await waitForPredictiveFacts({
    state: inFlightState,
    subscribe: usePredictiveStore.subscribe,
    signal,
    onWaiting: () => {},
  });
}

function hasCurrentBootProof(
  snap: ReturnType<typeof usePredictiveStore.getState>,
): boolean {
  return Boolean(
    snap.rawContexts?.domain_strength_receipts && snap.rawContexts?.strength_signer_public_key,
  );
}

/**
 * Ensure the deterministic predictive superset (Sections IX–XII) AND its
 * current-boot Ed25519 Avow receipts are computed for this exact chart +
 * reference instant before assembling the PDF, whenever an on-device engine
 * provider is mounted. Preemption-safe and abort-safe.
 */
async function ensurePredictiveForExport(
  engineCtx: ChartEngineContextValue | null,
  predictiveInput: EnsurePredictiveInput | null,
  signal: AbortSignal,
): Promise<void> {
  if (!predictiveInput || !engineCtx || signal.aborted) return;
  const expectedKey = predictiveRequestKey(predictiveInput);
  const initial = usePredictiveStore.getState();
  if (
    initial.requestKey === expectedKey &&
    initial.status === 'ready' &&
    hasCurrentBootProof(initial)
  ) {
    return;
  }

  if (initial.requestKey === expectedKey && initial.status === 'loading') {
    await awaitInFlightKey(expectedKey, signal);
  }
  if (signal.aborted) return;

  const afterWait = usePredictiveStore.getState();
  if (
    afterWait.requestKey === expectedKey &&
    (afterWait.status === 'error' ||
      (afterWait.status === 'ready' && hasCurrentBootProof(afterWait)))
  ) {
    return;
  }

  engineCtx.startBootstrap?.();
  const engine = await resolveReadyEngine(engineCtx);
  if (signal.aborted) return;

  const afterBoot = usePredictiveStore.getState();
  if (
    afterBoot.requestKey === expectedKey &&
    afterBoot.status === 'ready' &&
    hasCurrentBootProof(afterBoot)
  ) {
    return;
  }
  if (afterBoot.requestKey === expectedKey && afterBoot.status === 'loading') {
    await awaitInFlightKey(expectedKey, signal);
    const afterSecondWait = usePredictiveStore.getState();
    if (afterSecondWait.requestKey !== expectedKey || hasCurrentBootProof(afterSecondWait)) {
      return;
    }
  }
  await usePredictiveStore.getState().ensurePredictive(engine, predictiveInput, {
    requireProof: true,
  });
}

export interface UseReportPdfExportResult {
  /** Render + download the PDF from stored data. Never prompts. */
  readonly exportPdf: () => void;
  /** On-screen-only failure notice (never printed); null when clean. */
  readonly pdfError: string | null;
  /** True while predictive settlement + PDF generation are in flight. */
  readonly isExporting: boolean;
  /**
   * True when a chart with birth data is stored — the ONLY precondition.
   * Deliberately NOT gated on an AI reading: the deterministic report is the
   * bulk of the document and is complete without one.
   */
  readonly canExport: boolean;
}

export function useReportPdfExport(audience: ReportAudience): UseReportPdfExportResult {
  const { t, i18n } = useTranslation('report');
  const { t: tp } = useTranslation('predictive');
  const { t: ts } = useTranslation('settings');

  const engineCtx = useOptionalChartEngine();
  const ayanamsa = useAyanamsaStore((s) => s.ayanamsa);
  const todayDay = useDailyReferenceInstant(viewerTimeZone());

  const activeProfileId = useProfilesStore((s) => s.activeProfileId);
  const charts = useChartLibraryStore((s) => s.charts);
  const storedChart = selectPrimaryStoredChart(charts, activeProfileId);
  const chartId = storedChart?.chart_id ?? null;

  // The SAME stored value the dashboard and the report screen render. No
  // `status === 'complete'` gate: that extra condition is what silently dropped
  // a perfectly valid natal-only reading from the export the moment the
  // predictive layer computed and turned its status stale.
  const { interpretation, evidenceAnnotations, evidenceAnnotationError } =
    useStreamingInterpretation(chartId);
  // The current timeline is intentionally dashboard-only for now. Flattening
  // it into the report would discard its independent generated/as-of date and
  // could present retained timing prose as freshly generated.
  const reportInterpretation = interpretation;

  const profileId = activeProfileId ?? storedChart?.profile_id ?? null;
  const rectificationRecord: RectificationRecord | undefined = useRectificationRecordsStore((s) =>
    profileId ? s.recordsByProfile[profileId] : undefined,
  );
  // Kept as the raw store value (no `?? []` here): a fresh array literal on
  // every render would change the useCallback identity every render.
  const storedEvents = useLifeEventsStore((s) =>
    profileId ? s.eventsByProfile[profileId] : undefined,
  );

  const sidereal = storedChart?.sidereal_chart;
  const birth = storedChart?.birth_data as ProcessedBirthData | undefined;
  const canExport = Boolean(storedChart && sidereal && birth);

  const [pdfError, setPdfError] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const exportingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  // Keep latest validated prose/annotations for each chartId reachable across
  // an async engine wait without mixing state if the active profile switches.
  const latestProseRef = useRef({
    chartId,
    interpretation: reportInterpretation,
    evidenceAnnotations,
    evidenceAnnotationError,
  });
  latestProseRef.current = {
    chartId,
    interpretation: reportInterpretation,
    evidenceAnnotations,
    evidenceAnnotationError,
  };

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const exportPdf = useCallback((): void => {
    if (!storedChart || !sidereal || !birth || exportingRef.current) {
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    exportingRef.current = true;
    setIsExporting(true);
    setPdfError(null);

    const targetChartId = storedChart.chart_id;
    const targetProfileId = profileId;
    const initialInterpretation = reportInterpretation;
    const initialAnnotations = evidenceAnnotations;
    const initialAnnotationError = evidenceAnnotationError;

    void (async () => {
      try {
        const chartAyanamsa = storedChartAyanamsa(storedChart, ayanamsa);
        const profileKey = predictiveProfileKeyOf(storedChart, activeProfileId);
        const referenceInstant = storedChartReferenceInstant(storedChart, todayDay);
        const predictiveInput = buildEnsurePredictiveInput(
          profileKey,
          birth,
          referenceInstant,
          {},
          chartAyanamsa,
        );
        try {
          await ensurePredictiveForExport(engineCtx, predictiveInput, controller.signal);
        } catch {
          // Degrade honestly: export deterministic natal chapters + omitted-sections manifest.
        }
        if (controller.signal.aborted) {
          return;
        }

        await awaitInFlightEvidenceAnnotations(targetChartId, controller.signal);
        if (controller.signal.aborted) {
          return;
        }

        const expectedKey = predictiveInput ? predictiveRequestKey(predictiveInput) : undefined;
        const settledPredictive = usePredictiveStore.getState();
        const hasPredictive = Boolean(
          expectedKey !== undefined &&
            settledPredictive.status === 'ready' &&
            settledPredictive.requestKey === expectedKey &&
            settledPredictive.transitCtx &&
            settledPredictive.vargaCtxFull &&
            settledPredictive.strengthCtx &&
            settledPredictive.domainsCtx,
        );

        const storeEntry = useInterpretationStore.getState().byChart[targetChartId];
        const refProse =
          latestProseRef.current.chartId === targetChartId
            ? latestProseRef.current
            : {
                interpretation: initialInterpretation,
                evidenceAnnotations: initialAnnotations,
                evidenceAnnotationError: initialAnnotationError,
              };
        const freshProse = {
          interpretation: storeEntry?.interpretation ?? refProse.interpretation,
          evidenceAnnotations: storeEntry?.evidenceAnnotations ?? refProse.evidenceAnnotations,
          evidenceAnnotationError:
            storeEntry?.evidenceAnnotationError ?? refProse.evidenceAnnotationError,
        };
        const liveRectification = targetProfileId
          ? useRectificationRecordsStore.getState().recordsByProfile[targetProfileId]
          : rectificationRecord;
        const liveEvents: readonly LifeEvent[] =
          (targetProfileId
            ? useLifeEventsStore.getState().eventsByProfile[targetProfileId]
            : storedEvents) ?? [];

        const lagna = sidereal.lagna as LagnaData;
        const personName = storedChart.person_name ?? '';
        const supportingEvents: readonly LifeEvent[] = liveRectification
          ? liveRectification.supportingEventIds
              .map((id) => liveEvents.find((event) => event.id === id))
              .filter((event): event is LifeEvent => event !== undefined)
          : [];

        const snapshotAyanamsa = chartAyanamsa.toUpperCase();
        const ayanamsaValueLabel =
          snapshotAyanamsa === 'LAHIRI'
            ? t('assumptions.ayanamsa_value')
            : ts(`ayanamsa.${snapshotAyanamsa.toLowerCase()}`, {
                defaultValue: ayanamsaDisplayName(snapshotAyanamsa),
              });
        const technicalNote =
          snapshotAyanamsa === 'LAHIRI'
            ? t('pdf.technical_note')
            : `${ayanamsaValueLabel} · ${t('assumptions.house_system_value')}`;

        const cusp = cuspInfo(titleCaseSign(lagna.sign), lagna.sign_degrees, 3, lagna);
        const chrome: ReportPdfChrome = {
          personName,
          audienceLabel: t(`audience.${audience}`),
          subtitle: t('pdf.subtitle'),
          kicker: t('cover.kicker'),
          ascendantNote: cusp
            ? t('cover.cusp_note', { degrees: cusp.degrees.toFixed(1), sign: cusp.neighbourSign })
            : undefined,
          formatRectifiedNote: (delta) =>
            t('cover.rectified_note', {
              entered: delta.enteredLabel,
              rectified: delta.rectifiedLabel,
              sign: delta.deltaMinutes > 0 ? '+' : '−',
              minutes: Math.abs(delta.deltaMinutes),
            }),
          formatAntarHeading: (lord) => t('dasha.antar_heading', { lord }),
          formatPratyantarHeading: (lord) => t('dasha.pratyantar_heading', { lord }),
          formatCombustion: {
            state: (separation) => t('pdf.planet_state_combust', { separation }),
            note: ({ planet, separation, orb }) =>
              t('pdf.combustion_note', { planet, separation, orb }),
          },
          formatYogaActivation: (yoga) => formatYogaActivation(yoga, t, tp),
          chartCaptions: {
            rasi: t('charts.rasi_caption'),
            navamsa: t('charts.navamsa_caption'),
          },
          detailLabels: {
            dateOfBirth: t('cover.date_of_birth'),
            timeOfBirth: t('cover.time_of_birth'),
            placeOfBirth: t('cover.place_of_birth'),
            ascendant: t('cover.ascendant'),
          },
          chromeLabels: {
            preparedFor: t('cover.prepared_for'),
            birthDetailsTitle: t('pdf.birth_details_title'),
            birthDetailsEyebrow: t('pdf.birth_details_eyebrow'),
            birthDetailsIntro: t('pdf.birth_details_intro'),
            technicalNote,
            footerNote: t('pdf.footer_note'),
            planetsEyebrow: t('pdf.planets_eyebrow'),
            planetsTitle: t('planets.heading'),
            planetsIntro: t('pdf.planets_intro'),
            colPlanet: t('planets.col_planet'),
            colSign: t('planets.col_sign'),
            colDegree: t('planets.col_degree'),
            colNakshatra: t('planets.col_nakshatra'),
            colHouse: t('pdf.house_short'),
            colDignity: t('planets.col_dignity'),
            colState: t('planets.col_state'),
            stateRetrograde: t('planets.retrograde'),
            lagnaRowName: t('pdf.lagna_row_name'),
            housesEyebrow: t('pdf.houses_eyebrow'),
            housesTitle: t('houses.heading'),
            housesIntro: t('pdf.houses_intro'),
            colHouseNumber: t('houses.col_house'),
            colHouseSign: t('houses.col_sign'),
            colHouseLord: t('houses.col_lord'),
            colOccupants: t('houses.col_occupants'),
            housesNote: t('houses.whole_sign_note'),
            chartsEyebrow: t('pdf.charts_eyebrow'),
            chartsTitle: t('charts.heading'),
            chartsIntro: t('pdf.charts_intro'),
            dashaEyebrow: t('pdf.dasha_eyebrow'),
            dashaTitle: t('dasha.heading'),
            dashaIntro: t('pdf.dasha_intro'),
            dashaCurrentLabel: t('pdf.dasha_current_label'),
            dashaCurrentMarker: t('pdf.dasha_current_marker'),
            dashaSequenceLabel: t('pdf.dasha_sequence_label'),
            yogasEyebrow: t('pdf.yogas_eyebrow'),
            yogasTitle: t('yogas.heading'),
            yogasIntro: t('pdf.yogas_intro'),
            narrativeEyebrow: t('pdf.narrative_eyebrow'),
            narrativeTitle: t('interpretation.heading'),
            narrativeIntro: t('pdf.narrative_intro'),
            narrativeAbsentNote: t('pdf.narrative_absent_note'),
          },
        };

        const nearCusp = cuspInfo(titleCaseSign(lagna.sign), lagna.sign_degrees, 3, lagna) !== null;
        const domainsCtx = hasPredictive ? settledPredictive.domainsCtx : undefined;
        const stabilityClaims = [
          ...sidereal.yogas.map((yoga) => ({
            claimId: yogaClaimId(yoga.name),
            houseDependent: yogaDependsOnHouses(yoga),
          })),
          ...(domainsCtx
            ? Object.keys(domainsCtx.forecasts).map((domain) => ({
                claimId: domainClaimId(domain),
                houseDependent: true,
              }))
            : []),
        ];
        const stability = reportStabilityMarkers(stabilityClaims, nearCusp);

        const assumptionsDelta = rectificationDelta(birth);
        const omittedValue = buildOmittedSectionsValue(
          { hasPredictive, hasRectification: Boolean(liveRectification) },
          {
            predictive: t('assumptions.omitted_predictive'),
            rectification: t('assumptions.omitted_rectification'),
          },
        );
        const assumptions = {
          chrome: {
            eyebrow: t('section_eyebrow', { index: sectionNumeral('assumptions') }),
            title: t('assumptions.heading'),
            intro: t('assumptions.intro'),
          },
          rows: [
            { label: t('assumptions.ayanamsa_label'), value: ayanamsaValueLabel },
            {
              label: t('assumptions.house_system_label'),
              value: t('assumptions.house_system_value'),
            },
            {
              label: t('assumptions.time_label'),
              value: assumptionsDelta
                ? t('assumptions.time_rectified', {
                    entered: assumptionsDelta.enteredLabel,
                    rectified: assumptionsDelta.rectifiedLabel,
                  })
                : t('assumptions.time_recorded'),
            },
            {
              label: t('assumptions.cusp_label'),
              value: cusp
                ? t('assumptions.cusp_near', {
                    degrees: cusp.degrees.toFixed(1),
                    sign: cusp.neighbourSign,
                  })
                : t('assumptions.cusp_clear'),
            },
            ...(omittedValue
              ? [{ label: t('assumptions.omitted_label'), value: omittedValue }]
              : []),
          ],
        };

        await downloadReportPdf({
          generatedAt: storedChart.astronomical_calculations?.calculation_timestamp ?? null,
          birth,
          lagna,
          chart: { ayanamsa_value: sidereal.ayanamsa_value, snapshot: sidereal.snapshot },
          sidereal,
          interpretation: freshProse.interpretation,
          audience,
          narrativeTitles: {
            currentSky: t('interpretation.current_sky'),
            strengths: t('interpretation.strengths'),
            challenges: t('interpretation.challenges'),
            lifeThemes: t('interpretation.life_themes'),
            roadAhead: t('interpretation.road_ahead'),
          },
          stability,
          formatStability: (marker) =>
            t(marker.holdsUnderBoth ? 'stability.stable' : 'stability.sensitive'),
          chrome,
          comprehensive: hasPredictive
            ? {
                translators: { tr: t, tp },
                transitCtx: settledPredictive.transitCtx,
                vargaCtxFull: settledPredictive.vargaCtxFull,
                strengthCtx: settledPredictive.strengthCtx,
                domainsCtx: settledPredictive.domainsCtx,
                domainStrengthReceipts: settledPredictive.rawContexts?.domain_strength_receipts,
                strengthSignerPublicKey: settledPredictive.rawContexts?.strength_signer_public_key,
              }
            : undefined,
          rectification: liveRectification
            ? buildRectificationPdf({
                record: liveRectification,
                events: supportingEvents.map((event) => ({
                  date: event.date,
                  category: event.category,
                  summary: event.summary ?? event.note,
                })),
                t,
              })
            : undefined,
          assumptions,
          evidence: buildEvidenceSection(
            buildEvidenceLedger(sidereal, freshProse.evidenceAnnotations),
            t,
            glyphSafe,
            {
              hasReading: Boolean(freshProse.interpretation),
              annotationError: freshProse.evidenceAnnotationError,
            },
          ),
          fileBaseName: t('pdf_title', { name: personName, date: isoDate(new Date()) }),
          locale: i18n.language,
        });
      } catch (err) {
        if (!controller.signal.aborted) {
          safeError('report.pdf_generation_failed', err);
          setPdfError(t('pdf_error'));
        }
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
        exportingRef.current = false;
        if (!controller.signal.aborted) {
          setIsExporting(false);
        }
      }
    })();
  }, [
    storedChart,
    sidereal,
    birth,
    profileId,
    activeProfileId,
    todayDay,
    ayanamsa,
    engineCtx,
    reportInterpretation,
    evidenceAnnotations,
    evidenceAnnotationError,
    audience,
    rectificationRecord,
    storedEvents,
    t,
    i18n.language,
    tp,
    ts,
  ]);

  return { exportPdf, pdfError, isExporting, canExport };
}

export default useReportPdfExport;
