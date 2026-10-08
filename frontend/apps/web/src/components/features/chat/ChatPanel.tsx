/**
 * ChatPanel - Full chat interface with PERSISTED, per-profile message history.
 *
 * Interactive chat for asking astrological questions. The conversation is no
 * longer ephemeral React-local state — it is backed by the portable SQLite chat store
 * (`@almamesh/store`) via `useChatThread`, so it survives reload / PWA reopen
 * and is scoped to the active profile + chart. Each finalized turn is also
 * indexed into `@almamesh/memory` for semantic search + RAG (best-effort).
 *
 * Mode-aware rendering:
 * - "For You" (layman) mode: bubble-style MessageBubble components
 * - "Astrologer" (technical) mode: document-style ReferenceEntry components
 *
 * Honest progress UX: local-agent activity is visible before the answer, and
 * the typing dots yield as soon as the first answer chunk arrives.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { ComposerPrimitive, ThreadPrimitive, type MessageState } from '@assistant-ui/react';
import { type ChatTurn } from '@almamesh/llm';
import { MessageBubble } from './MessageBubble';
import { ReferenceEntry } from './ReferenceEntry';
import { SuggestedQuestions } from './SuggestedQuestions';
import { ChatSearch } from './ChatSearch';
import { useEmbedderStatus } from '../../../hooks/useEmbedderStatus';
import type { SSEMetaData } from '../../../lib/streaming';
import type { ViewMode } from '../../../lib/types';
import { useChatThread, type ChatStreamInput } from '../../../hooks/useChatThread';
import { useLlmStatus } from '../../../hooks/useLlmStatus';
import { useChartReanchorPending } from '../../../lib/chartReanchorStatus';
import { AlmaMeshAssistantRuntime } from './AlmaMeshAssistantRuntime';
import { generateProviderChatSummary } from '../../../lib/chatSummaryProvider';

interface ChatPanelProps {
  personName: string;
  /** The active profile whose conversation is loaded + persisted. */
  profileId: string | null;
  /** The chart the conversation is opened from (links a fresh thread). */
  chartId: string | null;
  /** Current view mode - determines response style (plain English vs technical) */
  viewMode: ViewMode;
  /** Streaming question handler — wires bounded tool orchestration with RAG context. */
  onAskQuestionStream: (
    question: string,
    onToken: (token: string) => void,
    onMeta: (meta: SSEMetaData) => void,
    viewMode?: ViewMode,
    history?: readonly ChatTurn[],
    retrievedContext?: readonly string[],
    onAgentStatus?: (label: string | null) => void,
  ) => Promise<{
    answer: string;
    timing_guidance?: string | null;
    remedies?: string[] | null;
  }>;
  /** Hide header when used inside FloatingChatPanel which has its own header */
  hideHeader?: boolean;
}

export function ChatPanel({
  personName,
  profileId,
  chartId,
  viewMode,
  onAskQuestionStream,
  hideHeader = false,
}: ChatPanelProps) {
  const { t } = useTranslation('chat');
  const navigate = useNavigate();
  const { messages, isStreaming, streamingDraft, submit, openThread } = useChatThread(
    profileId,
    chartId,
    generateProviderChatSummary,
  );
  // Whether an AI endpoint is configured (local or cloud). With none,
  // a sent question is doomed — so the send affordance is replaced by the
  // Connect-AI CTA (the dashboard's existing pattern) instead of inviting a
  // failure bubble. LIVE (useLlmStatus): turning AI off in Settings disables the
  // input immediately, so a "disconnected" chat can never keep sending.
  const aiConfigured = useLlmStatus().configured;
  // The first send loads the on-device memory model (one time, ~+80-95 MB);
  // say so instead of leaving a silent pause before the answer starts.
  const memoryModelLoading = useEmbedderStatus() === 'loading';
  // A new day's recompute of this chart is in flight. An answer streamed across
  // it would be discarded (useChatThread's chart_changed guard), so Send waits
  // and says why. It is cleared whether the recompute lands or fails.
  const reanchoring = useChartReanchorPending(chartId);
  const sendBlocked = !aiConfigured || isStreaming || reanchoring;
  const [agentActivity, setAgentActivity] = useState<string | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const messageRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const handleSubmit = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q || sendBlocked) {
        return;
      }
      // The hook owns persistence + RAG; here we only delegate the LLM streaming.
      await submit(q, (input: ChatStreamInput) =>
        streamAnswer(
          input,
          onAskQuestionStream,
          viewMode,
          setAgentActivity,
          t('agent.preparing'),
        ),
      );
    },
    [sendBlocked, submit, onAskQuestionStream, t, viewMode],
  );

  const handleSuggestedQuestion = (question: string) => {
    if (!aiConfigured) {
      // A chip tap with no AI is a doomed question: route to the Connect-AI
      // CTA's destination instead of persisting a turn that can only fail.
      navigate('/settings/ai');
      return;
    }
    void handleSubmit(question);
  };

  // Search result -> scroll to + briefly highlight the target message.
  const handleOpenResult = useCallback((messageId: string, threadId: string) => {
    openThread(threadId);
    setHighlightedMessageId(messageId);
  }, [openThread]);

  // The highlight fades after 2s. Owned by an effect so unmounting (or opening
  // another result) cancels the pending timer instead of leaking it.
  useEffect(() => {
    if (highlightedMessageId === null) return;
    const timer = window.setTimeout(() => setHighlightedMessageId(null), 2000);
    return () => window.clearTimeout(timer);
  }, [highlightedMessageId]);

  useEffect(() => {
    if (highlightedMessageId === null) return;
    messageRefs.current
      .get(highlightedMessageId)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlightedMessageId, messages]);

  const isLaymanMode = viewMode === 'layman';
  return (
    <AlmaMeshAssistantRuntime
      messages={messages}
      streamingDraft={streamingDraft}
      isRunning={isStreaming}
      isSendDisabled={sendBlocked}
      onSubmit={handleSubmit}
    >
    <ThreadPrimitive.Root
      className={`flex flex-col h-[500px] bg-background-secondary ${hideHeader ? '' : 'border border-ui-border rounded-xl'} overflow-hidden`}
      data-testid="chat-panel"
    >
      {/* Header - adapts based on mode, hidden when used in FloatingChatPanel */}
      {!hideHeader && (
        <div className="px-4 py-3 border-b border-ui-border bg-background-tertiary">
          <h3 className="text-text-primary font-semibold flex items-center gap-2">
            {isLaymanMode ? (
              <>
                <svg className="w-4 h-4 text-accent-gold" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
                {t('header.layman_title')}
              </>
            ) : (
              <>
                <svg className="w-4 h-4 text-accent-purple" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                {t('header.technical_title')}
              </>
            )}
          </h3>
          <p className="text-text-muted text-xs">
            {isLaymanMode ? t('header.layman_subtitle') : t('header.technical_subtitle')}
          </p>
        </div>
      )}

      {/* Semantic search over this profile's past conversations (discoverable). */}
      {profileId && <ChatSearch profileId={profileId} onOpenResult={handleOpenResult} />}

      {reanchoring && aiConfigured && (
        <div className="mx-4 mt-3 rounded-lg border border-ui-border px-3 py-2 text-xs text-text-muted" data-testid="chat-reanchor-status" role="status">
          {t('reanchor.updating')}
        </div>
      )}

      {isStreaming && memoryModelLoading && (
        <div className="mx-4 mt-3 rounded-lg border border-ui-border px-3 py-2 text-xs text-text-muted" data-testid="chat-memory-loading" role="status">
          {t('memory.loading_model')}
        </div>
      )}

      {isStreaming && agentActivity && (
        <div className="mx-4 mt-3 rounded-lg border border-accent-gold/30 bg-accent-gold/5 px-3 py-2 text-xs text-text-secondary" data-testid="chat-agent-status" role="status">
          {agentActivity}
        </div>
      )}

      {/* assistant-ui owns viewport scrolling and message/composer state; the
          renderers remain AlmaMesh-owned so sanitization and visual language do
          not change. */}
      <ThreadPrimitive.Viewport className="flex-1 overflow-y-auto p-4">
        <ThreadPrimitive.Empty>
          <div className="h-full flex flex-col items-center justify-center text-center">
            <div className="w-16 h-16 mb-4 rounded-full bg-accent-gold/10 flex items-center justify-center">
              <svg className="w-8 h-8 text-accent-gold" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                />
              </svg>
            </div>
            <h4 className="text-text-primary font-medium mb-2">{t('empty.title', { name: personName })}</h4>
            <p className="text-text-muted text-sm max-w-xs">{t('empty.hint')}</p>
          </div>
        </ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages>
          {({ message }) => (
            <AssistantMessageRow
              message={message}
              isLaymanMode={isLaymanMode}
              highlightedMessageId={highlightedMessageId}
              messageRefs={messageRefs}
              analyzingLabel={t('status.analyzing')}
            />
          )}
        </ThreadPrimitive.Messages>
      </ThreadPrimitive.Viewport>

      {/* Suggested questions (show when no messages or few messages) */}
      {messages.length < 3 && (
        <div className="px-4">
          <SuggestedQuestions onSelect={handleSuggestedQuestion} disabled={isStreaming || reanchoring} />
        </div>
      )}

      {/* Input area — or, with no AI configured, the Connect-AI CTA (a typed
          question could only fail; never invite one). */}
      <div className="p-4 border-t border-ui-border bg-background-tertiary">
        {!aiConfigured ? (
          <div className="flex flex-col items-start gap-2" data-testid="chat-connect-ai" role="note">
            <p className="text-sm text-text-secondary">{t('not_configured.notice')}</p>
            <Link
              to="/settings/ai"
              className="inline-flex items-center gap-2 rounded-lg border border-accent-gold px-4 py-2 text-sm font-semibold text-accent-gold transition-colors hover:bg-accent-gold/10"
              data-testid="chat-connect-ai-link"
            >
              {t('not_configured.cta')}
            </Link>
          </div>
        ) : (
        <ComposerPrimitive.Root className="flex gap-2">
          <ComposerPrimitive.Input
            placeholder={t('input.placeholder')}
            className="flex-1 min-w-0 px-4 py-3 bg-background-primary border border-ui-border rounded-xl text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent-gold/50 resize-none text-sm disabled:opacity-50"
            rows={1}
            data-testid="chat-input"
          />
          <ComposerPrimitive.Send
            className="px-4 py-3 bg-accent-gold text-background-primary font-semibold rounded-xl hover:bg-accent-gold/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="chat-send-button"
          >
            {isStreaming ? (
              <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
              </svg>
            )}
          </ComposerPrimitive.Send>
        </ComposerPrimitive.Root>
        )}
      </div>
    </ThreadPrimitive.Root>
    </AlmaMeshAssistantRuntime>
  );
}

interface AssistantMessageRowProps {
  readonly message: MessageState;
  readonly isLaymanMode: boolean;
  readonly highlightedMessageId: string | null;
  readonly messageRefs: React.MutableRefObject<Map<string, HTMLDivElement>>;
  readonly analyzingLabel: string;
}

function AssistantMessageRow({
  message,
  isLaymanMode,
  highlightedMessageId,
  messageRefs,
  analyzingLabel,
}: AssistantMessageRowProps) {
  if (message.role === 'system') return null;
  const content = message.content
    .filter((part): part is Extract<(typeof message.content)[number], { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
  const custom = message.metadata.custom as { error?: boolean; streaming?: boolean };
  const showTyping = message.role === 'assistant' && message.status?.type === 'running' && content.length === 0;
  const isHighlighted = message.id === highlightedMessageId;
  const timestamp = message.createdAt?.toISOString();

  return (
    <div
      ref={(node) => {
        if (node) messageRefs.current.set(message.id, node);
        else messageRefs.current.delete(message.id);
      }}
      className={isHighlighted ? 'rounded-xl ring-2 ring-accent-gold/60 transition-shadow' : undefined}
    >
      {showTyping ? (
        <div className={isLaymanMode ? 'flex justify-start mb-4' : 'mb-6'} data-testid="chat-loading">
          {isLaymanMode ? (
            <div className="bg-background-tertiary rounded-2xl rounded-bl-sm px-4 py-3">
              <div className="flex gap-1">
                <span className="w-2 h-2 bg-text-muted rounded-full animate-bounce" />
                <span className="w-2 h-2 bg-text-muted rounded-full animate-bounce [animation-delay:150ms]" />
                <span className="w-2 h-2 bg-text-muted rounded-full animate-bounce [animation-delay:300ms]" />
              </div>
            </div>
          ) : (
            <div className="bg-background-tertiary/50 border border-ui-border/50 rounded-lg p-4">
              <div className="flex items-center gap-3">
                <div className="flex gap-1">
                  <span className="w-2 h-2 bg-accent-purple rounded-full animate-pulse" />
                  <span className="w-2 h-2 bg-accent-purple rounded-full animate-pulse [animation-delay:150ms]" />
                  <span className="w-2 h-2 bg-accent-purple rounded-full animate-pulse [animation-delay:300ms]" />
                </div>
                <span className="text-xs text-text-muted">{analyzingLabel}</span>
              </div>
            </div>
          )}
        </div>
      ) : custom.error ? (
        <div className="flex justify-start mb-4" data-testid="chat-error-bubble" role="alert">
          <div className="max-w-[85%] rounded-2xl rounded-bl-sm border border-status-error/40 bg-status-error/10 px-4 py-3 text-sm text-status-error">
            {content}
          </div>
        </div>
      ) : isLaymanMode ? (
        <MessageBubble role={message.role} content={content} timestamp={timestamp} />
      ) : (
        <ReferenceEntry role={message.role} content={content} timestamp={timestamp} />
      )}
    </div>
  );
}

/**
 * Adapt the Dashboard's streaming handler into the `ChatStreamFn` the chat hook
 * expects: forward the RAG context + multi-turn history, surface tokens, and
 * return the final answer text.
 */
async function streamAnswer(
  input: ChatStreamInput,
  onAskQuestionStream: ChatPanelProps['onAskQuestionStream'],
  viewMode: ViewMode,
  onAgentStatus: (label: string | null) => void,
  preparingLabel: string,
): Promise<string> {
  onAgentStatus(preparingLabel);
  try {
    const response = await onAskQuestionStream(
      input.question,
      input.onToken,
      () => {
        // Meta (thread_id, etc.) intentionally unused — the store owns the thread.
      },
      viewMode,
      input.history,
      input.retrievedContext,
      onAgentStatus,
    );
    return response.answer;
  } finally {
    onAgentStatus(null);
  }
}

export default ChatPanel;
