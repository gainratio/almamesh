/**
 * One-time suggestion for users still on z-ai/glm-5.3-flash to switch to the
 * new default (RECOMMENDED_CLOUD_MODEL). We never rewrite a model the user
 * chose: the switch happens only when they click it. "Keep" or "Switch" both
 * dismiss it for good (per browser, localStorage).
 */

import { OPENROUTER_API_BASE, RECOMMENDED_CLOUD_MODEL, type LlmSettings } from '@almamesh/llm';

/** The model the suggestion is about. It once reasoned 20+ minutes on one section. */
const SLOW_MODEL = 'z-ai/glm-5.3-flash';

const DISMISSED_KEY = 'almamesh-model-suggestion-dismissed';

/**
 * The settings after switching every tier that is on SLOW_MODEL to the new
 * default, or null when there is nothing to suggest (another model, or not
 * OpenRouter: a local/BYO endpoint cannot serve an OpenRouter slug).
 */
export function slowModelSwitch(settings: LlmSettings): LlmSettings | null {
  if (!(settings.apiBase ?? '').startsWith(OPENROUTER_API_BASE)) return null;
  const interpretation = settings.interpretationModel || settings.model;
  const onSlow = interpretation === SLOW_MODEL || settings.chatModel === SLOW_MODEL;
  if (!onSlow) return null;
  const swapInterp = interpretation === SLOW_MODEL;
  return {
    ...settings,
    ...(swapInterp ? { model: RECOMMENDED_CLOUD_MODEL, interpretationModel: RECOMMENDED_CLOUD_MODEL } : {}),
    ...(settings.chatModel === SLOW_MODEL ? { chatModel: RECOMMENDED_CLOUD_MODEL } : {}),
  };
}

export function isSlowModelSuggestionDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === SLOW_MODEL;
  } catch {
    return false;
  }
}

export function dismissSlowModelSuggestion(): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, SLOW_MODEL);
  } catch {
    // Storage blocked: the card simply shows again next visit. Harmless.
  }
}
