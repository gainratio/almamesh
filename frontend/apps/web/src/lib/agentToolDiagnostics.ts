/**
 * Where a chat tool's thrown error goes on this device (lib/chatTurn.ts wraps every
 * tool): one fixed warn code, plus (in hook builds) the error's class/code chain.
 * Error text can hold places and dates, so it is never printed, and nothing here
 * leaves the device.
 */
import { safeCauseWarn, safeWarn } from '@almamesh/shared-types';

import { noteIfStaleChunk } from './appStale';

export function reportAgentToolFailure(error: unknown): void {
  safeWarn('chat.tool_failed', error);
  // A tool's lazy chunk of an old build is gone: the app was updated (lib/appStale.ts).
  noteIfStaleChunk(error);
  if (import.meta.env.VITE_EXIT_GATE_HOOKS === '1') safeCauseWarn(error);
}
