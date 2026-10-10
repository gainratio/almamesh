/**
 * AiSetupPanel — the one AI setup UI (Settings → AI, and onboarding from PR 4).
 *
 * Two choices, stated plainly:
 *   1. AI off (the DEFAULT) — the chart is pure calculation and nothing leaves
 *      the device. A feature, not an empty state.
 *   2. Connect AI — an OpenRouter key (the guided, recommended path) or, under
 *      "Advanced", any OpenAI-compatible endpoint (incl. a local Ollama).
 *
 * Saving is NOT fire-and-forget: it persists the config, then runs a real
 * connectivity probe that mirrors the JSON-mode reading (`testProviderConnection`)
 * against the exact model/endpoint the reading will use, and reports an honest
 * **Connected** or a specific error
 * (bad key / bad model / out of credits / unreachable) right here — so the user
 * never has to leave the screen to discover their config is broken. Everything is
 * stored in canonical browser-local SQLite; synchronous reads use a boot-hydrated
 * memory snapshot and no user setting is duplicated in Web Storage.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { safeError } from '@almamesh/shared-types';
import { flushPortablePersistence } from '@almamesh/store';
import {
  CHAT_CLOUD_MODEL,
  describeLlmStatus,
  fetchOpenRouterCredits,
  hydrateLlmSettings,
  fetchOpenRouterModels,
  isLocalEndpoint,
  openRouterPreset,
  OPENROUTER_API_BASE,
  readLlmSettings,
  resolveProviderConfig,
  testProviderConnection,
  writeLlmSettings,
  RECOMMENDED_CLOUD_MODEL,
  type LlmSettings,
  type LlmStatus,
  type OpenRouterCredits,
  type OpenRouterModel,
  type ProviderConfig,
} from '@almamesh/llm';
import { Badge, Button, ModelCombobox } from '../../ui';
import { classifyConnectionError, connectionErrorDetail } from '../../../lib/errors';
import {
  LLM_SETTINGS_CHANGED_EVENT,
  notifyLlmSettingsChanged,
} from '../../../lib/llmSettingsEvents';
import {
  dismissSlowModelSuggestion,
  isSlowModelSuggestionDismissed,
  slowModelSwitch,
} from '../../../lib/modelSuggestion';
import { resolveInterpretationConfig } from '../../../hooks/useStreamingInterpretation';

const OPENROUTER_KEYS_URL = 'https://openrouter.ai/keys';
const PLACEHOLDER_BASE = 'http://localhost:11434/v1';
// Reuse the single source of truth from @almamesh/llm so the placeholders never
// drift from the actual recommended interpretation/chat models.
const PLACEHOLDER_INTERP_MODEL = RECOMMENDED_CLOUD_MODEL;
const PLACEHOLDER_CHAT_MODEL = CHAT_CLOUD_MODEL;

/** Which Save button a verdict belongs to, so it renders under the right one. */
type ConnSource = 'guided' | 'advanced';

/**
 * The verdict kinds: every connection-error class, plus `'storage'` for the case
 * where persisting canonical SQLite failed — a save no-op the user must be told
 * about, never swallowed.
 */
type ResultKind = ReturnType<typeof classifyConnectionError> | 'storage';

/** The live state of the save-time connectivity probe. */
type ConnState =
  | { phase: 'idle' }
  | { phase: 'testing'; source: ConnSource }
  | { phase: 'connected'; source: ConnSource }
  | { phase: 'error'; source: ConnSource; kind: ResultKind; detail?: string };

/** The live state of the OpenRouter balance read (OpenRouter-only). */
type CreditsState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'loaded'; credits: OpenRouterCredits }
  | { phase: 'error' };

/** The live state of the OpenRouter model-catalog read (OpenRouter-only). */
type ModelsState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'loaded'; models: OpenRouterModel[] }
  | { phase: 'error' };

/**
 * Injectable seams so the component is unit-testable without a network round-trip
 * — default to the real interpretation-config resolver + connectivity probe +
 * OpenRouter balance reader.
 */
export interface AiSetupPanelProps {
  resolveConfig?: () => ProviderConfig;
  testConnection?: (opts: { config: ProviderConfig; signal?: AbortSignal }) => Promise<void>;
  fetchCredits?: (opts: {
    config: ProviderConfig;
    signal?: AbortSignal;
  }) => Promise<OpenRouterCredits>;
  fetchModels?: (opts: {
    config: ProviderConfig;
    signal?: AbortSignal;
  }) => Promise<OpenRouterModel[]>;
  /** Await the canonical SQLite write before reporting a saved configuration. */
  flushSettings?: () => Promise<void>;
  /** Show the "AI off" choice. Settings: true (default). Onboarding: false. */
  showOffChoice?: boolean;
  /** Surface-specific copy above the choices. Settings passes none. */
  intro?: ReactNode;
  /**
   * Called once per save, only after the settings are durable AND the probe
   * passed for the config still on screen. Onboarding advances on it.
   * Not called if the panel unmounts, AI is turned off, a remote Replace lands, or
   * the form is edited or re-saved before the probe settles. It may be async; it is
   * awaited, and a throw or rejection is logged while the verdict stays Connected.
   */
  onConnected?: (status: LlmStatus) => void | Promise<void>;
}

export function AiSetupPanel({
  resolveConfig = resolveInterpretationConfig,
  testConnection = testProviderConnection,
  fetchCredits = fetchOpenRouterCredits,
  fetchModels = fetchOpenRouterModels,
  flushSettings = flushPortablePersistence,
  showOffChoice = true,
  intro,
  onConnected,
}: AiSetupPanelProps = {}) {
  const { t } = useTranslation('settings');
  const [status, setStatus] = useState<LlmStatus>(() => describeLlmStatus());
  const [settings, setSettings] = useState<LlmSettings>(() => readLlmSettings());
  const [conn, setConn] = useState<ConnState>({ phase: 'idle' });
  // Probe-race guard: every save bumps `probeGen` and aborts the prior in-flight
  // fetch, so a stale verdict from a superseded config can never land on screen.
  const probeGen = useRef(0);
  const probeAbort = useRef<AbortController | null>(null);

  // A remote Replace reconstructs the synchronous memory snapshot, then emits the same
  // settings signal used by local saves. Re-read the whole form so a tab left
  // open on Settings cannot later submit its pre-restore React snapshot.
  useEffect(() => {
    const refreshFromCanonicalState = (event: Event) => {
      if (!(event instanceof CustomEvent) || event.detail?.replace !== true) return;
      probeGen.current += 1;
      probeAbort.current?.abort();
      const restored = readLlmSettings();
      setSettings(restored);
      setStatus(describeLlmStatus(restored));
      setConn({ phase: 'idle' });
    };
    window.addEventListener(LLM_SETTINGS_CHANGED_EVENT, refreshFromCanonicalState);
    return () =>
      window.removeEventListener(LLM_SETTINGS_CHANGED_EVENT, refreshFromCanonicalState);
  }, []);

  // Leaving the screen supersedes whatever is in flight: a probe that settles after
  // unmount must never report a connection to a caller that has moved on. The refs
  // are read at cleanup time on purpose — the LATEST in-flight probe is the one to cancel.
  useEffect(
    () => () => {
      probeGen.current += 1; // unmount supersedes the probe
      probeAbort.current?.abort(); // unmount aborts the probe
    },
    [],
  );

  const noneActive = status.kind === 'none';
  const aiOn =
    (status.kind === 'openrouter' || status.kind === 'cloud' || status.kind === 'local') &&
    status.configured;

  // The OpenRouter balance line is OpenRouter-ONLY: never fetch (never send a key)
  // for a local/loopback or a bring-your-own cloud endpoint. This gate is the
  // privacy boundary for the credits read.
  const showCredits = status.kind === 'openrouter' && status.configured;
  const [credits, setCredits] = useState<CreditsState>({ phase: 'idle' });
  const creditsAbort = useRef<AbortController | null>(null);

  const loadCredits = useCallback(() => {
    creditsAbort.current?.abort();
    const controller = new AbortController();
    creditsAbort.current = controller;
    setCredits({ phase: 'loading' });
    fetchCredits({ config: resolveConfig(), signal: controller.signal })
      .then((c) => {
        if (!controller.signal.aborted) setCredits({ phase: 'loaded', credits: c });
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        // Never swallow: the balance is a nice-to-have, so we degrade to a muted
        // "unavailable" line, but the reason lands in the console for diagnosis.
        safeError('provider.credits_failed', err);
        setCredits({ phase: 'error' });
      });
  }, [fetchCredits, resolveConfig]);

  // Auto-read the balance whenever OpenRouter becomes the live provider (mount if
  // already connected, or the instant a guided connect saves); clear it otherwise.
  // Abort any in-flight read on unmount so a fetch can't outlive the screen.
  useEffect(() => {
    if (showCredits) {
      loadCredits();
    } else {
      setCredits({ phase: 'idle' });
    }
    return () => creditsAbort.current?.abort();
  }, [showCredits, loadCredits]);

  // Populate the model pickers from OpenRouter's LIVE catalog so a user can never
  // save a slug that isn't a real model (the "That model isn't available" dead-end).
  // Derived from the CURRENTLY-typed endpoint (normalized), so the picker fills the
  // moment the endpoint is OpenRouter — even before saving. A catalog read is
  // PUBLIC: `resolveProviderConfig` omits the key (no VITE_LLM_API_KEY passed), so
  // no key is ever sent — and `fetchOpenRouterModels` fail-closes to OpenRouter only.
  const modelsConfig = useMemo(
    () => resolveProviderConfig({ VITE_LLM_API_BASE: settings.apiBase }),
    [settings.apiBase],
  );
  const showModels = modelsConfig.baseUrl.startsWith(OPENROUTER_API_BASE);
  const [models, setModels] = useState<ModelsState>({ phase: 'idle' });
  const modelsAbort = useRef<AbortController | null>(null);

  const loadModels = useCallback(() => {
    modelsAbort.current?.abort();
    const controller = new AbortController();
    modelsAbort.current = controller;
    setModels({ phase: 'loading' });
    fetchModels({ config: modelsConfig, signal: controller.signal })
      .then((m) => {
        if (!controller.signal.aborted) setModels({ phase: 'loaded', models: m });
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        // Never swallow: the picker is a nice-to-have, so we degrade to plain
        // free-text entry (the combobox with no options), but log the reason.
        safeError('provider.models_failed', err);
        setModels({ phase: 'error' });
      });
  }, [fetchModels, modelsConfig]);

  useEffect(() => {
    if (showModels) {
      loadModels();
    } else {
      setModels({ phase: 'idle' });
    }
    return () => modelsAbort.current?.abort();
  }, [showModels, loadModels]);

  const modelOptions = models.phase === 'loaded' ? models.models : [];
  const modelsLoading = models.phase === 'loading';

  // Editing any field invalidates any in-flight probe (its verdict was for the
  // OLD config) and abandons the last verdict — the config on screen is unsaved.
  const patch = (next: Partial<LlmSettings>) => {
    probeGen.current += 1;
    probeAbort.current?.abort();
    setSettings((prev) => ({ ...prev, ...next }));
    setConn({ phase: 'idle' });
  };

  // Back to the default: fully disconnect. Clear the endpoint + key + model AND
  // re-arm the fail-closed privacy fence — a persisted `cloud_premium` (written
  // by a prior OpenRouter connect) would otherwise stay and keep `ensurePrivacy`
  // inert for this browser. Reset to `local_only` and drop the per-tier models so
  // nothing sensitive lingers; describeLlmStatus reads "none" again.
  const turnAiOff = async () => {
    const offGen = (probeGen.current += 1);
    probeAbort.current?.abort();
    const beforeOff = readLlmSettings();
    try {
      writeLlmSettings({
        engine: '',
        apiBase: '',
        apiKey: '',
        model: '',
        interpretationModel: '',
        chatModel: '',
        privacyMode: 'local_only',
      });
      await flushSettings();
    } catch (err) {
      // Canonical SQLite can reject. Keep
      // the active badge and surface a retryable storage verdict.
      safeError('provider.disable_failed', err);
      // A newer save or edit owns the verdict now; a late off-failure must not paint over it.
      if (offGen !== probeGen.current) {
        return;
      }
      // writeLlmSettings already flipped the in-memory snapshot; put it back so
      // memory agrees with the badge (and with the durable row) until a retry.
      hydrateLlmSettings(JSON.stringify(beforeOff)); // restore after a failed turn-off
      setConn({ phase: 'error', source: 'guided', kind: 'storage' });
      return;
    }
    // Superseded while the off flush was in flight: refresh the status surfaces from
    // durable truth (a newer save may have written since), but leave the form and
    // the verdict to whoever superseded this turn-off.
    if (offGen !== probeGen.current) {
      setStatus(describeLlmStatus());
      notifyLlmSettingsChanged();
      return;
    }
    setSettings(readLlmSettings());
    setConn({ phase: 'idle' });
    setStatus(describeLlmStatus());
    notifyLlmSettingsChanged();
  };

  // The shared save→test path: persist, refresh every status surface, then probe
  // the resolved interpretation config and report an honest verdict under the
  // Save button that triggered it (`source`).
  const saveAndTest = async (next: LlmSettings, source: ConnSource) => {
    const gen = (probeGen.current += 1);
    probeAbort.current?.abort();
    const controller = new AbortController();
    probeAbort.current = controller;
    const beforeSave = readLlmSettings();

    try {
      writeLlmSettings({ ...next, engine: '' });
      await flushSettings();
    } catch (err) {
      // A canonical SQLite write can fail. Do not
      // probe or report a configuration that will disappear on reload.
      safeError('provider.settings_save_failed', err);
      // A newer save or edit owns the verdict now; a late failure must not paint over it.
      if (gen !== probeGen.current) {
        return;
      }
      // Never leave an unsaved config live in memory until the next reload.
      hydrateLlmSettings(JSON.stringify(beforeSave)); // restore after a failed save
      setConn({ phase: 'error', source, kind: 'storage' });
      return;
    }
    // A save superseded while its flush was in flight still wrote durable settings,
    // so the status surfaces (this panel's badge, the header badge) refresh from
    // that truth. It must not repaint the user's in-progress form or
    // the verdict that the newer save now owns.
    if (gen !== probeGen.current) {
      setStatus(describeLlmStatus());
      notifyLlmSettingsChanged();
      return;
    }

    const persisted = readLlmSettings();
    setSettings(persisted);
    setStatus(describeLlmStatus(persisted));
    notifyLlmSettingsChanged();
    setConn({ phase: 'testing', source });
    try {
      await testConnection({ config: resolveConfig(), signal: controller.signal });
    } catch (err) {
      // A superseded probe (the user edited or re-saved) must not overwrite the
      // current verdict; ignore its result.
      if (gen !== probeGen.current) {
        return;
      }
      // Never swallow — the specific verdict below is all the user sees.
      safeError('provider.connection_test_failed', err);
      const kind = classifyConnectionError(err);
      // When the failure is otherwise unclassifiable (a 400/429/5xx, e.g. a model
      // rejecting a request param), surface the PROVIDER'S OWN reason so the user
      // isn't stuck on a blind "couldn't connect" with no next step.
      const detail = kind === 'unknown' ? connectionErrorDetail(err) : undefined;
      setConn({ phase: 'error', source, kind, ...(detail ? { detail } : {}) });
      return;
    }
    // Probe-race guard: a superseded probe (edit, re-save, or remote Replace)
    // must never paint Connected or report a connection for a config that is gone.
    if (gen !== probeGen.current) {
      return;
    }
    // Reached only after `await flushSettings()` above resolved (SQLite has the
    // config) AND the probe passed. Called outside the try so a throwing caller
    // can never be misreported as a connection error.
    setConn({ phase: 'connected', source });
    try {
      await onConnected?.(describeLlmStatus(persisted));
    } catch (err) {
      // The caller's bug, not a connection failure: keep Connected, log it, and never
      // let a throw or an async rejection escape as an unhandled rejection.
      safeError('app.typed_error', err);
    }
  };

  // Guided OpenRouter: apply the cloud preset (recommended interpretation/chat pair +
  // cloud_premium so the fail-closed gate passes) with the user's key, then test.
  const saveOpenRouter = () => {
    const interp = settings.interpretationModel || settings.model || RECOMMENDED_CLOUD_MODEL;
    const chat = settings.chatModel || CHAT_CLOUD_MODEL;
    return saveAndTest(openRouterPreset(settings.apiKey?.trim() ?? '', interp, chat), 'guided');
  };

  // One-time "switch off glm-5.3-flash" card. Computed from the SAVED settings
  // (not the unsaved form) so typing never makes it flicker.
  const [suggestOpen, setSuggestOpen] = useState(() => !isSlowModelSuggestionDismissed());
  const savedSwitch = slowModelSwitch(readLlmSettings());
  const acceptSwitch = () => {
    dismissSlowModelSuggestion();
    setSuggestOpen(false);
    if (savedSwitch) void saveAndTest(savedSwitch, 'guided');
  };
  const keepModel = () => {
    dismissSlowModelSuggestion();
    setSuggestOpen(false);
  };

  const hasKey = Boolean(settings.apiKey?.trim());
  const hasEndpoint = Boolean(settings.apiBase?.trim());
  const isCloud = settings.privacyMode === 'cloud_premium';
  const endpointIsLocal = isLocalEndpoint(settings.apiBase || PLACEHOLDER_BASE);
  const willRefuse = !isCloud && !endpointIsLocal;
  const interpretationValue = settings.interpretationModel ?? settings.model ?? '';

  return (
    <section className="space-y-4">
      {intro ? (
        <div className="space-y-2 text-sm text-text-secondary" data-testid="ai-setup-intro">
          {intro}
        </div>
      ) : null}

      {/* ── AI off (the default). Onboarding offers "Skip for now" outside the panel instead. ── */}
      {showOffChoice && (
        <div
          data-testid="tier-none"
          className={`rounded-lg border p-4 ${
            noneActive ? 'border-accent-gold/40 bg-accent-gold/5' : 'border-ui-border bg-background-secondary'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-text-primary text-sm font-medium">
              {t('tiers.none_title')}
              <span className="ml-2 rounded-full border border-ui-border px-2 py-0.5 text-[0.65rem] font-medium uppercase tracking-wide text-text-secondary">
                {t('tiers.none_default_badge')}
              </span>
            </p>
            {noneActive ? (
              <Badge variant="brass" data-testid="tier-none-active">
                {t('tiers.active_badge')}
              </Badge>
            ) : (
              <button
                type="button"
                onClick={() => void turnAiOff()}
                className="rounded-md border border-ui-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:text-text-primary"
                data-testid="tier-none-select"
              >
                {t('tiers.none_button')}
              </button>
            )}
          </div>
          <p className="text-text-secondary text-xs mt-1">{t('tiers.none_body')}</p>
        </div>
      )}

      {/* ── Connect AI ── */}
      <div
        data-testid="tier-cloud"
        className={`rounded-lg border p-4 ${
          aiOn ? 'border-accent-gold/40 bg-accent-gold/5' : 'border-ui-border bg-background-secondary'
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-text-primary text-sm font-medium">{t('tiers.cloud_title')}</p>
          {aiOn && (
            <Badge variant="brass" data-testid="tier-cloud-active">
              {t('tiers.active_badge')}
            </Badge>
          )}
        </div>
        <p className="text-text-secondary text-xs mt-1" data-testid="tier-cloud-honesty">
          {t('tiers.cloud_body')}
        </p>

        {suggestOpen && savedSwitch && (
          <div
            role="note"
            className="mt-4 rounded-lg border border-accent-gold/40 bg-accent-gold/10 p-4"
            data-testid="model-switch-suggestion"
          >
            <p className="text-text-primary text-sm font-medium">{t('aiModels.switch_title')}</p>
            <p className="text-text-secondary text-xs mt-1">{t('aiModels.switch_body')}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button onClick={acceptSwitch} disabled={conn.phase === 'testing'} data-testid="model-switch-accept">
                {t('aiModels.switch_accept')}
              </Button>
              <button
                type="button"
                onClick={keepModel}
                className="rounded-md border border-ui-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:text-text-primary"
                data-testid="model-switch-dismiss"
              >
                {t('aiModels.switch_dismiss')}
              </button>
            </div>
          </div>
        )}

        {/* Guided OpenRouter — the recommended path: get a key, paste, test. */}
        <div className="mt-4 space-y-3 rounded-lg border border-accent-gold/30 bg-accent-gold/5 p-4">
          <div>
            <p className="text-text-primary text-sm font-medium">{t('ai.step1_title')}</p>
            <p className="text-text-secondary text-xs mt-0.5">{t('ai.step1_body')}</p>
            <a
              href={OPENROUTER_KEYS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-accent-gold hover:underline"
              data-testid="llm-openrouter-link"
            >
              {t('ai.step1_link')} ↗
            </a>
          </div>

          <label className="block">
            <span className="text-text-primary text-sm font-medium">{t('ai.step2_title')}</span>
            <input
              type="password"
              value={settings.apiKey ?? ''}
              placeholder="sk-or-v1-..."
              autoComplete="off"
              onChange={(e) => patch({ apiKey: e.target.value })}
              className="mt-1 w-full px-3 py-2 bg-background-secondary border border-ui-border rounded-lg text-text-primary text-sm"
              data-testid="llm-openrouter-key"
            />
          </label>

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={saveOpenRouter} disabled={!hasKey || conn.phase === 'testing'} data-testid="llm-save">
              {conn.phase === 'testing' ? t('ai.testing') : t('ai.save_and_test')}
            </Button>
            {!hasKey && <span className="text-text-muted text-xs">{t('ai.step2_hint')}</span>}
          </div>

          {/* The guided verdict lands right under its own Save button. */}
          <ConnectionResult conn={conn} t={t} source="guided" />

          {/* OpenRouter-only balance line (never rendered/fetched for local/BYO). */}
          {showCredits && <CreditsRemaining credits={credits} onRefresh={loadCredits} t={t} />}
        </div>

        {/* Advanced — any OpenAI-compatible endpoint (local Ollama, other cloud). */}
        <details className="mt-4 rounded-lg border border-ui-border bg-background-secondary p-4">
          <summary className="cursor-pointer text-text-primary text-sm font-medium" data-testid="llm-advanced-summary">
            {t('ai.advanced_summary')}
          </summary>
          <div className="mt-3 space-y-4">
            <p className="text-text-muted text-xs">{t('ai.advanced_body')}</p>

            <label className="block">
              <span className="text-text-primary text-sm font-medium">{t('ai.endpoint_label')}</span>
              <input
                type="text"
                value={settings.apiBase ?? ''}
                placeholder={PLACEHOLDER_BASE}
                onChange={(e) => patch({ apiBase: e.target.value })}
                className="mt-1 w-full px-3 py-2 bg-background-secondary border border-ui-border rounded-lg text-text-primary text-sm"
                data-testid="llm-api-base"
              />
            </label>

            {showModels && models.phase === 'loaded' && (
              <p className="text-text-muted text-xs" data-testid="llm-catalog-status">
                {t('aiModels.catalog_hint', { count: models.models.length })}
              </p>
            )}
            {showModels && models.phase === 'error' && (
              <p className="text-text-muted text-xs" data-testid="llm-catalog-status">
                {t('aiModels.catalog_unavailable')}
              </p>
            )}

            <div className="block">
              <span className="text-text-primary text-sm font-medium">{t('aiModels.interpretation_label')}</span>
              <ModelCombobox
                value={interpretationValue}
                onChange={(v) => patch({ interpretationModel: v })}
                options={modelOptions}
                loading={modelsLoading}
                placeholder={PLACEHOLDER_INTERP_MODEL}
                aria-label={t('aiModels.interpretation_label')}
                loadingLabel={t('aiModels.loading_models')}
                moreLabel={t('aiModels.more_models')}
                data-testid="llm-model"
              />
              <p className="text-text-muted text-xs mt-1" data-testid="llm-model-advice">
                {t('aiModels.interpretation_advice')}
              </p>
            </div>

            <div className="block">
              <span className="text-text-primary text-sm font-medium">{t('aiModels.chat_label')}</span>
              <ModelCombobox
                value={settings.chatModel ?? ''}
                onChange={(v) => patch({ chatModel: v })}
                options={modelOptions}
                loading={modelsLoading}
                placeholder={PLACEHOLDER_CHAT_MODEL}
                aria-label={t('aiModels.chat_label')}
                loadingLabel={t('aiModels.loading_models')}
                moreLabel={t('aiModels.more_models')}
                data-testid="llm-chat-model"
              />
              <p className="text-text-muted text-xs mt-1" data-testid="llm-chat-model-advice">
                {t('aiModels.chat_advice')}
              </p>
            </div>

            <label className="flex items-center justify-between">
              <span className="text-text-primary text-sm font-medium">{t('ai.allow_cloud_label')}</span>
              <input
                type="checkbox"
                checked={isCloud}
                onChange={(e) => patch({ privacyMode: e.target.checked ? 'cloud_premium' : 'local_only' })}
                className="rounded border-ui-border text-accent-gold focus:ring-accent-gold/50"
                data-testid="llm-allow-cloud"
              />
            </label>

            {isCloud && (
              <label className="block">
                <span className="text-text-primary text-sm font-medium">{t('ai.api_key_label')}</span>
                <input
                  type="password"
                  value={settings.apiKey ?? ''}
                  placeholder="sk-..."
                  autoComplete="off"
                  onChange={(e) => patch({ apiKey: e.target.value })}
                  className="mt-1 w-full px-3 py-2 bg-background-secondary border border-ui-border rounded-lg text-text-primary text-sm"
                  data-testid="llm-api-key"
                />
              </label>
            )}

            {willRefuse && (
              <p className="text-sm text-amber-400" data-testid="llm-privacy-warning">
                {t('ai.privacy_warning')}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={() => saveAndTest(settings, 'advanced')}
                disabled={!hasEndpoint || conn.phase === 'testing'}
                data-testid="llm-save-advanced"
              >
                {conn.phase === 'testing' ? t('ai.testing') : t('ai.save_and_test')}
              </Button>
              {/* Gate on a present endpoint (mirrors the guided !hasKey) so an
                  empty form can't probe the fallback default and show a
                  confusing verdict. */}
              {!hasEndpoint && <span className="text-text-muted text-xs">{t('ai.advanced_hint')}</span>}
            </div>

            {/* The advanced verdict lands right under the advanced Save button. */}
            <ConnectionResult conn={conn} t={t} source="advanced" />
          </div>
        </details>
      </div>
    </section>
  );
}

/**
 * The honest save-time verdict line: testing / connected / a specific error.
 * Renders only for the Save button (`source`) that triggered the probe, so the
 * verdict always sits directly under the control the user pressed.
 */
function ConnectionResult({
  conn,
  t,
  source,
}: {
  conn: ConnState;
  t: ReturnType<typeof useTranslation<'settings'>>['t'];
  source: ConnSource;
}) {
  if (conn.phase === 'idle' || conn.source !== source) {
    return null;
  }
  const text =
    conn.phase === 'testing'
      ? t('ai.testing')
      : conn.phase === 'connected'
        ? t('ai.connected')
        : t(`ai.error_${conn.kind}`);
  const tone =
    conn.phase === 'connected'
      ? 'text-green-400'
      : conn.phase === 'error'
        ? 'text-red-400'
        : 'text-text-secondary';
  const detail = conn.phase === 'error' ? conn.detail : undefined;
  return (
    <div className="mt-3" role="status" data-testid="llm-connection-result">
      <p className={`text-sm ${tone}`}>
        {conn.phase === 'connected' ? '✓ ' : conn.phase === 'error' ? '✗ ' : ''}
        {text}
      </p>
      {detail && (
        <p className="mt-1 text-text-muted text-xs" data-testid="llm-connection-detail">
          {t('ai.error_detail', { detail })}
        </p>
      )}
    </div>
  );
}

/** Format a USD credit amount for display (OpenRouter reports dollars, not tokens). */
function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/**
 * The OpenRouter balance line. Rendered ONLY when OpenRouter is the live provider
 * (the parent's `showCredits` gate), so a key is never sent to a local/BYO host.
 * Shows the spendable balance in USD credits — OpenRouter does not expose a token
 * count — with a one-line note so "tokens left" reads as the dollar balance it is,
 * plus a manual Refresh.
 */
function CreditsRemaining({
  credits,
  onRefresh,
  t,
}: {
  credits: CreditsState;
  onRefresh: () => void;
  t: ReturnType<typeof useTranslation<'settings'>>['t'];
}) {
  return (
    <div className="mt-3 space-y-1" data-testid="llm-credits">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {credits.phase === 'loading' && (
          <span className="text-text-secondary">{t('ai.credits_loading')}</span>
        )}
        {credits.phase === 'loaded' && (
          <span className="text-text-primary font-medium" data-testid="llm-credits-value">
            {t('ai.credits_remaining', {
              remaining: usd(credits.credits.remaining),
              total: usd(credits.credits.totalCredits),
            })}
          </span>
        )}
        {credits.phase === 'error' && (
          <span className="text-text-muted" data-testid="llm-credits-error">
            {t('ai.credits_unavailable')}
          </span>
        )}
        <button
          type="button"
          onClick={onRefresh}
          disabled={credits.phase === 'loading'}
          className="text-accent-gold text-xs hover:underline disabled:opacity-50"
          data-testid="llm-credits-refresh"
        >
          {t('ai.credits_refresh')}
        </button>
      </div>
      <p className="text-text-muted text-xs">{t('ai.credits_note')}</p>
    </div>
  );
}
