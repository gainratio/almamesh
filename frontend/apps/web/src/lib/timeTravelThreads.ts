/**
 * Pin changes (Go, Change, Back to today) are on disk before the UI moves on
 * (plan Ruling 12). A failed save is rolled back in memory and rethrown, so the
 * sheet can say so and stay open.
 */
import type { ChatThreadAsOf } from '@almamesh/shared-types';
import { useChatStore } from '@almamesh/store';

import i18n from '../i18n/config';
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

const TITLE_FORMAT: Readonly<Record<ChatThreadAsOf['granularity'], Intl.DateTimeFormatOptions>> = {
  year: { year: 'numeric', timeZone: 'UTC' },
  month: { month: 'short', year: 'numeric', timeZone: 'UTC' },
  day: { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' },
};

/** A trip's period, short: 'May 2019', 'Jan 2027', '2050'. */
export function tripPeriodLabel(asOf: Pick<ChatThreadAsOf, 'start' | 'granularity'>, language: string = i18n.language || 'en'): string {
  // Noon UTC so no zone shifts the calendar day.
  return new Intl.DateTimeFormat(language, TITLE_FORMAT[asOf.granularity]).format(new Date(`${asOf.start}T12:00:00Z`));
}

/** A trip's title, from its pin: '⏳ May 2019 · Singapore'. Never from the first message. */
export function tripTitle(asOf: ChatThreadAsOf, language: string = i18n.language || 'en'): string {
  const period = tripPeriodLabel(asOf, language);
  return asOf.place ? `⏳ ${period} · ${asOf.place.label}` : `⏳ ${period}`;
}

export async function startPinnedThread(profileId: string, chartId: string | null, asOf: ChatThreadAsOf): Promise<string> {
  const chat = useChatStore.getState();
  const id = chat.startThread(profileId, chartId ?? undefined, asOf);
  chat.renameThread(id, tripTitle(asOf));
  return savedOrRemoved(id);
}

export async function repinThread(threadId: string, asOf: ChatThreadAsOf): Promise<void> {
  const previous = useChatStore.getState().threads[threadId]?.as_of;
  if (!previous) throw new Error('Only a time-travel thread can change its period.');
  const previousTitle = useChatStore.getState().threads[threadId]?.title ?? null;
  useChatStore.getState().setThreadAsOf(threadId, asOf);
  useChatStore.getState().renameThread(threadId, tripTitle(asOf));
  try {
    await waitForStoreSaved('chat');
  } catch (error) {
    useChatStore.getState().setThreadAsOf(threadId, previous);
    if (previousTitle !== null) useChatStore.getState().renameThread(threadId, previousTitle);
    throw error;
  }
}

/** The profile's latest unpinned thread, or a new one saved first. */
export async function todayThread(profileId: string, chartId: string | null): Promise<string> {
  const latest = useChatStore.getState().listThreads(profileId).find((thread) => !thread.as_of);
  if (latest) return latest.id;
  return savedOrRemoved(useChatStore.getState().startThread(profileId, chartId ?? undefined));
}
