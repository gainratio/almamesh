import React, { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  appEvents,
  type BirthMeta,
  type LifeEventInput,
  useLifeEventsStore,
  useProfilesStore,
} from "@almamesh/store";
import {
  TIME_CONFIDENCE_ORDER,
  timeConfidenceMargin,
  type TimeConfidence,
} from "@almamesh/constants";
import { useChartEngine } from "../providers/AlmaMeshRuntimeProvider";
import { LocationSearch, type LocationResult } from "../components/shared/LocationSearch";
import { Logo } from "../components/ui/Logo";
import { BirthDatePicker } from "../components/BirthDatePicker";
import { EngineBootProgress } from "../components/EngineBootProgress";
import { TimePicker } from "../components/TimePicker";
import { useOnboardingStore } from "../stores/onboarding";
import { getUserFriendlyError, getEngineWarmingMessage } from "../lib/errors";
import { resolveReadyEngine } from "../lib/resolveReadyEngine";
import { resetAppData } from "../lib/resetAppData";
import { engineErrorCode, ROLLBACK_CODE } from "../lib/engineLifecycle";
import { RollbackResetGuard } from "../components/RollbackResetGuard";
import { incompleteDatabases, ResetIncompleteNotice } from "../components/ResetIncompleteNotice";
import { prepareOnboardingLifeEvents } from "../lib/onboardingLifeEvents";
import {
  isAiUsable,
  resolveConfig,
  toPromptLanguage,
} from "../components/features/rectify/rectifyLlmConfig";

/**
 * Sentinel marking a transient "engine still warming up" condition (the
 * in-browser Pyodide engine has not finished bootstrapping yet). Distinct from a
 * genuine compute failure so the catch can show a retryable message instead of
 * the generic CHART_GEN_001.
 */
class EngineWarmingError extends Error {
  constructor(message = "The on-device engine is still warming up.") {
    super(message);
    this.name = "EngineWarmingError";
  }
}

/**
 * Sentinel marking a genuine engine BOOTSTRAP failure (a reboot/re-sync that
 * itself failed: a stale/inconsistent bundle chunk, a signature/sha256 mismatch,
 * a Pyodide boot crash). Unlike a birth-DATA error, the user's inputs are fine —
 * so the catch keeps them on the generating error CARD (Retry re-bootstraps,
 * "Reset & reload" clears the cache) instead of bouncing back to edit location.
 */
class EngineBootstrapError extends Error {
  constructor(cause: unknown) {
    // Keep the cause: its EngineOperationError.code (e.g. "rollback") decides
    // whether the reset needs the tampering warning + confirm.
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "EngineBootstrapError";
  }
}

type OnboardingStep = "name" | "birth-date" | "birth-location" | "birth-time" | "life-events" | "generating";

// Event-type keys (labels resolved via i18n at render time) that help with rectification
const HELPFUL_EVENT_TYPE_KEYS = [
  "marriage",
  "children",
  "career_changes",
  "relocations",
  "graduations",
  "property_purchases",
] as const;

// Generation steps for progress display. Labels are resolved via i18n at render
// time from each step's stable id; only the timing lives here.
const GENERATION_STEPS = [
  { id: 'positions', duration: 2000 },
  { id: 'houses', duration: 1500 },
  { id: 'yogas', duration: 2000 },
  { id: 'dashas', duration: 1500 },
  { id: 'interpretation', duration: 15000 },
] as const;

// Map step number to step key
const STEP_KEYS: OnboardingStep[] = ["name", "birth-date", "birth-location", "birth-time", "life-events"];

export default function OnboardingPage() {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation(["onboarding", "common"]);

  // Example narratives to guide users (translated; natural per-locale phrasing).
  const examplePrompts = t("life_events.examples", { returnObjects: true }) as string[];

  // The single in-browser chart engine, owned by AlmaMeshRuntimeProvider.
  // Generation no longer THROWS when the engine is still booting or has
  // fail-closed: `resolveReadyEngine` awaits the in-flight boot (warming race)
  // or reboots (re-syncs) a failed one, so the user no longer has to manually
  // retry. The slow path simply waits behind the existing progress UI.
  // `stage` is deliberately NOT read here: byte-level progress is drawn by
  // <EngineBootProgress>, which subscribes on its own, so a progress report
  // never re-renders this page (or the birth-date field on it).
  const { engine, error: engineError, reboot, whenReady, startBootstrap, lastProgressAt } =
    useChartEngine();

  // Engine-dependent route: ensure the bootstrap is running on entry. The
  // provider gates its mount auto-boot off the marketing landing route, so a
  // user who arrives here straight from the landing CTA still warms the engine
  // immediately. Idempotent — a no-op if a boot is already in flight.
  useEffect(() => {
    startBootstrap();
  }, [startBootstrap]);

  // Use Zustand store for state management and persistence
  const {
    currentStep,
    data,
    isLoading,
    isSaving,
    error,
    setName,
    setBirthDate,
    setBirthTime,
    setLocation,
    nextStep,
    prevStep,
    setLoading,
    setError,
    reset,
    isStepValid,
    getFormattedBirthData,
  } = useOnboardingStore();

  // Local state for UI-only concerns
  const [currentStepKey, setCurrentStepKey] = React.useState<OnboardingStep>("name");
  const [generationStep, setGenerationStep] = React.useState(0);
  // Stable engine failure code of the last failed bootstrap (not the message).
  const [bootFailureCode, setBootFailureCode] = React.useState<string | null>(null);
  const [resetIncomplete, setResetIncomplete] = React.useState<readonly string[] | null>(null);
  const [narrative, setNarrative] = React.useState("");
  const [extractedEvents, setExtractedEvents] = React.useState<LifeEventInput[]>([]);
  // The captured events as a ref so the (possibly stale) generation closure
  // reached via setTimeout always persists the LATEST notes, not the empty set
  // present when the "Save & Continue" button was first clicked.
  const capturedEventsRef = React.useRef<LifeEventInput[]>([]);
  const [isExtracting, setIsExtracting] = React.useState(false);
  const [extractionFeedback, setExtractionFeedback] = React.useState("");
  // i18n-correctness: drive the feedback styling off a language-independent
  // status enum, NOT off the contents of `extractionFeedback`. The feedback text
  // is translated (es/pt won't contain English words like "Found"/"Unable"), so
  // inspecting the string would silently mis-color the banner in non-English UIs.
  type FeedbackStatus = "success" | "error" | "info" | null;
  const [feedbackStatus, setFeedbackStatus] = React.useState<FeedbackStatus>(null);
  // Set message + status together so the two can never drift apart.
  const setFeedback = React.useCallback(
    (message: string, status: FeedbackStatus) => {
      setExtractionFeedback(message);
      setFeedbackStatus(status);
    },
    [],
  );

  // NOTE: The idempotency check (redirect if user has chart) is now handled by
  // the OnboardingRoute guard in App.tsx. This page can assume the user does NOT have a chart.
  // Loading state has been removed since the route guard handles it.

  // The wizard already knows WHOSE chart this is — stop asking for the name.
  //
  // Every route in leaves an ACTIVE profile behind (the chart-less dashboard's
  // "Add birth details" link, the header switcher, Settings → People, a pasted
  // URL), but the wizard reads a DIFFERENT store whose `name` starts empty.
  // Seeding here is the one seam that covers all of them, including the plain
  // links that pass through no form at all.
  //
  // Seeded ONLY when the wizard's name is empty. The onboarding store is
  // in-memory with NO persistence and `reset()` runs only after a chart is
  // generated, so a non-empty name is always one THIS session typed — never
  // overwrite it. Reading through `getState()` inside a mount-only effect also
  // means clearing the field later cannot re-fire the seed and fight the edit.
  useEffect(() => {
    const onboarding = useOnboardingStore.getState();
    if (onboarding.data.name.trim() !== "") {
      return;
    }
    const { activeProfileId, profiles } = useProfilesStore.getState();
    const activeName = activeProfileId ? profiles[activeProfileId]?.name : undefined;
    if (activeName) {
      onboarding.setName(activeName);
    }
  }, []);

  // Sync currentStep from store to local step key
  useEffect(() => {
    if (currentStep >= 1 && currentStep <= STEP_KEYS.length) {
      setCurrentStepKey(STEP_KEYS[currentStep - 1]);
    }
  }, [currentStep]);

  // IDEMPOTENCY CHECK: Now handled by OnboardingRoute guard in App.tsx
  // The route guard checks onboarding progress and redirects to /dashboard if has_chart=true.
  //
  // P5 local-first: there is no backend to sync onboarding progress to or resume
  // from. Onboarding state lives only in the in-memory store for this session;
  // the chart is computed on-device at the end of the flow.

  const steps: { key: OnboardingStep; label: string }[] = [
    { key: "name", label: t("steps.name") },
    { key: "birth-date", label: t("steps.birth_date") },
    { key: "birth-location", label: t("steps.location") },
    { key: "birth-time", label: t("steps.birth_time") },
    { key: "life-events", label: t("steps.life_events") },
  ];

  const currentStepIndex = steps.findIndex((s) => s.key === currentStepKey);
  const progressPercent = ((currentStepIndex + 1) / steps.length) * 100;

  const handleNext = () => {
    const stepOrder: OnboardingStep[] = ["name", "birth-date", "birth-location", "birth-time", "life-events"];
    const stepIndex = stepOrder.indexOf(currentStepKey);
    if (stepIndex < stepOrder.length - 1) {
      nextStep(); // This will trigger save via the store
      setCurrentStepKey(stepOrder[stepIndex + 1]);
    } else if (currentStepKey === "life-events") {
      // On the last step, trigger chart generation
      handleGenerateChart();
    }
  };

  const handleBack = () => {
    const stepOrder: OnboardingStep[] = ["name", "birth-date", "birth-location", "birth-time", "life-events"];
    const stepIndex = stepOrder.indexOf(currentStepKey);
    if (stepIndex > 0) {
      prevStep();
      setCurrentStepKey(stepOrder[stepIndex - 1]);
    }
  };

  // Handle form value changes
  const handleNameChange = (value: string) => {
    setName(value);
  };

  const handleBirthDatePickerChange = (date: Date | null) => {
    // BirthDatePicker buffers in-progress edits internally and only emits
    // complete, in-range dates — incomplete edits (including cleared
    // sections) never reach this handler. The null guard is defensive: the
    // store setter is non-null and canProceed gates Continue on birthDate.
    if (date) {
      setBirthDate(date);
    }
  };

  const handleBirthTimeChange = (value: string) => {
    // Preserve the user's chosen confidence (defaults to 'exact') — the time
    // and its confidence are captured separately in this step.
    setBirthTime(value, data.timeConfidence);
  };

  const handleConfidenceChange = (confidence: TimeConfidence) => {
    setBirthTime(data.birthTime, confidence);
  };

  const handleLocationChange = (location: LocationResult | null) => {
    if (location) {
      setLocation({
        city: location.city,
        state: location.state || '',
        country: location.country || '',
        latitude: location.lat,
        longitude: location.lon,
        // The offline lookup always resolves an IANA timezone; persist it so
        // toBirthInput (which fails closed without one) can build birth data.
        timezone: location.timezone,
      });
    }
  };

  // Convert prose into typed rows. Configured AI uses the same allowlisted
  // structurer as rectification; otherwise a conservative deterministic parser
  // stays entirely on-device. Unrecognized prose remains one manual draft.
  const handleExtractEvents = async () => {
    // If already captured, just navigate to next step
    if (extractedEvents.length > 0) {
      handleNext();
      return;
    }

    if (narrative.trim().length < 20) {
      setFeedback(t("life_events.min_length_error"), "error");
      return;
    }

    setIsExtracting(true);
    setFeedback("", null);

    const captured = [
      ...(await prepareOnboardingLifeEvents(narrative, {
        aiConfigured: isAiUsable(),
        config: resolveConfig(),
        language: toPromptLanguage(i18n.language),
      })),
    ];
    capturedEventsRef.current = captured;
    setExtractedEvents(captured);
    setFeedback(t("life_events.saved_feedback"), "success");
    setIsExtracting(false);
    // Navigate to next step after brief delay to show feedback
    setTimeout(() => {
      handleNext();
    }, 1500);
  };

  // Skip life events step
  const handleSkipLifeEvents = () => {
    setNarrative("");
    capturedEventsRef.current = [];
    setExtractedEvents([]);
    setFeedback("", null);
    handleNext();
  };

  // Use an example narrative
  const handleUseExample = (example: string) => {
    setNarrative(example);
    setFeedback("", null);
    capturedEventsRef.current = [];
    setExtractedEvents([]);
  };

  /**
   * Generate the chart entirely in-browser: convert the collected birth data to
   * the engine's BirthInput, compute the SiderealChart on-device, adapt it to
   * the UI's ChartData, and persist it to the local chart library. No backend.
   */
  const handleGenerateChart = async () => {
    setCurrentStepKey("generating");
    setLoading(true);
    setError(null);
    setGenerationStep(0);

    try {
      const birthData = getFormattedBirthData();
      if (!birthData) {
        throw new Error(t("errors:missing_birth_data"));
      }
      if (!birthData.timezone) {
        throw new Error(t("errors:missing_timezone"));
      }

      // Resolve a READY engine before computing — this is the fix for the
      // "Connection Issue" race AND a fail-closed bootstrap:
      //   - engine ready        -> use it,
      //   - bootstrap failed     -> reboot() (a fresh sync + boot),
      //   - still warming (race) -> whenReady() (await the in-flight boot).
      // It no longer throws the instant the user clicks before boot finishes;
      // the slow path simply WAITS behind the progress UI, then proceeds. A
      // wedged boot eventually times out into the retryable warming message.
      try {
        await resolveReadyEngine({ engine, error: engineError, reboot, whenReady, lastProgressAt });
      } catch (readyErr) {
        if (readyErr instanceof Error && readyErr.name === "EngineNotReadyError") {
          // Bounded wait elapsed — transient, retryable. Distinct from a compute
          // failure so the catch shows the warming message, not CHART_GEN_001.
          throw new EngineWarmingError();
        }
        // A reboot/re-sync that itself failed — keep the user on the recovery
        // card (Retry re-bootstraps, Reset & reload clears the cached bundle).
        throw new EngineBootstrapError(readyErr);
      }

      // Advance the visible progress while the engine computes (deterministic,
      // fast once warm — the steps are illustrative of the work happening).
      const progressInterval = setInterval(() => {
        setGenerationStep((prev) =>
          prev < GENERATION_STEPS.length - 1 ? prev + 1 : prev
        );
      }, 800);

      try {
        const birth: BirthMeta = {
          name: birthData.name,
          date: birthData.date,
          time: birthData.time,
          latitude: birthData.latitude,
          longitude: birthData.longitude,
          timezone: birthData.timezone,
          location_name: birthData.location_name ?? "",
          // Honest uncertainty: carry the user's birth-time confidence onto the
          // stored chart's birth details (birth_time_confidence) so cusp/
          // confidence displays and manual rectification know how exact it is.
          timeConfidence: data.timeConfidence,
        };

        // Tag the chart with the active profile so it belongs to the right
        // person on a shared device. If nobody has a profile yet (first run),
        // create a default one named for this birth and make it active.
        const profilesState = useProfilesStore.getState();
        const profileId =
          profilesState.activeProfileId ?? profilesState.createProfile(birth.name || "Me");

        // Persist the captured life-event notes for this profile so they survive
        // and can seed the future manual birth-time rectification (the app never
        // auto-matches them — they are the user's own reference points).
        const capturedEvents = capturedEventsRef.current;
        if (capturedEvents.length > 0) {
          useLifeEventsStore.getState().setEvents(profileId, capturedEvents);
        }

        // Single source of regeneration: the one subscriber in App.tsx computes
        // on-device, saves the primary (with profile_id), and re-streams.
        appEvents.emit("birth-info-changed", { birth, profileId });

        clearInterval(progressInterval);

        reset();
        const destination = data.timeConfidence === 'unknown' ? `/rectify/${profileId}` : '/dashboard';
        navigate(destination);
      } catch (err) {
        clearInterval(progressInterval);
        throw err;
      }
    } catch (err) {
      if (err instanceof EngineWarmingError) {
        // Transient "engine still warming" race — show a retryable message and
        // keep the user on the generating screen (which offers Retry + Reset).
        setError(getEngineWarmingMessage(err));
      } else if (err instanceof EngineBootstrapError) {
        // The engine bootstrap (re-sync/boot) failed — the user's birth data is
        // fine, so STAY on the generating error card where Retry re-bootstraps
        // and "Reset & reload" clears a corrupt cached bundle. Bouncing back to
        // edit location would hide the only in-app recovery from the user.
        setBootFailureCode(engineErrorCode(err));
        setError(getUserFriendlyError('CHART_GEN_001', err, 'Engine bootstrap failed'));
      } else {
        // Genuine compute/setup failure tied to the inputs — send the user back
        // to fix their birth details.
        setError(getUserFriendlyError('CHART_GEN_001', err, 'Chart generation failed'));
        setCurrentStepKey("birth-location");
      }
    } finally {
      setLoading(false);
    }
  };

  const canProceed = () => {
    switch (currentStepKey) {
      case "name":
        return isStepValid(1);
      case "birth-date":
        return isStepValid(2);
      case "birth-location":
        return isStepValid(3); // Location validation (city required)
      case "birth-time":
        return isStepValid(4); // Time validation
      case "life-events":
        // Life events step has its own buttons, but check for narrative if proceeding
        return narrative.trim().length >= 20;
      default:
        return false;
    }
  };

  // Computed values from store
  const birthLocationValue: LocationResult | null = data.city ? {
    displayName: [data.city, data.state, data.country].filter(Boolean).join(', '),
    city: data.city,
    state: data.state,
    country: data.country,
    lat: data.latitude || 0,
    lon: data.longitude || 0,
    timezone: data.timezone,
  } : null;

  // Handler to navigate to dashboard (used when polling fails but chart may be ready)
  const handleGoToDashboard = () => {
    reset();
    navigate("/dashboard");
  };

  // Handler to retry chart generation. Goes through the recovering path:
  // handleGenerateChart now reboots (re-syncs) a failed engine, so Retry
  // actually re-bootstraps rather than re-throwing the same cached error.
  const handleRetryGeneration = () => {
    setError(null);
    setBootFailureCode(null);
    handleGenerateChart();
  };

  // The bulletproof escape hatch for a stranded boot (corrupt cached bundle /
  // a RollbackError against the durable OPFS floor / stale service worker):
  // wipe every stale-state source, including the OPFS bundle cache, then reload
  // into a clean boot. Explicit click only — never automatic. Reuses the shared
  // resetAppData util (same as ErrorBoundary).
  const handleResetAppData = () => {
    setResetIncomplete(null);
    void resetAppData().then(
      () => window.location.reload(),
      (error: unknown) => setResetIncomplete(incompleteDatabases(error)),
    );
  };

  const renderStep = () => {
    if (currentStepKey === "generating") {
      const genProgressPercent = ((generationStep + 1) / GENERATION_STEPS.length) * 100;

      // Show error state with recovery options
      if (error) {
        return (
          <div className="py-8">
            {/* Error Header */}
            <div className="text-center mb-8">
              <div className="mb-4">
                <svg className="h-12 w-12 mx-auto text-yellow-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <h2 className="text-2xl font-bold text-text-primary mb-2">{t("error.title")}</h2>
              <p className="text-text-secondary text-sm">
                {error || t("error.default_body")}
              </p>
            </div>

            {/* Recovery Options */}
            <div className="space-y-3 mt-6">
              <button
                onClick={handleGoToDashboard}
                className="w-full py-3 bg-accent-gold text-background-primary font-semibold rounded-lg hover:bg-accent-gold/90 transition-colors"
                data-testid="go-to-dashboard-button"
              >
                {t("error.go_to_dashboard")}
              </button>
              <button
                onClick={handleRetryGeneration}
                className="w-full py-3 border border-ui-border text-text-primary font-semibold rounded-lg hover:bg-background-tertiary transition-colors"
                data-testid="retry-generation-button"
              >
                {t("error.retry_generation")}
              </button>
            </div>

            {/* Help Text */}
            <p className="text-text-muted text-xs text-center mt-4">
              {t("error.help")}
            </p>

            {/* Guaranteed in-app recovery: clears the cached engine bundle +
                stale SW/caches/storage, then reloads. The escape hatch for a
                corrupt-cache / permanently-stuck bootstrap. */}
            <div className="mt-6 pt-4 border-t border-ui-border/50">
              <p className="text-text-muted text-xs text-center mb-2">
                {t("error.reset_hint")}
              </p>
              {/* A rollback refusal may be tampering: warn + two-step confirm
                  before a reset that drops the anti-rollback floor. */}
              <RollbackResetGuard
                rollback={
                  bootFailureCode === ROLLBACK_CODE ||
                  engineErrorCode(engineError) === ROLLBACK_CODE
                }
                onReset={handleResetAppData}
                renderTrigger={(onClick) => (
                  <button
                    onClick={onClick}
                    className="w-full py-2 text-red-400 border border-red-500/40 rounded-lg hover:bg-red-500/10 transition-colors text-sm"
                    data-testid="reset-app-data-button"
                  >
                    {t("error.reset_and_reload")}
                  </button>
                )}
              />
              {resetIncomplete !== null && <ResetIncompleteNotice databases={resetIncomplete} />}
            </div>
          </div>
        );
      }

      return (
        <div className="py-8">
          {/* Header */}
          <div className="text-center mb-8">
            <div className="mb-4">
              <svg className="animate-spin h-12 w-12 mx-auto text-accent-gold" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            </div>
            <h2 className="text-2xl font-bold text-text-primary mb-2">{t("generating.title")}</h2>
            <p className="text-text-secondary text-sm">
              {t("generating.subtitle")}
            </p>
            {/* When the on-device engine is still booting, the Generate click
                now WAITS for it (instead of failing) — tell the user so the
                extra few seconds on a cold start don't read as a hang. */}
            {!engine && (
              <p className="text-text-muted text-xs mt-2" data-testid="still-warming-hint">
                {t("error.still_warming")}
              </p>
            )}
            {/* A real number while the engine downloads (bundle bytes, then the
                Pyodide runtime): on a slow link this takes minutes, and a bar
                that moves reads as slow, not stuck. */}
            {!engine && <EngineBootProgress />}
          </div>

          {/* Progress Bar */}
          <div className="mb-6">
            <div className="h-2 bg-background-tertiary rounded-full overflow-hidden">
              <div
                className="h-full bg-accent-gold transition-all duration-1000 ease-out"
                style={{ width: `${genProgressPercent}%` }}
              />
            </div>
            <p className="text-text-muted text-xs text-right mt-1">
              {t("generating.step_counter", {
                current: generationStep + 1,
                total: GENERATION_STEPS.length,
              })}
            </p>
          </div>

          {/* Steps List */}
          <div className="space-y-3">
            {GENERATION_STEPS.map((step, index) => {
              const isComplete = index < generationStep;
              const isCurrent = index === generationStep;

              return (
                <div
                  key={step.id}
                  className={`flex items-center gap-3 p-3 rounded-lg transition-all duration-300 ${isCurrent
                      ? 'bg-accent-gold/10 border border-accent-gold/30'
                      : isComplete
                        ? 'bg-background-tertiary/50'
                        : 'opacity-50'
                    }`}
                >
                  {/* Status Icon */}
                  <div className="flex-shrink-0">
                    {isComplete ? (
                      <svg className="h-5 w-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    ) : isCurrent ? (
                      <svg className="animate-spin h-5 w-5 text-accent-gold" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                    ) : (
                      <div className="h-5 w-5 rounded-full border-2 border-ui-border" />
                    )}
                  </div>

                  {/* Step Label */}
                  <span className={`text-sm ${isCurrent
                      ? 'text-text-primary font-medium'
                      : isComplete
                        ? 'text-text-secondary'
                        : 'text-text-muted'
                    }`}>
                    {t(`generating.steps.${step.id}`)}
                  </span>
                </div>
              );
            })}
          </div>

        </div>
      );
    }

    switch (currentStepKey) {
      case "name":
        return (
          <div className="space-y-6">
            <div className="text-center mb-8">
              <h2 className="text-2xl font-bold text-text-primary mb-2">{t("name.title")}</h2>
              <p className="text-text-secondary">{t("name.subtitle")}</p>
            </div>
            <input
              type="text"
              value={data.name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder={t("name.placeholder")}
              className="w-full px-4 py-4 bg-background-tertiary border border-ui-border rounded-lg text-text-primary text-lg placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent-gold/50"
              autoFocus
              data-testid="name-input"
            />
          </div>
        );

      case "birth-date":
        return (
          <div className="space-y-6">
            <div className="text-center mb-8">
              <h2 className="text-2xl font-bold text-text-primary mb-2">{t("birth_date.title")}</h2>
              <p className="text-text-secondary">{t("birth_date.subtitle")}</p>
            </div>
            <div data-testid="birth-date-input">
              <BirthDatePicker
                value={data.birthDate}
                onChange={handleBirthDatePickerChange}
              />
            </div>
          </div>
        );

      case "birth-time":
        return (
          <div className="space-y-6">
            <div className="text-center mb-8">
              <h2 className="text-2xl font-bold text-text-primary mb-2">{t("birth_time.title")}</h2>
              <p className="text-text-secondary">{t("birth_time.subtitle")}</p>
            </div>

            {/* Location & Timezone Summary */}
            {data.city && (
              <div className="bg-background-tertiary border border-ui-border rounded-lg p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-text-muted text-xs uppercase tracking-wide mb-1">{t("birth_time.location_label")}</p>
                    <p className="text-text-primary font-medium">
                      {[data.city, data.state, data.country].filter(Boolean).join(', ')}
                    </p>
                  </div>
                  {data.timezone && (
                    <div className="text-right">
                      <p className="text-text-muted text-xs uppercase tracking-wide mb-1">{t("birth_time.timezone_label")}</p>
                      <p className="text-accent-gold font-medium">{data.timezone}</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            <div data-testid="birth-time-input">
              <TimePicker
                value={data.birthTime}
                onChange={(time) => handleBirthTimeChange(time)}
              />
            </div>

            {/* Birth-time confidence — honest about how exact this time is.
                Feeds the chart's birth_time_confidence and manual rectification. */}
            <div data-testid="confidence-selector">
              <p className="block text-text-primary font-medium mb-2">
                {t("birth_time.confidence_label")}
              </p>
              <div className="grid grid-cols-2 gap-2">
                {TIME_CONFIDENCE_ORDER.map((key) => {
                  const selected = data.timeConfidence === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => handleConfidenceChange(key)}
                      aria-pressed={selected}
                      data-testid={`confidence-option-${key}`}
                      className={`py-2.5 px-3 rounded-lg border text-sm transition-colors ${
                        selected
                          ? "border-accent-gold bg-accent-gold/15 text-accent-gold font-medium"
                          : "border-ui-border text-text-secondary hover:border-accent-gold/50"
                      }`}
                    >
                      {t(`birth_time.confidence.${key}`)}
                    </button>
                  );
                })}
              </div>
              <p className="text-text-muted text-xs mt-2" data-testid="confidence-margin-note">
                {(() => {
                  const margin = timeConfidenceMargin(data.timeConfidence);
                  if (margin === null) return t("birth_time.confidence_unknown_note");
                  if (margin === 0) return t("birth_time.confidence_exact_note");
                  return t("birth_time.confidence_margin", { minutes: margin });
                })()}
              </p>
            </div>

            <div className="bg-background-tertiary/50 border border-ui-border/50 rounded-lg p-4">
              <div className="flex items-start gap-3">
                <span className="text-accent-gold text-lg">i</span>
                <p className="text-text-secondary text-sm">
                  {t("birth_time.clock_hint")}
                  {data.timezone && t("birth_time.timezone_hint", { timezone: data.timezone })}
                </p>
              </div>
            </div>
            <p className="text-text-muted text-sm text-center">
              {t("birth_time.estimate_hint")}
            </p>
          </div>
        );

      case "life-events":
        return (
          <div className="space-y-6">
            {/* Header */}
            <div className="text-center mb-4">
              <h2 className="text-2xl font-bold text-text-primary mb-2">{t("life_events.title")}</h2>
              <p className="text-text-secondary">
                {t("life_events.subtitle")}
              </p>
            </div>

            {/* Why This Matters Info Box */}
            <div className="bg-background-tertiary border border-ui-border rounded-lg p-4">
              <div className="flex items-start gap-3">
                <span className="text-accent-gold text-lg">*</span>
                <div>
                  <p className="text-text-primary font-medium mb-1">{t("life_events.why_title")}</p>
                  <p className="text-text-secondary text-sm">
                    {t("life_events.why_body")}
                  </p>
                </div>
              </div>
            </div>

            {/* Text Area */}
            <div>
              <label className="block text-text-primary font-medium mb-2">
                {t("life_events.textarea_label")}
              </label>
              <textarea
                value={narrative}
                onChange={(e) => {
                  setNarrative(e.target.value);
                  setFeedback("", null);
                }}
                placeholder={t("life_events.textarea_placeholder")}
                maxLength={5000}
                className="w-full px-4 py-4 bg-background-tertiary border border-ui-border rounded-lg text-text-primary text-base placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent-gold/50 resize-none"
                rows={5}
                disabled={isExtracting}
                data-testid="life-events-input"
              />
              <p className="text-text-muted text-xs mt-1">{t("life_events.char_count", { count: narrative.length })}</p>
              <p className="mt-2 text-xs leading-relaxed text-text-muted">
                {t("life_events.privacy_note")}
              </p>
            </div>

            {/* Feedback Message */}
            {extractionFeedback && (
              <div
                className={`p-3 rounded-lg ${feedbackStatus === "success"
                    ? "bg-green-500/20 border border-green-500/50"
                    : feedbackStatus === "error"
                      ? "bg-red-500/20 border border-red-500/50"
                      : "bg-yellow-500/20 border border-yellow-500/50"
                  }`}
              >
                <p
                  className={`text-sm text-center ${feedbackStatus === "success"
                      ? "text-green-400"
                      : feedbackStatus === "error"
                        ? "text-red-400"
                        : "text-yellow-400"
                    }`}
                >
                  {extractionFeedback}
                </p>
              </div>
            )}

            {/* Captured Events Display */}
            {extractedEvents.length > 0 && (
              <div className="space-y-2" data-testid="captured-life-events">
                <p className="text-text-secondary text-sm">{t("life_events.saved_label")}</p>
                <div className="flex flex-wrap gap-2">
                  {extractedEvents.map((event, index) => (
                    <span
                      key={index}
                      className="bg-accent-gold/20 text-accent-gold px-3 py-1 rounded-full text-sm"
                    >
                      {event.description}
                      {event.date ? ` (${event.date})` : ''}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Example Prompts */}
            <div>
              <p className="text-text-secondary text-sm mb-2">{t("life_events.inspiration_label")}</p>
              <div className="space-y-2">
                {examplePrompts.map((example, index) => (
                  <button
                    key={index}
                    onClick={() => handleUseExample(example)}
                    className="w-full text-left p-3 bg-background-tertiary border border-ui-border rounded-lg text-text-muted text-sm italic hover:border-accent-gold/50 transition-colors disabled:opacity-50"
                    disabled={isExtracting}
                  >
                    "{example}"
                  </button>
                ))}
              </div>
            </div>

            {/* Helpful Event Types */}
            <div className="bg-background-tertiary border border-ui-border rounded-lg p-4">
              <p className="text-text-primary font-medium mb-2">{t("life_events.helpful_title")}</p>
              <div className="flex flex-wrap gap-2">
                {HELPFUL_EVENT_TYPE_KEYS.map((eventTypeKey) => (
                  <span
                    key={eventTypeKey}
                    className="bg-accent-gold/20 text-accent-gold px-2 py-1 rounded-full text-xs"
                  >
                    {t(`life_events.event_types.${eventTypeKey}`)}
                  </span>
                ))}
              </div>
            </div>

            {/* Action Buttons */}
            <div className="space-y-3 pt-2">
              <div className="flex gap-4">
                <button
                  onClick={handleBack}
                  disabled={isExtracting}
                  className="flex-1 py-3 border border-ui-border text-text-primary font-semibold rounded-lg hover:bg-background-tertiary transition-colors disabled:opacity-50"
                  data-testid="back-button"
                >
                  {t("common:actions.back")}
                </button>
                <button
                  onClick={handleExtractEvents}
                  disabled={isExtracting || narrative.trim().length < 20}
                  className="flex-1 py-3 bg-accent-gold text-background-primary font-semibold rounded-lg hover:bg-accent-gold/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  data-testid="extract-events-button"
                >
                  {isExtracting ? (
                    <>
                      <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      <span>{t("life_events.analyzing")}</span>
                    </>
                  ) : extractedEvents.length > 0 ? (
                    t("common:actions.continue")
                  ) : (
                    t("life_events.analyze_continue")
                  )}
                </button>
              </div>
              <button
                onClick={handleSkipLifeEvents}
                disabled={isExtracting}
                className="w-full py-3 text-text-muted hover:text-text-secondary transition-colors disabled:opacity-50"
                data-testid="skip-life-events-button"
              >
                {t("life_events.skip")}
              </button>
            </div>
          </div>
        );

      case "birth-location":
        return (
          <div className="space-y-6">
            <div className="text-center mb-8">
              <h2 className="text-2xl font-bold text-text-primary mb-2">{t("location.title")}</h2>
              <p className="text-text-secondary">{t("location.subtitle")}</p>
            </div>
            <LocationSearch
              value={birthLocationValue}
              onChange={handleLocationChange}
              placeholder={t("location.placeholder")}
            />
            <div className="bg-background-tertiary border border-ui-border rounded-lg p-4">
              <div className="flex items-start gap-3">
                <span className="text-accent-gold">🌍</span>
                <div>
                  <p className="text-text-primary font-medium mb-1">{t("location.timezone_auto_title")}</p>
                  <p className="text-text-secondary text-sm">
                    {t("location.timezone_auto_body")}
                  </p>
                </div>
              </div>
            </div>
            <p className="text-text-muted text-sm text-center">
              {t("location.hint")}
            </p>
          </div>
        );

      default:
        return null;
    }
  };

  // NOTE: Loading state for idempotency check removed - OnboardingRoute guard handles it.

  return (
    // Fill the viewport MINUS the chrome AppLayout already contributes (sticky
    // header + `main` padding). `min-h-screen` here would be 100vh *inside* an
    // already-offset shell, forcing the document to overflow by exactly that
    // chrome on every viewport and centring the content against the wrong box.
    <div className="min-h-[calc(100dvh-var(--app-chrome-block))] flex flex-col bg-background-primary relative overflow-hidden">
      {/* Mystical Background Glow - Same as Login for consistency */}
      <div className="absolute inset-0 pointer-events-none">
        {/* Central purple glow — capped to the viewport so a phone gets a
            centred, proportional wash instead of a clipped 600px disc. */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(600px,130vw)] h-[min(600px,130vw)] bg-accent-purple/15 rounded-full blur-[120px]" />
        {/* Secondary gold accent */}
        <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(400px,90vw)] h-[min(400px,90vw)] bg-accent-gold/8 rounded-full blur-[100px]" />
      </div>

      {/* NOTE: no page-level <Header> here — `/onboarding` renders inside
          AppLayout, which already owns the wordmark and app nav. Rendering a
          second `sticky top-0 z-40` header stacked a dead ghost bar (and a
          duplicate logo) under the real one at every breakpoint. */}

      <main className="flex-1 flex flex-col items-center justify-center py-6 sm:py-10 relative z-10">
        <div className="w-full max-w-lg">
          {/* Logo — steps down on narrow viewports so the wordmark carries the
              same visual weight on a phone as on a laptop. */}
          <div className="text-center mb-6 sm:mb-8">
            <Logo size="hero" showText className="justify-center" />
          </div>

          {/* Saving Indicator */}
          {isSaving && (
            <div className="mb-4 text-center">
              <span className="text-text-muted text-sm">{t("saving")}</span>
            </div>
          )}

          {/* Progress Bar */}
          {currentStepKey !== "generating" && (
            <div className="mb-8">
              {/* Compact indicator (narrow viewports). Five labels cannot fit a
                  phone in every locale — es/pt run ~50% longer than en ("Fecha
                  de nacimiento") — so show the active step plus a counter
                  rather than crushing all five into one row. */}
              <div className="flex sm:hidden items-baseline justify-between gap-3 text-sm mb-2">
                <span className="min-w-0 truncate text-accent-gold">
                  {steps[currentStepIndex]?.label}
                </span>
                <span className="shrink-0 whitespace-nowrap text-text-muted">
                  {t("progress.counter", {
                    current: currentStepIndex + 1,
                    total: steps.length,
                  })}
                </span>
              </div>

              {/* Full trail — sm and up, where all five labels fit. */}
              <div className="hidden sm:flex justify-between gap-2 text-sm text-text-muted mb-2">
                {steps.map((step, index) => (
                  <span
                    key={step.key}
                    className={`truncate ${index <= currentStepIndex ? "text-accent-gold" : ""}`}
                  >
                    {step.label}
                  </span>
                ))}
              </div>
              <div className="h-2 bg-background-tertiary rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent-gold transition-all duration-300"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>
          )}

          {/* Content Card with Glowing Border */}
          <div className="relative">
            {/* Glowing border effect */}
            <div className="absolute -inset-[1px] bg-gradient-to-b from-accent-purple/40 via-accent-purple/15 to-transparent rounded-xl blur-[1px]" />

            {/* Card content */}
            <div className="relative bg-background-secondary border border-accent-purple/20 rounded-xl p-6 sm:p-8">
              {renderStep()}

              {/* Error Message — skipped on the generating step, whose recovery
                  card already presents the same message with its actions (the
                  strip would render the identical text a second time). */}
              {error && currentStepKey !== "generating" && (
                <div className="mt-6 p-3 bg-red-500/20 border border-red-500/50 rounded-lg">
                  <p className="text-red-400 text-sm text-center">{error}</p>
                </div>
              )}

              {/* Navigation Buttons - hidden for life-events step which has its own buttons */}
              {currentStepKey !== "generating" && currentStepKey !== "life-events" && (
                <div className="flex gap-4 mt-8">
                  {currentStepKey !== "name" && (
                    <button
                      onClick={handleBack}
                      className="flex-1 py-3 border border-ui-border text-text-primary font-semibold rounded-lg hover:bg-background-tertiary transition-colors"
                      data-testid="back-button"
                    >
                      {t("common:actions.back")}
                    </button>
                  )}
                  <button
                    onClick={handleNext}
                    disabled={!canProceed() || isLoading}
                    className="flex-1 py-3 bg-accent-gold text-background-primary font-semibold rounded-lg hover:bg-accent-gold/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    data-testid="next-button"
                  >
                    {t("common:actions.continue")}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
