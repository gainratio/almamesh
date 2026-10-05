/**
 * ProfileSettings Component — P5 local-first.
 *
 * Displays and allows editing of current birth details. Changes to core fields
 * (date, time, location) recompute the chart ENTIRELY in-browser via the
 * on-device engine and persist it to the local chart library. No backend.
 */

import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  appEvents,
  type LocalBirthInput,
  type PendingChangeField,
  type PendingChanges,
  type RegenerationScope,
  useProfilesStore,
  useRectificationRecordsStore,
} from '@almamesh/store';
import { TIME_CONFIDENCE, type TimeConfidence } from '@almamesh/constants';
import { LocationSearch } from '../../components/shared/LocationSearch';
import { type BirthDetails, birthDetailsFromBirthData } from './birthDetailsFromBirthData';
import { birthMetaFromDetails, planProfileSave, type ProfileSavePlan } from './planProfileSave';
import { RegenerationConfirmModal } from '../../components/features/settings/RegenerationConfirmModal';
import {
  BirthTimeComparison,
  type CandidateReading,
} from '../../components/features/settings/BirthTimeComparison';
import { Button } from '../../components/ui';
import { useSettingsStore } from '../../stores/settings';
import { useChartEngine } from '../../providers/AlmaMeshRuntimeProvider';
import { useLagnaPreview } from '../../hooks/useLagnaPreview';
import { readLocalPrimaryChart } from '../../lib/localChartRead';
import { formatDegree } from '../../lib/reportData';
import { rectificationDeltaFromClocks } from '../../lib/rectification';
import { cuspInfo } from '../../lib/lagnaCusp';
import { getUserFriendlyError } from '../../lib/errors';

// Constants for regeneration impact. Local-first: regeneration is free (runs
// on-device), so base_cost is 0 — kept for the scope-calculation contract.
const REGENERATION_FIELDS_METADATA: Record<string, { scope: RegenerationScope; base_cost: number }> = {
  birth_date: { scope: 'chart+interpretation', base_cost: 0 },
  birth_time: { scope: 'chart+interpretation', base_cost: 0 },
  birth_location: { scope: 'chart+interpretation', base_cost: 0 },
  // A rectified time changes the effective instant -> recompute the chart.
  rectified_time: { scope: 'chart+interpretation', base_cost: 0 },
};

const CONFIDENCE_KEYS = Object.keys(TIME_CONFIDENCE) as TimeConfidence[];

/** Minute deltas offered beside the rectified-time field. */
const MINUTE_STEPS: readonly number[] = [-5, -1, 1, 5];

/** Title-case an engine sign name for display ("aquarius"/"AQUARIUS" -> "Aquarius"). */
function titleCaseSign(sign: string): string {
  return sign.length === 0 ? sign : sign[0].toUpperCase() + sign.slice(1).toLowerCase();
}

/** Format an ISO confirmed-at timestamp as a localized date (falls back to raw). */
function formatRecordDate(iso: string, locale: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Shift an `HH:MM` clock by `deltaMinutes`, clamped to 00:00..23:59. Does NOT
 * roll the date — rectification nudges minutes within the birth day only.
 */
function shiftClockMinutes(clock: string, deltaMinutes: number): string {
  const [h, m] = clock.split(':').map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(h) || !Number.isFinite(m)) {
    return clock;
  }
  const clamped = Math.min(23 * 60 + 59, Math.max(0, h * 60 + m + deltaMinutes));
  const hh = String(Math.floor(clamped / 60)).padStart(2, '0');
  const mm = String(clamped % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

export default function ProfileSettings() {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation(['settings', 'common']);
  const { engine, error: engineError } = useChartEngine();
  const activeProfileId = useProfilesStore((s) => s.activeProfileId);

  // The standing read-only record of a CONFIRMED rectification for this profile
  // (written by the /rectify wizard). Null until one is confirmed; display-only.
  const rectificationRecord = useRectificationRecordsStore((s) =>
    activeProfileId ? (s.recordsByProfile[activeProfileId] ?? null) : null,
  );

  // Stores
  const {
    pendingChanges,
    setPendingChange,
    clearPendingChanges,
    isDirty,
    regenerationScope,
    estimatedCost,
    calculateRegenerationScope,
  } = useSettingsStore();

  // Local state
  const [initialDetails, setInitialDetails] = useState<BirthDetails | null>(null);
  // The stored primary chart's id: the identity a save is compared against.
  const [storedChartId, setStoredChartId] = useState<string | null>(null);
  // Why a save did not open the regenerate modal (never a false "Chart Updated!").
  const [saveNotice, setSaveNotice] = useState<Exclude<ProfileSavePlan, { kind: 'regenerate' }> | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewRetryAttempt, setPreviewRetryAttempt] = useState(0);
  const [regenerationStatus, setRegenerationStatus] = useState<'idle' | 'processing' | 'success' | 'error'>('idle');

  // Load initial data from the on-device chart library.
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    void (async () => {
      try {
        const chartData = await readLocalPrimaryChart();
        if (cancelled) return;
        if (chartData.success) {
          const birthData = chartData.chart_data?.birth_data;
          setStoredChartId(chartData.chart_id ?? null);
          if (birthData) {
            // Pure mapping: reconstructs the ENTERED time (birth_time_original)
            // and the RECTIFIED time (effective birth_datetime_local) as distinct
            // fields, so a rectified profile survives a reload without reverting.
            setInitialDetails(
              birthDetailsFromBirthData(birthData, chartData.person_name || ''),
            );
          }
        }
      } catch {
        if (!cancelled) setError(t('settings:profile.load_error'));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t]);

  // Sync regeneration scope when pending changes change
  useEffect(() => {
    calculateRegenerationScope(REGENERATION_FIELDS_METADATA);
  }, [pendingChanges, calculateRegenerationScope]);

  // Form Handlers
  const handleFieldChange = <K extends PendingChangeField>(field: K, value: PendingChanges[K]) => {
    setSaveNotice(null);
    setPendingChange(field, value);
  };

  const currentDetails: BirthDetails = {
    name: (pendingChanges.name !== undefined ? pendingChanges.name : initialDetails?.name) || '',
    birth_date: (pendingChanges.birth_date !== undefined ? pendingChanges.birth_date : initialDetails?.birth_date) || '',
    birth_time: (pendingChanges.birth_time !== undefined ? pendingChanges.birth_time : initialDetails?.birth_time) || '',
    location:
      (pendingChanges.birth_location !== undefined ? pendingChanges.birth_location : initialDetails?.location) ?? null,
    rectified_time:
      (pendingChanges.rectified_time !== undefined
        ? pendingChanges.rectified_time
        : initialDetails?.rectified_time) || '',
    time_confidence: (pendingChanges.time_confidence !== undefined
      ? pendingChanges.time_confidence
      : (initialDetails?.time_confidence ?? 'exact')) as TimeConfidence,
  };

  // Candidate birth for the LIVE, non-destructive lagna preview. Uses the
  // rectified time as the EFFECTIVE clock and converts through the SAME
  // `toBirthInput` the real chart path uses, so the birthplace-tz -> UTC
  // conversion is identical. Null until date + place are known.
  const previewInput: LocalBirthInput | null =
    currentDetails.birth_date && currentDetails.location
      ? {
          date: currentDetails.birth_date,
          time: currentDetails.birth_time,
          rectifiedTime: currentDetails.rectified_time || currentDetails.birth_time,
          latitude: currentDetails.location.lat,
          longitude: currentDetails.location.lon,
          timezone: currentDetails.location.timezone || 'UTC',
        }
      : null;
  const lagnaPreview = useLagnaPreview(engine, engineError, previewInput, previewRetryAttempt);
  const previewCusp =
    lagnaPreview.status === 'ready'
      ? cuspInfo(lagnaPreview.lagna.sign, lagnaPreview.lagna.signDegrees)
      : null;

  // Is a rectification actually in effect? Only then do we compute the
  // entered-time lagna (a SECOND, sequential engine read on the shared thread)
  // and compare rising signs — so we can honestly say "minutes flip your sign".
  const rectificationActive = Boolean(
    currentDetails.rectified_time &&
      currentDetails.rectified_time !== currentDetails.birth_time,
  );

  // The display-only adjustment summary ("entered 5:45 AM → using 6:00 AM
  // (+15 min)") for the rectification panel. Pure: it compares the two `HH:MM`
  // form clocks and formats them in the active locale — no astrology, no engine.
  // Same derivation the stored-data `rectificationDelta` uses (shared helper).
  const adjustmentInEffect =
    rectificationActive && currentDetails.birth_time && currentDetails.rectified_time
      ? rectificationDeltaFromClocks(currentDetails.birth_time, currentDetails.rectified_time)
      : null;

  // The entered-time lagna preview: identical input EXCEPT the effective clock is
  // the ENTERED birth time. Null (idle) unless a rectification is in effect, so
  // the unrectified path costs no extra engine call.
  const enteredPreviewInput: LocalBirthInput | null =
    rectificationActive && previewInput
      ? { ...previewInput, rectifiedTime: currentDetails.birth_time }
      : null;
  const enteredLagnaPreview = useLagnaPreview(
    engine,
    engineError,
    enteredPreviewInput,
    previewRetryAttempt,
  );
  const previewStates = [lagnaPreview.status, enteredLagnaPreview.status] as const;
  const rectificationPreviewPending =
    rectificationActive &&
    previewStates.some((status) => status === 'idle' || status === 'loading');
  const rectificationPreviewFailure = rectificationActive
    ? previewStates.includes('error')
      ? 'error'
      : previewStates.includes('unavailable')
        ? 'unavailable'
        : null
    : null;
  const rectificationPreviewBlocked =
    rectificationPreviewPending || rectificationPreviewFailure !== null;

  // The rising sign FLIPS when the rectified and entered lagnas land in different
  // signs. Both must be computed; when they match (or either is pending) no flip
  // is shown. Engine signs are Title-Case; compare case-insensitively.
  const enteredLagnaSign =
    enteredLagnaPreview.status === 'ready' ? enteredLagnaPreview.lagna.sign : null;
  const cuspFlip =
    lagnaPreview.status === 'ready' &&
    enteredLagnaSign !== null &&
    enteredLagnaSign.toLowerCase() !== lagnaPreview.lagna.sign.toLowerCase()
      ? {
          sign: titleCaseSign(lagnaPreview.lagna.sign),
          enteredSign: titleCaseSign(enteredLagnaSign),
        }
      : null;

  // The two candidate rising-sign readings for the AS-RECORDED vs RECTIFIED
  // comparison. Before any rectification the entered and rectified clocks are
  // identical, so the always-computed rectified preview doubles as the recorded
  // reading; once a rectification is in effect the dedicated entered-time preview
  // supplies the as-recorded sign. Both are the engine's own output (no
  // fabrication) — the same person at two candidate birth times.
  const recordedReading: CandidateReading | null = rectificationActive
    ? enteredLagnaPreview.status === 'ready'
      ? {
          time: currentDetails.birth_time,
          sign: enteredLagnaPreview.lagna.sign,
          signDegrees: enteredLagnaPreview.lagna.signDegrees,
        }
      : null
    : lagnaPreview.status === 'ready'
      ? {
          time: currentDetails.birth_time,
          sign: lagnaPreview.lagna.sign,
          signDegrees: lagnaPreview.lagna.signDegrees,
        }
      : null;
  const rectifiedReading: CandidateReading | null =
    lagnaPreview.status === 'ready'
      ? {
          time: currentDetails.rectified_time || currentDetails.birth_time,
          sign: lagnaPreview.lagna.sign,
          signDegrees: lagnaPreview.lagna.signDegrees,
        }
      : null;

  /** Nudge the rectified time by `delta` minutes (drives the debounced preview). */
  const stepRectifiedTime = (delta: number) => {
    const base = currentDetails.rectified_time || currentDetails.birth_time;
    if (!base) {
      return;
    }
    handleFieldChange('rectified_time', shiftClockMinutes(base, delta));
  };

  const handleSaveClick = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // A rectified time may cross the rising-sign boundary. Never open a modal
    // without knowing whether the mandatory sign-flip acknowledgement applies.
    // On slower engines both preview reads can still be in flight after input.
    if (rectificationPreviewBlocked) {
      setError(
        t(
          rectificationPreviewFailure === 'error'
            ? 'settings:profile.ascendant_error'
            : rectificationPreviewFailure === 'unavailable'
              ? 'settings:profile.ascendant_unavailable'
              : 'settings:profile.ascendant_calculating',
        ),
      );
      return;
    }

    if (!currentDetails.name.trim()) {
      setError(t('settings:profile.name_required'));
      return;
    }
    if (!currentDetails.birth_date) {
      setError(t('settings:profile.birth_date_required'));
      return;
    }
    if (!currentDetails.birth_time) {
      setError(t('settings:profile.birth_time_required'));
      return;
    }
    if (!currentDetails.location) {
      setError(t('settings:profile.birth_location_required'));
      return;
    }

    const plan = planProfileSave({
      initial: initialDetails ?? currentDetails,
      current: currentDetails,
      storedChartId,
    });
    if (plan.kind !== 'regenerate') {
      setSaveNotice(plan);
      return;
    }
    setShowConfirmModal(true);
  };

  const handleConfirmRegeneration = async () => {
    setShowConfirmModal(false);
    setRegenerationStatus('processing');
    setIsSaving(true);
    setError(null);

    try {
      if (engineError) {
        throw engineError;
      }
      if (!engine) {
        throw new Error(t('settings:profile.engine_starting'));
      }
      const birth = birthMetaFromDetails(currentDetails);

      // Single source of regeneration: emit the event. The one subscriber in
      // App.tsx recomputes on-device, replaces the primary (preserving
      // profile_id), deletes the orphan, and re-streams the interpretation.
      const profileId = useProfilesStore.getState().activeProfileId;
      appEvents.emit('birth-info-changed', { birth, profileId });

      clearPendingChanges();
      setRegenerationStatus('success');
    } catch (err) {
      setError(getUserFriendlyError('CHART_UPDATE_001', err, t('settings:profile.update_failed')));
      setRegenerationStatus('error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleResetForm = () => {
    clearPendingChanges();
    setSaveNotice(null);
    setError(null);
  };

  if (isLoading) {
    return (
      <div className="animate-pulse space-y-6">
        <div className="h-6 bg-background-tertiary rounded w-1/3" />
        <div className="space-y-4">
          <div className="h-16 bg-background-tertiary rounded" />
          <div className="h-16 bg-background-tertiary rounded" />
          <div className="h-16 bg-background-tertiary rounded" />
        </div>
      </div>
    );
  }

  // Success view
  if (regenerationStatus === 'success') {
    return (
      <div className="space-y-8 max-w-2xl mx-auto py-12">
        <div className="bg-background-secondary border border-ui-border rounded-xl p-8 text-center">
          <div className="w-16 h-16 mx-auto bg-status-success/20 rounded-full flex items-center justify-center mb-6">
            <svg className="h-8 w-8 text-status-success" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-text-primary mb-4">{t('settings:profile.success_title')}</h2>
          <p className="text-text-secondary mb-8">{t('settings:profile.success_description')}</p>
          <button
            onClick={() => navigate('/dashboard')}
            className="w-full py-3 bg-accent-gold text-background-primary font-bold rounded-lg hover:bg-accent-gold/90 transition-colors"
          >
            {t('settings:profile.view_new_chart')}
          </button>
        </div>
      </div>
    );
  }

  // Processing view
  if (regenerationStatus === 'processing') {
    return (
      <div className="space-y-8 max-w-2xl mx-auto py-12">
        <div className="bg-background-secondary border border-ui-border rounded-xl p-8 text-center">
          <div className="mb-4">
            <svg className="animate-spin h-12 w-12 mx-auto text-accent-gold" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-text-primary mb-2">{t('settings:profile.processing_title')}</h2>
          <p className="text-text-secondary text-sm">{t('settings:profile.processing_description')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Section Header */}
      <div className="border-b border-ui-border pb-4">
        <h2 className="text-xl font-semibold text-text-primary">{t('settings:profile.title')}</h2>
        <p className="text-text-secondary text-sm mt-1">{t('settings:profile.description')}</p>
      </div>

      <form onSubmit={handleSaveClick} className="space-y-6 max-w-xl">
        {/* Name */}
        <div>
          <label className="block text-sm font-medium text-text-primary mb-2">{t('settings:profile.full_name_label')}</label>
          <input
            type="text"
            value={currentDetails.name}
            onChange={(e) => handleFieldChange('name', e.target.value)}
            className="w-full px-4 py-2.5 bg-background-tertiary border border-ui-border rounded-lg text-text-primary focus:ring-2 focus:ring-accent-gold/50 outline-none"
            placeholder={t('settings:profile.full_name_placeholder')}
          />
        </div>

        {/* Birth Date & Time Row */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-sm font-medium text-text-primary mb-2">{t('settings:profile.birth_date_label')}</label>
            <input
              type="date"
              value={currentDetails.birth_date}
              onChange={(e) => handleFieldChange('birth_date', e.target.value)}
              className="w-full px-4 py-2.5 bg-background-tertiary border border-ui-border rounded-lg text-text-primary focus:ring-2 focus:ring-accent-gold/50 outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-2">{t('settings:profile.birth_time_label')}</label>
            <input
              type="time"
              value={currentDetails.birth_time}
              onChange={(e) => handleFieldChange('birth_time', e.target.value)}
              className="w-full px-4 py-2.5 bg-background-tertiary border border-ui-border rounded-lg text-text-primary focus:ring-2 focus:ring-accent-gold/50 outline-none"
            />
          </div>
        </div>

        {/* Birth-time rectification */}
        <div className="rounded-lg border border-ui-border bg-background-secondary/40 p-4">
          <h3 className="text-sm font-medium text-text-primary">{t('settings:profile.rectification_title')}</h3>
          <p className="text-text-muted text-xs mt-1 mb-3">{t('settings:profile.rectification_description')}</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label
                htmlFor="rectified-time"
                className="block text-xs font-medium text-text-secondary mb-2"
              >
                {t('settings:profile.rectified_time_label')}
              </label>
              <input
                id="rectified-time"
                type="time"
                value={currentDetails.rectified_time}
                onChange={(e) => handleFieldChange('rectified_time', e.target.value)}
                aria-describedby={currentDetails.rectified_time ? undefined : 'rectified-time-unset'}
                className="w-full px-4 py-2.5 bg-background-tertiary border border-ui-border rounded-lg text-text-primary focus:ring-2 focus:ring-accent-gold/50 outline-none"
              />
              {!currentDetails.rectified_time && (
                <p id="rectified-time-unset" className="text-text-muted text-xs mt-1">
                  {t('settings:profile.rectified_time_unset')}
                </p>
              )}
              <div className="mt-2 flex gap-2">
                {MINUTE_STEPS.map((delta) => (
                  <Button
                    key={delta}
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => stepRectifiedTime(delta)}
                    aria-label={t('settings:profile.adjust_minutes_aria', {
                      sign: delta > 0 ? '+' : '',
                      minutes: delta,
                    })}
                  >
                    {delta > 0 ? `+${delta}` : delta} {t('settings:profile.minutes_suffix')}
                  </Button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-2">{t('settings:profile.time_confidence_label')}</label>
              <select
                value={currentDetails.time_confidence}
                onChange={(e) => handleFieldChange('time_confidence', e.target.value)}
                className="w-full px-4 py-2.5 bg-background-tertiary border border-ui-border rounded-lg text-text-primary focus:ring-2 focus:ring-accent-gold/50 outline-none"
              >
                {CONFIDENCE_KEYS.map((key) => (
                  <option key={key} value={key}>
                    {t(`settings:time_confidence.${key}`)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Live Ascendant (Lagna) preview — non-destructive; does NOT persist. */}
          <div className="mt-4 rounded-md border border-ui-border bg-background-tertiary/50 px-3 py-2.5 text-sm">
            {lagnaPreview.status === 'ready' ? (
              <p className="text-text-primary">
                <span className="text-text-muted">{t('settings:profile.ascendant_label')}</span>
                <span className="font-medium">
                  {titleCaseSign(lagnaPreview.lagna.sign)} {formatDegree(lagnaPreview.lagna.signDegrees)}
                </span>
                <span className="text-text-muted"> · {lagnaPreview.lagna.nakshatra}</span>
              </p>
            ) : lagnaPreview.status === 'loading' ? (
              <p className="text-text-muted">{t('settings:profile.ascendant_calculating')}</p>
            ) : lagnaPreview.status === 'error' ? (
              <p className="text-status-warning">{t('settings:profile.ascendant_error')}</p>
            ) : lagnaPreview.status === 'unavailable' ? (
              <p className="text-text-muted">{t('settings:profile.ascendant_unavailable')}</p>
            ) : (
              <p className="text-text-muted">{t('settings:profile.ascendant_prompt')}</p>
            )}

            {previewCusp && (
              <p className="mt-1.5 text-xs text-status-warning">
                {t('settings:profile.cusp_warning', {
                  degrees: previewCusp.degrees.toFixed(1),
                  sign: previewCusp.neighbourSign,
                })}
              </p>
            )}

          </div>

          {/* The same chart at two candidate birth times — AS-RECORDED vs
              RECTIFIED rising signs, with the "every house shifts by one sign"
              stakes spelled out. Engine-grounded; renders only near a boundary
              or once a rectification crosses one. */}
          <BirthTimeComparison
            recorded={recordedReading}
            rectified={rectifiedReading}
            cusp={previewCusp}
          />

          {rectificationPreviewFailure && (
            <div
              data-testid="rectification-preview-failure"
              className="mt-3 flex items-center justify-between gap-3 rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2"
            >
              <p className="text-xs text-status-warning">
                {t(
                  rectificationPreviewFailure === 'error'
                    ? 'settings:profile.ascendant_error'
                    : 'settings:profile.ascendant_unavailable',
                )}
              </p>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setPreviewRetryAttempt((attempt) => attempt + 1)}
              >
                {t('common:actions.retry')}
              </Button>
            </div>
          )}

          {adjustmentInEffect && (
            <p
              className="mt-3 text-xs font-medium text-text-secondary"
              data-testid="adjustment-in-effect"
            >
              {t('settings:profile.adjustment_in_effect', {
                entered: adjustmentInEffect.enteredLabel,
                rectified: adjustmentInEffect.rectifiedLabel,
                sign: adjustmentInEffect.deltaMinutes > 0 ? '+' : '−',
                minutes: Math.abs(adjustmentInEffect.deltaMinutes),
              })}
            </p>
          )}

          {currentDetails.time_confidence !== 'exact' && (
            <p className="mt-3 text-xs text-text-muted">
              {t('settings:profile.confidence_hint', {
                confidence: t(
                  `settings:time_confidence.${currentDetails.time_confidence}`,
                ).toLowerCase(),
              })}
            </p>
          )}

          {activeProfileId != null && (
            <p className="mt-3 text-xs">
              <Link
                to={`/rectify/${activeProfileId}`}
                className="font-medium text-accent-primary underline underline-offset-2 hover:text-accent-gold-bright"
              >
                {t('settings:profile.life_events_refine_link')}
              </Link>
            </p>
          )}
        </div>

        {/* Your rectification — a read-only account of the last CONFIRMED
            rectification (was X → now Y), shown only once one exists. Pure
            display metadata: no engine input, no life-event narrative. */}
        {rectificationRecord && (
          <div
            data-testid="rectification-record"
            className="rounded-lg border border-ui-border bg-background-secondary/40 p-4"
          >
            <h3 className="text-sm font-medium text-text-primary">
              {t('settings:rectification_record.title')}
            </h3>
            <p className="mt-1 text-xs text-text-muted">
              {t('settings:rectification_record.confirmed_on', {
                date: formatRecordDate(rectificationRecord.confirmedAt, i18n.language),
              })}
            </p>
            <dl className="mt-3 space-y-1.5 text-sm">
              <div className="flex flex-wrap items-baseline gap-1.5">
                <dt className="text-text-muted">
                  {t('settings:rectification_record.sign_label')}
                </dt>
                <dd className="font-medium text-text-primary">
                  {rectificationRecord.originalSign
                    ? t('settings:rectification_record.sign_change', {
                        from: titleCaseSign(rectificationRecord.originalSign),
                        to: titleCaseSign(rectificationRecord.rectifiedSign),
                      })
                    : t('settings:rectification_record.sign_from_unknown', {
                        to: titleCaseSign(rectificationRecord.rectifiedSign),
                      })}
                </dd>
              </div>
              <div className="flex flex-wrap items-baseline gap-1.5">
                <dt className="text-text-muted">
                  {t('settings:rectification_record.time_label')}
                </dt>
                <dd className="font-medium text-text-primary">
                  {rectificationRecord.originalTime
                    ? t('settings:rectification_record.time_change', {
                        from: rectificationRecord.originalTime,
                        to: rectificationRecord.rectifiedTime,
                      })
                    : t('settings:rectification_record.time_from_unknown', {
                        to: rectificationRecord.rectifiedTime,
                      })}
                </dd>
              </div>
              <div className="flex flex-wrap items-baseline gap-1.5">
                <dt className="text-text-muted">
                  {t('settings:rectification_record.band_label')}
                </dt>
                <dd className="font-medium text-text-primary">
                  {t(`settings:rectification_record.band_${rectificationRecord.band}`)}
                </dd>
              </div>
              <div className="flex flex-wrap items-baseline gap-1.5">
                <dt className="text-text-muted">
                  {t('settings:rectification_record.method_label')}
                </dt>
                <dd className="font-medium text-text-primary">
                  {t(`settings:rectification_record.mode_${rectificationRecord.mode}`)}
                </dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-text-muted">
              {t('settings:rectification_record.events_informed', {
                count: rectificationRecord.supportingEventIds.length,
              })}
            </p>
            {activeProfileId != null && (
              <p className="mt-3 text-xs">
                <Link
                  to={`/rectify/${activeProfileId}`}
                  className="font-medium text-accent-primary underline underline-offset-2 hover:text-accent-gold-bright"
                >
                  {t('settings:rectification_record.rerun_link')}
                </Link>
              </p>
            )}
          </div>
        )}

        {/* Location */}
        <div>
          <label className="block text-sm font-medium text-text-primary mb-2">{t('settings:profile.location_label')}</label>
          <LocationSearch
            value={currentDetails.location}
            onChange={(loc) => handleFieldChange('birth_location', loc)}
            placeholder={t('settings:profile.location_placeholder')}
          />
          <p className="text-text-muted text-xs mt-2">{t('settings:profile.location_hint')}</p>
        </div>

        {/* Regeneration Warnings */}
        {isDirty && (
          <div className="p-4 bg-status-warning/10 border border-status-warning/30 rounded-lg">
            <div className="flex gap-3">
              <svg className="h-5 w-5 text-status-warning flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <div>
                <p className="text-sm font-medium text-status-warning">{t('settings:profile.regeneration_required_title')}</p>
                <p className="text-xs text-text-secondary mt-1">{t('settings:profile.regeneration_required_description')}</p>
              </div>
            </div>
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex gap-4 pt-4">
          <button
            type="submit"
            disabled={!isDirty || isSaving || rectificationPreviewBlocked}
            className="px-8 py-2.5 bg-accent-gold text-background-primary font-bold rounded-lg hover:bg-accent-gold/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {t('settings:profile.save_changes')}
          </button>
          {isDirty && (
            <button
              type="button"
              onClick={handleResetForm}
              className="px-6 py-2.5 border border-ui-border text-text-primary font-medium rounded-lg hover:bg-background-tertiary transition-colors"
            >
              {t('common:actions.cancel')}
            </button>
          )}
        </div>

        {saveNotice?.kind === 'rectification-governs' && (
          <div
            role="status"
            data-testid="rectification-governs-notice"
            className="p-4 bg-status-warning/10 border border-status-warning/30 rounded-lg text-sm text-text-primary"
          >
            <p>{t('settings:profile.rectification_governs', { time: saveNotice.rectifiedTime })}</p>
            <button
              type="button"
              data-testid="rectification-governs-clear"
              onClick={() => handleFieldChange('rectified_time', '')}
              className="mt-3 px-4 py-2 border border-ui-border rounded-lg font-medium hover:bg-background-tertiary transition-colors"
            >
              {t('settings:profile.rectification_governs_clear')}
            </button>
          </div>
        )}
        {saveNotice?.kind === 'unchanged' && (
          <p role="status" data-testid="save-unchanged-notice" className="text-text-secondary text-sm">
            {t('settings:profile.save_unchanged')}
          </p>
        )}

        {error && <p className="text-status-error text-sm mt-2">{error}</p>}
      </form>

      {/* Modal */}
      <RegenerationConfirmModal
        isOpen={showConfirmModal}
        onClose={() => setShowConfirmModal(false)}
        onConfirm={handleConfirmRegeneration}
        scope={regenerationScope}
        estimatedCost={estimatedCost}
        currentBalance={0}
        isProcessing={isSaving}
        signFlip={cuspFlip ? { from: cuspFlip.enteredSign, to: cuspFlip.sign } : null}
      />
    </div>
  );
}
