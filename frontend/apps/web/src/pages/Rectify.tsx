/**
 * Rectify — event-based birth-time rectification wizard.
 *
 * Step flow: intro → events → fit → results. The fit step first asks the
 * honest-window question ("how sure are you about the recorded time?" —
 * Spec 062; skipped for unknown-time profiles, which auto-scan the whole day)
 * and then runs the engine with `run(mode, spanMinutes?)`.
 *
 * On confirm: builds BirthMeta from stored chart + candidate's representative
 * time, opens RegenerationConfirmModal (with sign-flip gate when the ascendant
 * sign changes), then emits birth-info-changed and navigates to /dashboard.
 */
import { useState, useEffect, useMemo, type ReactElement } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  requestRegeneration,
  whenChartLibraryPersisted,
  type BirthMeta,
  buildRectificationRecord,
  isStructuredLifeEvent,
  useChartLibraryStore,
  useLifeEventsStore,
  useProfilesStore,
  useRectificationRecordsStore,
} from '@almamesh/store';
import type {
  ProcessedBirthData,
  RectificationCandidate,
  RectificationRecordEventSummary,
} from '@almamesh/shared-types';
import type { TimeConfidence } from '@almamesh/constants';
import { useRectification } from '../hooks/useRectification';
import { EventEntryStep } from '../components/features/rectify/EventEntryStep';
import { FitProgress } from '../components/features/rectify/FitProgress';
import { EngineWarming } from '../components/features/rectify/EngineWarming';
import { RectifyResults } from '../components/features/rectify/RectifyResults';
import {
  WindowSelector,
  type WindowChoice,
} from '../components/features/rectify/WindowSelector';
import { RegenerationConfirmModal } from '../components/features/settings/RegenerationConfirmModal';

type WizardStep = 'intro' | 'events' | 'fit' | 'results';

export function RectifyPage(): ReactElement {
  const { profileId = '' } = useParams<{ profileId: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation('rectify');

  const {
    state,
    engineReady,
    engineError,
    engineErrorCode,
    engineStage,
    missingBirth,
    warmingTimedOut,
    hasEnoughEvents,
    detectedMode,
    run,
    retry,
  } = useRectification(profileId);

  const initialStep: WizardStep =
    useLifeEventsStore.getState().getEvents(profileId).some(isStructuredLifeEvent)
      ? 'events'
      : 'intro';
  const [step, setStep] = useState<WizardStep>(initialStep);
  const [pendingCandidate, setPendingCandidate] = useState<RectificationCandidate | null>(null);
  const [showModal, setShowModal] = useState(false);
  // The confirmed rectification's chart write: the page stays until it lands.
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'error'>('idle');
  // Spec 062 honest-window choice: null until the user answers "how sure are
  // you about the recorded time?" (auto-filled for unknown-time profiles,
  // which have no recorded time to be sure about).
  const [windowChoice, setWindowChoice] = useState<WindowChoice | null>(null);

  // Transition fit → results once the engine finishes.
  useEffect(() => {
    if (step === 'fit' && state.status === 'ready') {
      setStep('results');
    }
  }, [step, state.status]);

  // ---------------------------------------------------------------------------
  // Derived values
  // ---------------------------------------------------------------------------

  const charts = useChartLibraryStore((s) => s.charts);

  /** True when the profile's stored chart has birth_time_confidence === 'unknown'.
   *  In that case the chart was computed from a noon placeholder — there is no
   *  real recorded time to compare against and no prior sign to flip from. */
  const isUnknownTime = useMemo(() => {
    const chart =
      Object.values(charts).find((c) => c.profile_id === profileId && c.is_primary) ??
      Object.values(charts).find((c) => c.profile_id === profileId);
    const birthData = chart?.birth_data as ProcessedBirthData | undefined;
    return (birthData?.birth_time_confidence as TimeConfidence | undefined) === 'unknown';
  }, [charts, profileId]);

  // Kick off the rectification when the fit step is active AND the honest
  // window is chosen. Unknown-time profiles have no recorded time to be sure
  // about, so their whole-day window choice is auto-filled (no extra click).
  // Only runs when the inputs are actually valid — when birth details are
  // missing or there are no structured events, the fit step shows an explicit
  // message instead, never a silent spinner. (run() records the mode+span even
  // while the engine warms, so a later retry recovers; the hook re-fires this
  // once the engine is ready because `run`'s identity changes.)
  useEffect(() => {
    if (step !== 'fit' || state.status !== 'idle' || missingBirth || !hasEnoughEvents) return;
    if (windowChoice == null) {
      if (isUnknownTime) setWindowChoice({ mode: detectedMode });
      return;
    }
    if (windowChoice.spanMinutes === undefined) {
      void run(windowChoice.mode);
    } else {
      void run(windowChoice.mode, windowChoice.spanMinutes);
    }
  }, [
    step,
    state.status,
    missingBirth,
    hasEnoughEvents,
    windowChoice,
    isUnknownTime,
    detectedMode,
    run,
  ]);

  const signFlip = useMemo(() => {
    // No sign to flip from when the user never entered a time.
    if (isUnknownTime) return null;
    if (pendingCandidate == null || state.result == null) return null;
    const { recordedTimeSign } = state.result;
    if (recordedTimeSign == null) return null;
    if (pendingCandidate.ascendantSign === recordedTimeSign) return null;
    return { from: recordedTimeSign, to: pendingCandidate.ascendantSign };
  }, [isUnknownTime, pendingCandidate, state.result]);

  const recordedReading = useMemo(() => {
    // Suppress the comparison entirely when there was never a recorded time.
    if (isUnknownTime) return null;
    if (state.result?.recordedTimeSign == null) return null;
    const chart =
      Object.values(charts).find((c) => c.profile_id === profileId && c.is_primary) ??
      Object.values(charts).find((c) => c.profile_id === profileId);
    const birthData = chart?.birth_data as ProcessedBirthData | undefined;
    const localDt = birthData?.birth_datetime_local ?? '';
    const enteredTime =
      birthData?.birth_time_original ?? localDt.split('T')[1]?.slice(0, 5) ?? '';
    // The working natal chart IS the recorded-time chart before confirmation —
    // its lagna carries the engine's actual in-sign degrees. Guard on the sign
    // matching the result's recordedTimeSign (engine Title-Case vs result
    // lowercase) so a mid-flow regeneration can never pair the wrong degrees
    // with the sign; when they disagree the degrees are OMITTED — never an
    // invented 0° that would misleadingly read as a cusp birth.
    const lagna = chart?.sidereal_chart?.lagna;
    const signDegrees =
      lagna != null && lagna.sign.toLowerCase() === state.result.recordedTimeSign.toLowerCase()
        ? lagna.sign_degrees
        : undefined;
    return {
      time: enteredTime,
      sign: state.result.recordedTimeSign,
      ...(signDegrees != null ? { signDegrees } : {}),
    };
  }, [isUnknownTime, state.result, profileId, charts]);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  function handleConfirm(candidate: RectificationCandidate): void {
    setPendingCandidate(candidate);
    setShowModal(true);
  }

  function handleModalConfirm(): void {
    if (pendingCandidate == null) return;

    const charts = useChartLibraryStore.getState().charts;
    const chart =
      Object.values(charts).find((c) => c.profile_id === profileId && c.is_primary) ??
      Object.values(charts).find((c) => c.profile_id === profileId);

    if (chart == null) return;
    const birthData = chart.birth_data as ProcessedBirthData | undefined;
    const loc = birthData?.birth_location_details;
    if (birthData == null || loc == null) return;

    const localDt = birthData.birth_datetime_local ?? '';
    const enteredTime =
      birthData.birth_time_original ?? localDt.split('T')[1]?.slice(0, 5) ?? '';
    const date = localDt.split('T')[0] ?? '';

    const profileName = useProfilesStore.getState().profiles[profileId]?.name ?? '';

    const birth: BirthMeta = {
      name: profileName,
      date,
      time: enteredTime,
      rectifiedTime: pendingCandidate.representativeTimeLocal,
      latitude: loc.latitude,
      longitude: loc.longitude,
      timezone: loc.timezone ?? 'UTC',
      location_name: loc.location_name ?? '',
    };

    // Persist a display-only record of THIS rectification before changing the
    // birth time, so Settings can show a standing "was X, now Y" account. The
    // chosen candidate's sign/time + the result's band/margin/mode are captured
    // alongside the structured events that informed the fit. v2 (Spec 062) also
    // snapshots the full in-memory adapted result and the events' own summaries
    // so the evidence story survives revisits — everything stays on-device
    // (canonical SQLite, local-first) and the record never feeds the engine.
    if (state.result != null) {
      const structuredEvents = useLifeEventsStore
        .getState()
        .getEvents(profileId)
        .filter(isStructuredLifeEvent);
      const eventSummaries: RectificationRecordEventSummary[] = structuredEvents.map((e) => ({
        id: e.id,
        date: e.date,
        // isStructuredLifeEvent guarantees a category (boolean guard, no narrowing).
        category: e.category!,
        ...(e.summary != null && e.summary !== '' ? { summary: e.summary } : {}),
      }));
      useRectificationRecordsStore.getState().setRecord(
        buildRectificationRecord({
          profileId,
          result: state.result,
          candidate: pendingCandidate,
          originalTime: enteredTime,
          structuredEventIds: structuredEvents.map((e) => e.id),
          confirmedAt: Date.now(),
          eventSummaries,
        }),
      );
    }

    setShowModal(false);
    setPendingCandidate(null);
    void applyRectifiedChart(birth, profileId);
  }

  // Wait for the new chart to be computed AND written before leaving: a reload
  // on the dashboard during the compute used to drop the rectified chart.
  async function applyRectifiedChart(birth: BirthMeta, owner: string): Promise<void> {
    setSaveState('saving');
    try {
      await requestRegeneration({ birth, profileId: owner });
      await whenChartLibraryPersisted();
    } catch {
      setSaveState('error');
      return;
    }
    setSaveState('idle');
    navigate('/dashboard');
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-semibold text-text-primary">{t('wizard.title')}</h1>

      {step === 'intro' && (
        <div data-testid="intro-step" className="flex flex-col gap-4">
          <h2 className="text-xl font-semibold text-text-primary">{t('intro.heading')}</h2>
          <p className="text-sm text-text-secondary">{t('intro.body')}</p>
          <p className="rounded-md border border-ui-border bg-background-secondary/40 p-4 text-xs text-text-muted">
            {t('intro.honesty')}
          </p>
          <button
            type="button"
            data-testid="intro-start-btn"
            onClick={() => setStep('events')}
            className="w-fit rounded-lg bg-accent-primary px-6 py-2 text-sm font-medium text-white"
          >
            {t('intro.start')}
          </button>
        </div>
      )}

      {step === 'events' && (
        <EventEntryStep profileId={profileId} onContinue={() => setStep('fit')} />
      )}

      {step === 'fit' && state.status !== 'ready' && (
        <div data-testid="fit-step" className="flex flex-col gap-4">
          {!missingBirth && hasEnoughEvents && (windowChoice != null || isUnknownTime) && (
            <h2 className="text-xl font-semibold text-text-primary">{t('fit.heading')}</h2>
          )}
          {state.status === 'error' ? (
            <>
              <p className="text-sm text-status-error">{t('fit.error_heading')}</p>
              {state.error != null && (
                <p className="break-words text-xs text-text-tertiary">{state.error}</p>
              )}
              <button
                type="button"
                onClick={() => void retry()}
                className="w-fit rounded-lg border border-ui-border px-4 py-2 text-sm"
              >
                {t('fit.retry')}
              </button>
            </>
          ) : missingBirth ? (
            <p
              data-testid="fit-missing-birth"
              className="text-sm leading-relaxed text-text-secondary"
            >
              {t('error.missing_birth')}
            </p>
          ) : !hasEnoughEvents ? (
            <div data-testid="fit-no-events" className="flex flex-col gap-3">
              <p className="text-sm leading-relaxed text-text-secondary">{t('error.no_events')}</p>
              <button
                type="button"
                onClick={() => setStep('events')}
                className="w-fit rounded-lg border border-ui-border px-4 py-2 text-sm"
              >
                {t('error.back_to_events')}
              </button>
            </div>
          ) : windowChoice == null && !isUnknownTime ? (
            /* Spec 062: the honest-window question — the fit starts only after
               the user states how sure they are about the recorded time. */
            <WindowSelector
              defaultId={detectedMode === 'cusp' ? 'as_recorded' : 'whole_day'}
              onStart={setWindowChoice}
            />
          ) : engineError !== null || !engineReady ? (
            <EngineWarming
              engineError={engineError}
              engineErrorCode={engineErrorCode}
              timedOut={warmingTimedOut}
              engineStage={engineStage}
              onRetry={() => void retry()}
            />
          ) : (
            <FitProgress onRetry={() => void retry()} />
          )}
        </div>
      )}

      {saveState === 'saving' && (
        <p
          data-testid="rectify-saving"
          role="status"
          className="mb-4 rounded-md border border-accent-gold/40 bg-background-secondary/40 p-4 text-sm text-text-primary"
        >
          {t('status.saving_chart')}
        </p>
      )}
      {saveState === 'error' && (
        <p
          data-testid="rectify-save-error"
          role="alert"
          className="mb-4 rounded-md border border-red-500/40 bg-red-500/10 p-4 text-sm text-text-primary"
        >
          {t('error.save_failed')}
        </p>
      )}

      {step === 'results' && state.result != null && saveState !== 'saving' && (
        <RectifyResults
          result={state.result}
          recordedReading={recordedReading}
          onConfirm={handleConfirm}
          onKeepRecorded={() => navigate('/dashboard')}
        />
      )}

      <RegenerationConfirmModal
        isOpen={showModal}
        onClose={() => {
          setShowModal(false);
          setPendingCandidate(null);
        }}
        onConfirm={handleModalConfirm}
        scope="chart+interpretation"
        estimatedCost={0}
        signFlip={signFlip}
      />
    </div>
  );
}

export default RectifyPage;
