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

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { ComposerPrimitive, MessagePrimitive, ThreadPrimitive, useAui, type MessageState } from '@assistant-ui/react';
import { pinRelative } from '@almamesh/llm';
import { useChartLibraryStore, useChatStore, useLanguageStore } from '@almamesh/store';
import type { ChatMessage } from '@almamesh/shared-types';
import { MessageBubble } from './MessageBubble';
import { ReferenceEntry } from './ReferenceEntry';
import { SuggestedQuestions } from './SuggestedQuestions';
import { ChatSearch } from './ChatSearch';
import { useEmbedderStatus } from '../../../hooks/useEmbedderStatus';
import type { ViewMode } from '../../../lib/types';
import { useChatThread, type ChatStreamInput } from '../../../hooks/useChatThread';
import { useLlmStatus } from '../../../hooks/useLlmStatus';
import { useChartReanchorPending } from '../../../lib/chartReanchorStatus';
import { AlmaMeshAssistantRuntime } from './AlmaMeshAssistantRuntime';
import { generateProviderChatSummary } from '../../../lib/chatSummaryProvider';
import { viewerTodayDay } from '../../../lib/viewerToday';
import { TimeTravelSheet } from './TimeTravelSheet';
import { PlacePickDialog } from './PlacePickDialog';
import { staleDraftOf } from '../../../lib/chatDraft';
import { tripPeriodLabel } from '../../../lib/timeTravelThreads';
import { ChatThreadList } from './ChatThreadList';
import { CHAT_TOOLKIT, ToolCallRow, toolListOf } from './chatToolkit';
import { tripContext } from '../../../lib/tripContext';
import { TripContextCard } from './TripContextCard';

/** What a page's ask handler gets: the hook's stream input, the reader's voice and the status line. */
export interface ChatAskInput extends ChatStreamInput {
  readonly viewMode: ViewMode;
  readonly onStatus: (label: string | null) => void;
}

/** Runs one chat turn (lib/chatTurn.ts) and resolves with the final answer. */
export type ChatAsk = (input: ChatAskInput) => Promise<string>;

interface ChatPanelProps {
  personName: string;
  /** The active profile whose conversation is loaded + persisted. */
  profileId: string | null;
  /** The chart the conversation is opened from (links a fresh thread). */
  chartId: string | null;
  /** Current view mode - determines response style (plain English vs technical) */
  viewMode: ViewMode;
  /** Earliest plausible pin year (the birth year). */
  birthYear?: number;
  /** Runs one turn with bounded tools and RAG context (Dashboard, MeshEdge). */
  onAskQuestionStream: ChatAsk;
  /** Hide header when used inside FloatingChatPanel which has its own header */
  hideHeader?: boolean;
}

export function ChatPanel({
  personName,
  profileId,
  chartId,
  viewMode,
  birthYear,
  onAskQuestionStream,
  hideHeader = false,
}: ChatPanelProps) {
  const { t } = useTranslation('chat');
  const navigate = useNavigate();
  const { messages, threadId, isStreaming, streamingDraft, submit, openThread, asOf, pin, repin, backToToday } = useChatThread(
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
  // A pinned thread doesn't depend on today, so it skips the re-anchor wait (spec Part 3).
  const reanchorWaits = reanchoring && asOf === undefined;
  const sendBlocked = !aiConfigured || isStreaming || reanchorWaits;
  const today = viewerTodayDay(new Date());
  const relative = asOf ? pinRelative(asOf, today) : undefined;
  const [sheet, setSheet] = useState<'closed' | 'new' | 'change'>('closed');
  // Every trip has a place: prefill from the profile's pins, else the birth place.
  const storedChart = useChartLibraryStore((s) => (chartId ? s.getChart(chartId) : undefined));
  const birthLocation = storedChart?.birth_data?.birth_location_details;
  const language = useLanguageStore((s) => s.language);
  const tripPins = useChatStore((s) => s.threads);
  // Today's threads first, then the trips; newest first within each (one store, no copy).
  const profileThreads = useMemo(() => {
    const own = Object.values(tripPins).filter((thread) => thread.profile_id === profileId && thread.archived_at === null);
    const newest = [...own].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return [...newest.filter((thread) => !thread.as_of), ...newest.filter((thread) => thread.as_of)];
  }, [tripPins, profileId]);
  const chart = storedChart?.sidereal_chart;
  const toolkit = chart ? CHAT_TOOLKIT : undefined;
  // The trip card: built from the chart and the pin alone, like the trip line the model gets.
  const trip = useMemo(
    () => (chart && asOf ? tripContext({ chart, asOf, today, birth: storedChart?.birth_data, language }) : undefined),
    [chart, asOf, today, storedChart?.birth_data, language],
  );
  const keyTransits = useMemo(() => keyTransitsOf(messages), [messages]);
  // After the reload an app update needed: back to that thread, with the unsent message.
  const [staleDraft] = useState(() => {
    const { threads, messages: all } = useChatStore.getState();
    return profileId ? staleDraftOf(threads, all, profileId) : undefined;
  });
  useEffect(() => {
    if (staleDraft) openThread(staleDraft.threadId);
  }, [staleDraft, openThread]);
  // An old trip with no place reads the birth place; the header says which.
  const headerPlace = asOf?.place?.label ?? trip?.place.display;
  const [threadsOpen, setThreadsOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const activeTitle = threadId ? tripPins[threadId]?.title ?? null : null;
  const handleAddToolResult = useCallback((options: { readonly messageId: string; readonly toolCallId: string; readonly result: unknown; readonly isError: boolean }) => {
    if (threadId) useChatStore.getState().setToolCallResult(threadId, options.messageId, options.toolCallId, options.result, options.isError);
  }, [threadId]);
  const [backState, setBackState] = useState<'idle' | 'busy' | 'failed'>('idle');
  // Back to today saves a fresh thread first; a failed save must stay visible (Ruling 12).
  const handleBack = useCallback(async () => {
    setBackState('busy');
    try {
      await backToToday();
      setBackState('idle');
    } catch {
      setBackState('failed');
    }
  }, [backToToday]);
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
      {...(toolkit ? { toolkit } : {})}
      threads={profileThreads}
      threadId={threadId}
      onSwitchToThread={openThread}
      onSwitchToNewThread={() => void handleBack()}
      onAddToolResult={handleAddToolResult}
    >
    {/* One flex column: header rows → the scrolling thread → the composer. Nothing overlays an answer. */}
    <ThreadPrimitive.Root
      className={`flex h-full min-h-0 flex-col bg-background-secondary ${hideHeader ? '' : 'border border-ui-border rounded-xl'} overflow-hidden relative`}
      data-testid="chat-panel"
    >
      {/* Header - adapts based on mode, hidden when used in FloatingChatPanel */}
      {staleDraft && <RestoreComposerText text={staleDraft.text} />}
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

      {/* The ONE period row: which trip this is, Change · Back to today, and Tools. A
          shrink-0 sibling above the scrolling thread, with a border, so answers scroll
          under a clear edge and never look like they run beneath it. */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-ui-border bg-background-secondary px-3 py-2" data-testid="chat-thread-header">
        <button type="button" data-testid="chat-threads-button" aria-expanded={threadsOpen} aria-label={t('threads.button')} title={t('threads.button')}
          onClick={() => { setThreadsOpen((open) => !open); setToolsOpen(false); }}
          className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-text-secondary hover:bg-background-tertiary">
          <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" d="M4 6h16M4 12h16M4 18h10" /></svg>
        </button>
        {asOf ? (
          <div data-testid="time-travel-banner" className="flex min-w-0 flex-1 basis-48 flex-wrap items-center gap-x-2" role="group" aria-label={t('time_travel.banner.about')}>
            <p className="min-w-0 flex-1 basis-32 text-sm font-medium text-text-primary" data-testid="chat-thread-title" role="status">
              <span data-testid="time-travel-badge" aria-hidden="true">⏳</span>{' '}
              <span data-testid="time-travel-title">{tripPeriodLabel(asOf)}</span>
              {headerPlace && ` · ${headerPlace}`}
            </p>
            <span className="sr-only">{t('time_travel.banner.about')}</span>
            <span className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs text-text-secondary">
              <button type="button" data-testid="time-travel-change" onClick={() => setSheet('change')} className="min-h-11 px-1 underline">{t('time_travel.banner.change')}</button>
              <span aria-hidden="true">·</span>
              <button type="button" data-testid="time-travel-back" onClick={() => void handleBack()} disabled={backState === 'busy'} className="min-h-11 px-1 underline disabled:opacity-50">{t('time_travel.banner.back')}</button>
            </span>
            {backState === 'failed' && (
              <span role="alert" data-testid="time-travel-back-failed" className="basis-full text-xs text-status-error">{t('time_travel.sheet.save_failed')}</span>
            )}
          </div>
        ) : (
          <p className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary" data-testid="chat-thread-title">{activeTitle ?? t('threads.today')}</p>
        )}
        {toolkit && (
          <button type="button" data-testid="chat-tools-button" aria-expanded={toolsOpen}
            onClick={() => { setToolsOpen((open) => !open); setThreadsOpen(false); }}
            className="min-h-11 shrink-0 rounded-full border border-ui-border px-3 text-xs text-text-secondary hover:border-accent-gold">
            {t('tools.button')}
          </button>
        )}
      </div>
      {threadsOpen && <ChatThreadList onPicked={() => setThreadsOpen(false)} />}
      {toolsOpen && toolkit && (
        <div className="shrink-0 border-b border-ui-border bg-background-tertiary px-4 py-2 text-xs text-text-secondary">
          <p className="mb-1 font-medium text-text-primary">{t('tools.heading')}</p>
          <ul data-testid="chat-tools-list" className="list-disc space-y-0.5 pl-4">
            {toolListOf(toolkit, (key) => t(key)).map((row) => <li key={row.name} data-tool-name={row.name}>{row.label}</li>)}
          </ul>
        </div>
      )}

      {/* Semantic search over this profile's past conversations (discoverable). */}
      {/* Its own bordered row, so the thread below scrolls up to a clear edge, not under the box. */}
      {profileId && (
        <div className="shrink-0 border-b border-ui-border pb-3" data-testid="chat-search-row">
          <ChatSearch profileId={profileId} onOpenResult={handleOpenResult} />
        </div>
      )}

      {reanchorWaits && aiConfigured && (
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
      <ThreadPrimitive.Viewport className="min-h-0 flex-1 overflow-y-auto p-4" data-testid="chat-viewport">
        {trip && <TripContextCard trip={trip} keyTransits={keyTransits} />}
        <ThreadPrimitive.Empty>
          {!trip && (
          <div className="flex flex-col items-center justify-center py-6 text-center">
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
          )}
          {/* Starters live in the thread, below the context card: they scroll with it and never cover an answer. */}
          <SuggestedQuestions onSelect={handleSuggestedQuestion} disabled={isStreaming || reanchorWaits} relative={relative} aiConfigured={aiConfigured} />
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

      {/* Input area — or, with no AI configured, the Connect-AI CTA (a typed
          question could only fail; never invite one). */}
      <div className="shrink-0 p-3 border-t border-ui-border bg-background-tertiary" data-testid="chat-composer">
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
        <ComposerPrimitive.Root className="flex items-end gap-2">
          {/* An icon button; its name is the tooltip and the accessible label. */}
          <button type="button" data-testid="time-travel-button" onClick={() => setSheet('new')}
            disabled={isStreaming}
            aria-label={t('time_travel.button')}
            title={t('time_travel.button')}
            className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl border border-ui-border text-lg text-text-secondary hover:border-accent-gold disabled:cursor-not-allowed disabled:opacity-50">
            <span aria-hidden="true">⏳</span>
          </button>
          <ComposerPrimitive.Input
            placeholder={t('input.placeholder')}
            className="flex-1 min-w-0 px-3 py-2.5 bg-background-primary border border-ui-border rounded-xl text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent-gold/50 resize-none text-sm leading-5 disabled:opacity-50"
            minRows={2}
            maxRows={6}
            data-testid="chat-input"
          />
          <ComposerPrimitive.Send
            aria-label={t('send')}
            className="flex h-11 w-11 flex-shrink-0 items-center justify-center bg-accent-gold text-background-primary font-semibold rounded-xl hover:bg-accent-gold/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="chat-send-button"
          >
            {isStreaming ? (
              <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            ) : (
              // A right-pointing arrow (it used to read as a warning triangle).
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true" data-testid="chat-send-icon">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 12h15m-6-6 6 6-6 6" />
              </svg>
            )}
          </ComposerPrimitive.Send>
        </ComposerPrimitive.Root>
        )}
      </div>
      <TimeTravelSheet
        open={sheet !== 'closed'}
        current={sheet === 'change' ? asOf : undefined}
        birthYear={birthYear}
        birthLocation={birthLocation}
        pins={profileId ? Object.values(tripPins).filter((thread) => thread.profile_id === profileId) : []}
        today={today}
        onGo={sheet === 'change' ? repin : pin}
        onClose={() => setSheet('closed')}
      />
      <PlacePickDialog />
    </ThreadPrimitive.Root>
    </AlmaMeshAssistantRuntime>
  );
}

/** Puts text back in the thread composer once (assistant-ui's composer API). */
function RestoreComposerText({ text }: { readonly text: string }) {
  const aui = useAui();
  useEffect(() => {
    aui.thread().composer().setText(text);
  }, [aui, text]);
  return null;
}

const SLOW = ['saturn', 'jupiter', 'rahu', 'ketu', 'mars'];
const titleCase = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** The slow planets from the thread's first period reading: what the AI pulled, for the card. */
function keyTransitsOf(messages: readonly ChatMessage[]): string[] {
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (part.type !== 'tool-call' || part.toolName !== 'read_period' || part.status !== 'complete') continue;
      const rows = (part.result as { sky?: unknown } | undefined)?.sky;
      if (!Array.isArray(rows)) continue;
      const slow = rows
        .filter((row): row is { graha: string; sign: string } => typeof row?.graha === 'string' && typeof row?.sign === 'string')
        .filter((row) => SLOW.includes(row.graha.toLowerCase()));
      // A span reads each graha in each sign it moved through; the card names where each began.
      const first = slow.filter((row, index) => slow.findIndex((other) => other.graha === row.graha) === index);
      return first.map((row) => `${titleCase(row.graha)} in ${titleCase(row.sign)}`);
    }
  }
  return [];
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
      ) : (
        <>
          {/* Each tool call the AI made, drawn by its toolkit renderer (chatToolkit.tsx); unknown tools fall back to the same row. */}
          {message.content.some((part) => part.type === 'tool-call') && (
            <div className="mb-2" data-testid="chat-tool-calls">
              <MessagePrimitive.Parts components={{ Text: () => null, tools: { Fallback: ToolCallRow } }} />
            </div>
          )}
          {isLaymanMode ? (
            <MessageBubble role={message.role} content={content} timestamp={timestamp} />
          ) : (
            <ReferenceEntry role={message.role} content={content} timestamp={timestamp} />
          )}
        </>
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
  ask: ChatAsk,
  viewMode: ViewMode,
  onStatus: (label: string | null) => void,
  preparingLabel: string,
): Promise<string> {
  onStatus(preparingLabel);
  try {
    return await ask({ ...input, viewMode, onStatus });
  } finally {
    onStatus(null);
  }
}

export default ChatPanel;
