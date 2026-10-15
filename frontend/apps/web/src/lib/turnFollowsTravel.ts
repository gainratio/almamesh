/**
 * The answer follows the user (2026-10-14). A chat-initiated travel switches the panel to another
 * thread after the answer is saved; the turn that asked for it (question and answer) moves there
 * too, so the user never lands in an empty trip. The thread it was asked in keeps a one-line,
 * clickable pointer ("Moved to ⏳ Sep 2017 · Mumbai"), or is removed when nothing else was in it.
 */
import { useChatStore } from '@almamesh/store';

import i18n from '../i18n/config';
import { indexChatMessage } from './chatMemory';

/** "Moved to ⏳ Sep 2017 · Mumbai, India", or "Moved to today" for an untitled today thread. */
export function movedPointer(title: string | null | undefined): string {
  return title ? i18n.t('chat:moved.to', { title }) : i18n.t('chat:moved.today');
}

/** Moves the turn's messages from `fromId` to `toId`; true when they moved. The memory index follows. */
export function moveTurnToThread(fromId: string, toId: string, messageIds: readonly string[]): boolean {
  const chat = useChatStore.getState();
  const target = chat.threads[toId];
  if (!target || !chat.moveMessages(fromId, toId, messageIds, movedPointer(target.title))) return false;
  for (const message of useChatStore.getState().getMessages(toId)) {
    if (messageIds.includes(message.id)) {
      void indexChatMessage({ id: message.id, thread_id: toId, profile_id: target.profile_id, content: message.content });
    }
  }
  return true;
}
