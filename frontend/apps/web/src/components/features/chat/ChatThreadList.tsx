/**
 * Every conversation for this profile (plan 2026-10-13, "Chat surface"), through
 * assistant-ui's thread list primitives over the ExternalStore threadList adapter
 * (AlmaMeshAssistantRuntime.tsx), which reads the one chat store. Today's
 * threads first, then the trips under "Time travel".
 */
import { ThreadListItemPrimitive, ThreadListPrimitive } from '@assistant-ui/react';
import { useTranslation } from 'react-i18next';

interface ChatThreadListProps {
  /** Called after a thread is picked (the drawer closes the list). */
  readonly onPicked: () => void;
}

function Group({ trip, onPicked }: { readonly trip: boolean; readonly onPicked: () => void }) {
  return (
    <ThreadListPrimitive.Items>
      {({ threadListItem }) => (threadListItem.custom?.trip === true) !== trip ? null : (
        <ThreadListItemPrimitive.Root data-testid="chat-thread-item" data-thread-id={threadListItem.id}
          className="rounded-lg data-[active]:bg-accent-gold/10">
          <ThreadListItemPrimitive.Trigger onClick={onPicked}
            className="w-full truncate rounded-lg px-3 py-2 text-left text-sm text-text-secondary hover:bg-background-secondary">
            <ThreadListItemPrimitive.Title fallback="…" />
          </ThreadListItemPrimitive.Trigger>
        </ThreadListItemPrimitive.Root>
      )}
    </ThreadListPrimitive.Items>
  );
}

export function ChatThreadList({ onPicked }: ChatThreadListProps) {
  const { t } = useTranslation('chat');
  return (
    <ThreadListPrimitive.Root data-testid="chat-thread-list" aria-label={t('threads.label')}
      className="flex max-h-72 flex-col gap-1 overflow-y-auto border-b border-ui-border bg-background-tertiary px-3 py-2">
      <p data-testid="chat-thread-group-today" className="px-1 text-xs font-medium uppercase tracking-wide text-text-muted">{t('threads.today')}</p>
      <Group trip={false} onPicked={onPicked} />
      <p data-testid="chat-thread-group-trips" className="mt-2 px-1 text-xs font-medium uppercase tracking-wide text-text-muted">{t('threads.trips')}</p>
      <Group trip onPicked={onPicked} />
    </ThreadListPrimitive.Root>
  );
}
