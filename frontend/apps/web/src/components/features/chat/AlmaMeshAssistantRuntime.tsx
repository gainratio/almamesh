import { useCallback, useMemo, type PropsWithChildren } from 'react';
import {
  AssistantRuntimeProvider,
  AuiConfig,
  Tools,
  useExternalStoreRuntime,
  type AppendMessage,
  type ExternalStoreThreadListAdapter,
  type ThreadMessageLike,
  type Toolkit,
} from '@assistant-ui/react';

import type { ChatMessage, ChatMessagePart, ChatThread } from '@almamesh/shared-types';

interface ConvertOptions {
  readonly streaming?: boolean;
}

/** Convert the app's durable chat contract into assistant-ui's presentation contract. */
export function convertChatMessage(
  message: ChatMessage,
  options: ConvertOptions = {},
): ThreadMessageLike {
  const streaming = options.streaming === true;
  const createdAt = new Date(message.created_at);
  return {
    id: message.id,
    role: message.role,
    content: message.parts && message.parts.length > 0
      ? message.parts.map(toRuntimePart)
      : [{ type: 'text', text: message.content }],
    createdAt: Number.isNaN(createdAt.valueOf()) ? new Date(0) : createdAt,
    ...(message.role === 'assistant'
      ? { status: streaming ? ({ type: 'running' } as const) : ({ type: 'complete', reason: 'stop' } as const) }
      : {}),
    metadata: {
      custom: {
        error: message.error === true,
        streaming,
      },
    },
  };
}

type RuntimePart = Exclude<ThreadMessageLike['content'], string>[number];

/** A persisted part as assistant-ui sees it: the same args and result the model got. */
function toRuntimePart(part: ChatMessagePart): RuntimePart {
  if (part.type === 'text') return { type: 'text', text: part.text };
  return {
    type: 'tool-call',
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    args: part.args as Record<string, never>,
    argsText: JSON.stringify(part.args),
    result: part.result,
    isError: part.status === 'error',
    // A skipped call was answered without running: the row reads it off the artifact.
    ...(part.status === 'skipped' ? { artifact: { status: 'skipped' } } : {}),
  };
}

/** One thread in the list: its id, its title, and whether it is a trip. */
export function threadListEntry(thread: ChatThread) {
  return {
    status: 'regular' as const,
    id: thread.id,
    ...(thread.title ? { title: thread.title } : {}),
    custom: { trip: thread.as_of !== undefined },
  };
}

type ComposerPayload = Pick<AppendMessage, 'content'>;

/** AlmaMesh intentionally accepts text-only chat input in this first runtime integration. */
export function textFromComposerMessage(message: ComposerPayload): string {
  const parts = message.content;
  if (parts.some((part) => part.type !== 'text')) {
    throw new Error('AlmaMesh chat is text-only.');
  }
  return parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

export interface AlmaMeshAssistantRuntimeProps extends PropsWithChildren {
  readonly messages: readonly ChatMessage[];
  readonly streamingDraft: string;
  readonly isRunning: boolean;
  readonly isSendDisabled: boolean;
  readonly onSubmit: (question: string) => Promise<void>;
  /** The thread's registered tools: their renderers draw its tool-call rows (chatToolkit.tsx). */
  readonly toolkit?: Toolkit;
  /** The profile's threads, backed by the chat store (no second store). */
  readonly threads?: readonly ChatThread[];
  readonly threadId?: string | null;
  readonly onSwitchToThread?: (threadId: string) => void;
  readonly onSwitchToNewThread?: () => void;
  /** A tool UI supplied a result: record it on the stored part. */
  readonly onAddToolResult?: (options: { readonly messageId: string; readonly toolCallId: string; readonly result: unknown; readonly isError: boolean }) => void;
}

/**
 * A deliberately narrow assistant-ui ExternalStoreRuntime over AlmaMesh state.
 * The app store remains authoritative; assistant-ui owns presentation only.
 */
export function AlmaMeshAssistantRuntime({
  messages,
  streamingDraft,
  isRunning,
  isSendDisabled,
  onSubmit,
  toolkit,
  threads,
  threadId,
  onSwitchToThread,
  onSwitchToNewThread,
  onAddToolResult,
  children,
}: AlmaMeshAssistantRuntimeProps) {
  const runtimeMessages = useMemo(() => {
    const converted = messages.map((message) => convertChatMessage(message));
    if (!isRunning || streamingDraft.length === 0) {
      return converted;
    }
    const tailId = messages.at(-1)?.id ?? 'new-thread';
    const tailCreatedAt = messages.at(-1)?.created_at ?? new Date().toISOString();
    const synthetic: ChatMessage = {
      id: `stream:${tailId}`,
      thread_id: messages.at(-1)?.thread_id ?? 'pending',
      role: 'assistant',
      content: streamingDraft,
      created_at: tailCreatedAt,
    };
    return [...converted, convertChatMessage(synthetic, { streaming: true })];
  }, [isRunning, messages, streamingDraft]);

  const onNew = useCallback(
    async (message: AppendMessage) => {
      const text = textFromComposerMessage(message).trim();
      if (text.length > 0) {
        await onSubmit(text);
      }
    },
    [onSubmit],
  );

  const threadList = useMemo<ExternalStoreThreadListAdapter | undefined>(() => (threads ? {
    threadId: threadId ?? undefined,
    threads: threads.map(threadListEntry),
    onSwitchToThread: (id) => onSwitchToThread?.(id),
    onSwitchToNewThread: () => onSwitchToNewThread?.(),
  } : undefined), [threads, threadId, onSwitchToThread, onSwitchToNewThread]);

  const runtime = useExternalStoreRuntime({
    messages: runtimeMessages,
    convertMessage: (message) => message,
    isRunning,
    isSendDisabled,
    onNew,
    ...(onAddToolResult ? { onAddToolResult: ({ messageId, toolCallId, result, isError }) => onAddToolResult({ messageId, toolCallId, result, isError: isError === true }) } : {}),
    ...(threadList ? { adapters: { threadList } } : {}),
  });
  const config = useMemo(() => (toolkit ? AuiConfig({ tools: Tools({ toolkit }) }) : undefined), [toolkit]);

  return <AssistantRuntimeProvider runtime={runtime} {...(config ? { config } : {})}>{children}</AssistantRuntimeProvider>;
}
