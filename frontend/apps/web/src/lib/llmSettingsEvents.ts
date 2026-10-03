/**
 * Same-tab AI-settings change signal.
 *
 * The browser's `storage` event fires only in OTHER tabs, so after saving AI
 * settings in the Settings screen the header's {@link AiStatusBadge} would not
 * refresh until focus was lost and regained. Saving dispatches this custom event
 * so any live status indicator in the SAME tab re-reads `describeLlmStatus()`
 * immediately.
 */
export const LLM_SETTINGS_CHANGED_EVENT = 'almamesh-llm-settings-changed';

export interface LlmSettingsChangedDetail {
  /** A remote Replace reconstructed the mirror; open editors must reload it. */
  readonly replace?: boolean;
}

/** Fire the same-tab "AI settings changed" signal. No-op without a window. */
export function notifyLlmSettingsChanged(detail: LlmSettingsChangedDetail = {}): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(LLM_SETTINGS_CHANGED_EVENT, { detail }));
  }
}
