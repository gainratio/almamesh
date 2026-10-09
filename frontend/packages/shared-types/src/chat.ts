/**
 * Chat Types for Assistant UI Integration
 * TypeScript interfaces for chat threads, messages, and streaming
 *
 * @packageDocumentation
 */

// ============================================================================
// Chat Thread Types
// ============================================================================

/**
 * A time-travel pin (spec 2026-10-08, Data and storage): the period a thread is
 * about. Only a Day pin carries a place; its coordinates never reach the model.
 */
export interface ChatThreadAsOf {
  readonly start: string;
  readonly end: string;
  readonly granularity: 'day' | 'month' | 'year';
  readonly place?: {
    readonly label: string;
    readonly timezone: string;
    readonly latitude: number;
    readonly longitude: number;
  };
}

/**
 * Chat thread metadata
 * Represents a conversation thread without messages.
 *
 * Local-first: every thread belongs to a named profile (person) on this device
 * via `profile_id`, mirroring how charts are scoped per profile. `chart_id`
 * optionally links the thread to the chart it was opened from.
 */
export interface ChatThread {
  id: string;
  /** The profile (person) this thread belongs to — local-first per-person scope. */
  profile_id: string;
  /** Optional chart the conversation was opened from. */
  chart_id?: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  message_count: number;
  /** Set only on a time-travel thread: the period its answers are about. */
  as_of?: ChatThreadAsOf;
}

/**
 * Chat message within a thread
 */
export interface ChatMessage {
  id: string;
  thread_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: string;
  token_count?: number;
  /**
   * Marks a failed-turn notice (e.g. "the model could not answer"). Error
   * turns render as error bubbles in the UI but are EXCLUDED from the
   * model-visible history — feeding an error notice back to the model as a
   * prior assistant turn poisons every subsequent answer.
   */
  error?: true;
}

/** One grounded fact retained by a rolling chat summary. */
export interface ChatSummaryItem {
  readonly text: string;
  /** Raw messages that support this item. They remain stored verbatim. */
  readonly source_message_ids: readonly string[];
}

/** Generator identity without credentials or other secret configuration. */
export interface ChatSummaryGenerator {
  readonly kind: 'llm';
  readonly model?: string;
  readonly prompt_schema_version: number;
}

/** Provider-produced content before source/provenance validation. */
export interface ChatSummaryDraft {
  readonly items: readonly ChatSummaryItem[];
  readonly open_questions: readonly string[];
}

/**
 * Durable rolling memory for one thread. Raw messages are authoritative; this
 * compact view is accepted only while its SHA-256 source hash still matches.
 */
export interface ChatThreadSummary extends ChatSummaryDraft {
  readonly thread_id: string;
  readonly profile_id: string;
  readonly source_message_ids: readonly string[];
  readonly source_hash: string;
  readonly source_message_count: number;
  readonly through_message_id: string;
  readonly generated_at: string;
  readonly generator: ChatSummaryGenerator;
}

/**
 * Chat thread with all messages included
 */
export interface ChatThreadWithMessages extends ChatThread {
  messages: ChatMessage[];
}

// ============================================================================
// Streaming Event Types
// ============================================================================

/**
 * Streaming token event during message generation
 */
export interface StreamingToken {
  content: string;
}

/**
 * Streaming completion event when message is fully generated
 */
export interface StreamingDone {
  message_id: string;
  token_count: number;
}

/**
 * Streaming error event
 */
export interface StreamingError {
  code: string;
  message: string;
  retryable: boolean;
}
