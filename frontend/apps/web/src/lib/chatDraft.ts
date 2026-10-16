/**
 * The message a person typed when a stale chunk stopped the send (lib/appStale.ts).
 * It is already in the chat row (SQLite, the only system of record): the turn
 * ends on an error notice marked `notice: 'app_updated'`. After the reload the
 * panel puts the question before that notice back in the composer. Nothing is
 * written to browser storage.
 */
import type { ChatMessage, ChatThread } from '@almamesh/shared-types';

export interface StaleDraft {
  readonly threadId: string;
  readonly text: string;
}

/** The newest thread of `profileId` whose last turn ended on the app-updated notice, with its question. */
export function staleDraftOf(
  threads: Readonly<Record<string, ChatThread>>,
  messages: Readonly<Record<string, readonly ChatMessage[]>>,
  profileId: string,
): StaleDraft | undefined {
  const newestFirst = Object.values(threads)
    .filter((thread) => thread.profile_id === profileId)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  for (const thread of newestFirst) {
    const list = messages[thread.id] ?? [];
    const last = list.at(-1);
    const question = list.at(-2);
    if (last?.notice === 'app_updated' && question?.role === 'user') return { threadId: thread.id, text: question.content };
  }
  return undefined;
}
