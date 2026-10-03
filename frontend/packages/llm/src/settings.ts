// Light, local-first LLM settings. AlmaMesh hydrates this synchronous in-memory
// view from canonical OPFS SQLite before React renders. No API key or provider
// setting is duplicated into Web Storage.

import {
  CHAT_CLOUD_MODEL,
  isLocalEndpoint,
  OPENROUTER_API_BASE,
  RECOMMENDED_CLOUD_MODEL,
  RETIRED_CLOUD_MODELS,
  type LlmEnv,
} from "./config";

/** Legacy migration key and canonical preference-map key. */
export const LLM_SETTINGS_KEY = "almamesh-llm-settings";

/**
 * Browser integration seam. The LLM package stays storage-backend agnostic;
 * AlmaMesh configures this writer to commit the versioned SQLite preferences
 * row while synchronous consumers read the boot-hydrated memory snapshot.
 */
export type LlmSettingsPersistence = (serialized: string) => void | Promise<void>;
let durableSettingsWriter: LlmSettingsPersistence | undefined;
let settingsSnapshot: LlmSettings = {};

export function configureLlmSettingsPersistence(
  writer: LlmSettingsPersistence | undefined,
): void {
  durableSettingsWriter = writer;
}

function persistDurably(serialized: string): void {
  try {
    const pending = durableSettingsWriter?.(serialized);
    if (pending instanceof Promise) void pending.catch(() => undefined);
  } catch {
    // The UI still has its synchronous in-memory value for this session.
    // Startup reconstructs it from SQLite, so a failed durable write cannot
    // become authority on the next load.
  }
}

/** User-editable LLM settings (the subset a Settings UI would expose). */
export interface LlmSettings {
  readonly apiBase?: string;
  readonly apiKey?: string;
  /**
   * Legacy single model field. Kept for back-compat: a blob written before the
   * tiered split still carries it, and {@link readLlmSettings} migrates it into
   * {@link interpretationModel}. New writes use the two per-tier fields below.
   */
  readonly model?: string;
  /**
   * The model for the one-time, in-depth chart interpretation (and the
   * timeline sections). Resolved onto `VITE_LLM_MODEL` by
   * {@link applyInterpretationSettings} (default {@link RECOMMENDED_CLOUD_MODEL},
   * a fast reasoning model).
   */
  readonly interpretationModel?: string;
  /**
   * The model for multi-turn chat. A smaller/faster model is advised — chat
   * already reuses the chart facts + the generated reading, so it does not need a
   * heavy model. Resolved onto `VITE_LLM_MODEL` by {@link applyChatSettings}
   * (default {@link CHAT_CLOUD_MODEL}).
   */
  readonly chatModel?: string;
  readonly privacyMode?: string;
  /** Engine selector; resolves to `"openai-http"` (the only engine). */
  readonly engine?: string;
}

/** Which kind of AI backend the saved settings point at. */
export type LlmProviderKind = "none" | "openrouter" | "local" | "cloud";

/** Human-readable summary of the saved AI provider state (for the UI status). */
export interface LlmStatus {
  readonly kind: LlmProviderKind;
  /** Short label for a badge, e.g. "OpenRouter", "Local", "Not set". */
  readonly label: string;
  /** True when the saved settings are complete enough to attempt a call. */
  readonly configured: boolean;
}

/**
 * Derive a human-readable AI provider status from saved settings — the single
 * source of truth for the header badge and "set up AI" call-to-action. A cloud
 * endpoint (OpenRouter / custom) needs an API key to count as configured; a
 * local endpoint does not.
 */
export function describeLlmStatus(settings: LlmSettings = readLlmSettings()): LlmStatus {
  const { apiBase, apiKey } = settings;
  // A model can live in ANY of the three fields: the legacy `model`, or either
  // tiered field. The manual endpoint form writes `interpretationModel`, so a
  // `model`-only check silently marked a valid hand-typed config unconfigured
  // (the "nothing happens on save" bug) — every model field counts here.
  const model = settings.model || settings.interpretationModel || settings.chatModel;
  // "Off" = no endpoint. A model id or key with no endpoint can't be called, so
  // it reads as off — and this lets "Turn AI off" (which clears the endpoint)
  // leave the user's per-tier model choices intact without appearing configured.
  if (!apiBase) {
    return { kind: "none", label: "Not set", configured: false };
  }
  if (isLocalEndpoint(apiBase)) {
    return { kind: "local", label: "Local", configured: Boolean(apiBase && model) };
  }
  const isOpenRouter = (apiBase ?? "").startsWith(OPENROUTER_API_BASE);
  const configured = Boolean(apiBase && apiKey && model);
  return isOpenRouter
    ? { kind: "openrouter", label: "OpenRouter", configured }
    : { kind: "cloud", label: "Cloud", configured };
}

/**
 * Heal a saved blob that still pins one of AlmaMesh's OWN retired default cloud
 * models (e.g. the long-dead `anthropic/claude-3.5-sonnet` OpenRouter preset that
 * 404s) by rewriting it to {@link RECOMMENDED_CLOUD_MODEL}. Narrow by design: only
 * a model from {@link RETIRED_CLOUD_MODELS} on an OpenRouter base is touched, so a
 * model the user deliberately chose is never clobbered. Pure.
 */
function healRetiredModel(settings: LlmSettings): { settings: LlmSettings; changed: boolean } {
  const onOpenRouter = (settings.apiBase ?? "").startsWith(OPENROUTER_API_BASE);
  if (onOpenRouter && settings.model && RETIRED_CLOUD_MODELS.includes(settings.model)) {
    return { settings: { ...settings, model: RECOMMENDED_CLOUD_MODEL }, changed: true };
  }
  return { settings, changed: false };
}

/**
 * Migrate a pre-tiered blob (one shared `model` for both interpretation and chat)
 * to the explicit two-tier shape by seeding {@link LlmSettings.interpretationModel}
 * from the legacy `model`. Non-destructive: the legacy `model` is preserved (other
 * back-compat readers still see it), and an interpretationModel the user already
 * has is never clobbered. Pure.
 */
function migrateLegacyModel(settings: LlmSettings): { settings: LlmSettings; changed: boolean } {
  if (settings.model && !settings.interpretationModel) {
    return { settings: { ...settings, interpretationModel: settings.model }, changed: true };
  }
  return { settings, changed: false };
}

/** Replace the synchronous view from the canonical SQLite preference row. */
export function hydrateLlmSettings(raw: string | null): LlmSettings {
  if (!raw) {
    settingsSnapshot = {};
    return settingsSnapshot;
  }
  let parsed: LlmSettings;
  try {
    parsed = JSON.parse(raw) as LlmSettings;
  } catch {
    settingsSnapshot = {};
    return settingsSnapshot;
  }
  const healed = healRetiredModel(parsed);
  const migrated = migrateLegacyModel(healed.settings);
  settingsSnapshot = migrated.settings;
  if (healed.changed || migrated.changed) {
    persistDurably(JSON.stringify(settingsSnapshot));
  }
  return settingsSnapshot;
}

/** Read the boot-hydrated in-memory override settings. */
export function readLlmSettings(): LlmSettings {
  return settingsSnapshot;
}

/** Persist override settings (merging over the hydrated in-memory snapshot). */
export function writeLlmSettings(settings: LlmSettings): void {
  settingsSnapshot = { ...settingsSnapshot, ...settings };
  persistDurably(JSON.stringify(settingsSnapshot));
}

/**
 * Merge stored overrides on top of an env-shaped object so callers get a single
 * `LlmEnv` to hand to `resolveProviderConfig`. Stored values win when present.
 */
export function applyLlmSettings(env: LlmEnv, settings: LlmSettings = readLlmSettings()): LlmEnv {
  return {
    VITE_LLM_API_BASE: settings.apiBase || env.VITE_LLM_API_BASE,
    VITE_LLM_API_KEY: settings.apiKey || env.VITE_LLM_API_KEY,
    VITE_LLM_MODEL: settings.model || env.VITE_LLM_MODEL,
    VITE_LLM_PRIVACY_MODE: settings.privacyMode || env.VITE_LLM_PRIVACY_MODE,
    VITE_LLM_ENGINE: settings.engine || env.VITE_LLM_ENGINE,
  };
}

/**
 * Resolve the env for the INTERPRETATION path: stored overrides over env, with
 * `VITE_LLM_MODEL` set EXPLICITLY to the resolved interpretation model. Replaces
 * the old implicit "use whatever `model` is" so the per-tier choice is visible.
 * A per-tier/legacy settings model (or env model) wins; the cloud frontier
 * default applies only when no model is configured anywhere.
 */
export function applyInterpretationSettings(
  env: LlmEnv,
  settings: LlmSettings = readLlmSettings(),
): LlmEnv {
  const base = applyLlmSettings(env, settings);
  const model = settings.interpretationModel || settings.model || base.VITE_LLM_MODEL || RECOMMENDED_CLOUD_MODEL;
  return { ...base, VITE_LLM_MODEL: model };
}

/**
 * Resolve the env for the CHAT path: stored overrides over env, with
 * `VITE_LLM_MODEL` set EXPLICITLY to the resolved chat model. Replaces the silent
 * `applyChatModelPreference` swap — the chat model is now a first-class setting,
 * so selection is configurable and visible rather than auto-magic. A per-tier
 * `chatModel` wins; otherwise the fast chat default is used on a cloud preset,
 * and a local/env model is preserved (never overridden with a cloud slug).
 */
export function applyChatSettings(env: LlmEnv, settings: LlmSettings = readLlmSettings()): LlmEnv {
  const base = applyLlmSettings(env, settings);
  const onOpenRouter = (base.VITE_LLM_API_BASE ?? "").startsWith(OPENROUTER_API_BASE);
  // Explicit chat model always wins. Otherwise: on the OpenRouter cloud preset
  // pick the fast chat default (the old applyChatModelPreference behavior); on a
  // local / custom endpoint keep the env/settings model so we never push a cloud
  // slug at a local server.
  const fallback = onOpenRouter ? CHAT_CLOUD_MODEL : base.VITE_LLM_MODEL || CHAT_CLOUD_MODEL;
  const model = settings.chatModel || fallback;
  return { ...base, VITE_LLM_MODEL: model };
}
