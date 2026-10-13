/**
 * The chat agent tells the model only "tool_failed"/"tool_timeout". This is
 * where the real error goes instead: one fixed warn code, plus (in hook
 * builds) the error's class/code chain. Error text can hold places and dates,
 * so it is never printed, and nothing here leaves the device.
 */
import type { AgentToolFailure } from '@almamesh/llm';
import { safeCauseWarn, safeWarn } from '@almamesh/shared-types';

export function reportAgentToolFailure(failure: AgentToolFailure): void {
  safeWarn('chat.tool_failed', failure.error);
  if (import.meta.env.VITE_EXIT_GATE_HOOKS === '1') safeCauseWarn(failure.error);
}
