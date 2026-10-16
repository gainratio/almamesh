/**
 * "This tab is running an old build" (2026-10-13). A lazy chunk of the build this
 * page loaded is gone (a deploy, or a local preview rebuilt under an open tab).
 * The UpdateBanner then asks to reload; nothing may report it as an AI failure.
 * Memory only: a reload clears it by loading the new build.
 */
import { create } from 'zustand';

import { isChunkLoadError } from './chunkError';

interface AppStaleState {
  readonly stale: boolean;
  markStale(): void;
}

export const useAppStale = create<AppStaleState>((set) => ({
  stale: false,
  markStale: () => set({ stale: true }),
}));

/** Ends a chat turn whose tool ran into a stale chunk: the answer belongs to the app update. */
export class StaleAppError extends Error {
  constructor() {
    super('AlmaMesh was updated while this answer was prepared.');
    this.name = 'StaleAppError';
  }
}

/** True (and the update notice raised) when `error` is a failed chunk load. */
export function noteIfStaleChunk(error: unknown): boolean {
  if (!isChunkLoadError(error)) return false;
  useAppStale.getState().markStale();
  return true;
}
