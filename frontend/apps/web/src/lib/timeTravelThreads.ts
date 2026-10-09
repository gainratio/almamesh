/**
 * Pin changes (Go, Change, Back to today) are on disk before the UI moves on
 * (plan Ruling 12). A failed save is rolled back in memory and rethrown, so the
 * sheet can say so and stay open.
 */
import type { ChatThreadAsOf } from '@almamesh/shared-types';
import { useChatStore } from '@almamesh/store';

import { waitForStoreSaved } from './storeSaved';

async function savedOrRemoved(threadId: string): Promise<string> {
  try {
    await waitForStoreSaved('chat');
  } catch (error) {
    useChatStore.getState().deleteThread(threadId);
    throw error;
  }
  return threadId;
}

export async function startPinnedThread(profileId: string, chartId: string | null, asOf: ChatThreadAsOf): Promise<string> {
  return savedOrRemoved(useChatStore.getState().startThread(profileId, chartId ?? undefined, asOf));
}

export async function repinThread(threadId: string, asOf: ChatThreadAsOf): Promise<void> {
  const previous = useChatStore.getState().threads[threadId]?.as_of;
  if (!previous) throw new Error('Only a time-travel thread can change its period.');
  useChatStore.getState().setThreadAsOf(threadId, asOf);
  try {
    await waitForStoreSaved('chat');
  } catch (error) {
    useChatStore.getState().setThreadAsOf(threadId, previous);
    throw error;
  }
}

/** The profile's latest unpinned thread, or a new one saved first. */
export async function todayThread(profileId: string, chartId: string | null): Promise<string> {
  const latest = useChatStore.getState().listThreads(profileId).find((thread) => !thread.as_of);
  if (latest) return latest.id;
  return savedOrRemoved(useChatStore.getState().startThread(profileId, chartId ?? undefined));
}
