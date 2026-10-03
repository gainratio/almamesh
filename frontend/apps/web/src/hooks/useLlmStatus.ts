import { useEffect, useState } from 'react';
import { describeLlmStatus, type LlmStatus } from '@almamesh/llm';
import { LLM_SETTINGS_CHANGED_EVENT } from '../lib/llmSettingsEvents';

/**
 * useLlmStatus — a LIVE view of the saved AI-provider status.
 *
 * Returns `describeLlmStatus()` and re-reads it whenever the saved settings
 * change through the `almamesh-llm-settings-changed` signal. Both same-tab
 * writes and cross-tab dataset replacement dispatch it after the SQLite-backed
 * in-memory snapshot has refreshed. This is what makes "Turn AI off" take effect
 * IMMEDIATELY across every surface that gates on AI (chat input, regenerate CTA,
 * the header badge) without a reload — a plain `describeLlmStatus()` read at
 * render is a stale snapshot that never re-evaluates on an in-place change.
 *
 * Consolidates the subscription that `AiStatusBadge` pioneered so chat/dashboard
 * gating can't drift from the header badge.
 */
export function useLlmStatus(): LlmStatus {
  const [status, setStatus] = useState<LlmStatus>(() => describeLlmStatus());
  useEffect(() => {
    const refresh = () => setStatus(describeLlmStatus());
    window.addEventListener(LLM_SETTINGS_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener(LLM_SETTINGS_CHANGED_EVENT, refresh);
    };
  }, []);
  return status;
}
