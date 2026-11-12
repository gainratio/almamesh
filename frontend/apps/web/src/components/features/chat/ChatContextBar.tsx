/**
 * Compact single-row Context Bar inside `ChatPanel`.
 *
 * Always visible (even when `hideHeader={true}` inside `FloatingChatPanel` on
 * `Dashboard` and `MeshEdge`) so users always see and control:
 * 1. Current city (`📍 Novato, CA` / `📍 Set location` inline popover chip)
 * 2. Active Specialist agent pill (routed deterministically from the latest turn)
 * 3. Durable on-device Memory notes (`🧠` popover with 1-click delete)
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { selectSpecialistsForTurn, type SpecialistAgentId } from '@almamesh/llm';
import type { ChatMessage } from '@almamesh/shared-types';
import { getCurrentPlace, useProfilesStore } from '@almamesh/store';

import { ChatLocationChip } from './ChatLocationChip';
import { ChatMemoryPopover } from './ChatMemoryPopover';

interface ChatContextBarProps {
  readonly profileId: string | null;
  readonly threadId: string | null;
  readonly messages: readonly ChatMessage[];
  readonly initialDraft?: string;
}

const SPECIALIST_ICONS: Readonly<Record<SpecialistAgentId, string>> = {
  timing_panchang: '☀',
  natal_varga: '◈',
  mesh_synastry: '⚭',
  rectification_advisor: '⏱',
};

export function ChatContextBar({ profileId, threadId, messages, initialDraft }: ChatContextBarProps) {
  const { t } = useTranslation('chat');
  const activeProfileId = useProfilesStore((s) => s.activeProfileId);
  const targetId = profileId && useProfilesStore.getState().profiles[profileId] ? profileId : activeProfileId;
  const hasPlace = useProfilesStore((s) => Boolean(targetId && getCurrentPlace(s.profiles[targetId])));

  const activeSpecialist = useMemo((): SpecialistAgentId => {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? initialDraft ?? '';
    if (!lastUser.trim()) return 'timing_panchang';
    const plan = selectSpecialistsForTurn(lastUser, { hasHomePlace: hasPlace });
    return plan.activeSpecialists[0]?.id ?? 'timing_panchang';
  }, [messages, initialDraft, hasPlace]);

  return (
    <div
      data-testid="chat-context-bar"
      className="flex shrink-0 flex-wrap items-center gap-1 border-b border-ui-border bg-background-secondary/80 px-2.5 py-1.5"
    >
      <ChatLocationChip profileId={profileId} />
      <span
        data-testid="chat-specialist-pill"
        data-specialist={activeSpecialist}
        className="inline-flex min-h-7 max-w-[126px] items-center gap-1 rounded-full border border-ui-border/80 bg-background-tertiary/70 px-2 py-0.5 text-[11px] text-text-secondary sm:max-w-none"
      >
        <span aria-hidden="true" className="text-accent-gold">{SPECIALIST_ICONS[activeSpecialist]}</span>
        <span className="truncate">{t(`context.specialists.${activeSpecialist}`)}</span>
      </span>
      <ChatMemoryPopover profileId={profileId} threadId={threadId} />
    </div>
  );
}
