/**
 * The one stubbed chat provider for e2e (chat tool layer redesign, 2026-10-14).
 * A chat turn is a streamed tool loop (lib/chatTurn.ts): the model calls read_period,
 * reads its result, then calls `answer` with an object the app checks against that
 * reading. These helpers answer each request with one SSE tool call, built from the
 * request itself (src/test/stubAnswer.ts), so no spec hand-rolls the protocol.
 */
import type { Route } from '@playwright/test';

import { stubCallFor, toolCallSse, type StubToolCall } from '../src/test/stubAnswer';

export { generalAnswer, readPeriodArgs } from '../src/test/stubAnswer';
export type { StubToolCall } from '../src/test/stubAnswer';

export interface WireToolCall {
  readonly id: string;
  readonly function: { readonly name: string; readonly arguments: string };
}

export interface WireMessage {
  readonly role: string;
  readonly content?: string | null;
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly WireToolCall[];
}

/** A chat tool-loop request body, as the seam sends it. */
export interface ChatToolBody {
  readonly model?: string;
  readonly stream?: boolean;
  readonly tool_choice?: unknown;
  readonly messages: readonly WireMessage[];
  readonly tools: ReadonlyArray<{ readonly function: { readonly name: string } }>;
}

/** The parsed body when this request is a chat turn's (it offers tools), else undefined. */
export function chatToolBody(postData: string | null): ChatToolBody | undefined {
  const parsed = JSON.parse(postData ?? '{}') as Partial<ChatToolBody>;
  return Array.isArray(parsed.tools) ? { ...parsed, messages: parsed.messages ?? [], tools: parsed.tools } : undefined;
}

export function toolNames(body: ChatToolBody): string[] {
  return body.tools.map((tool) => tool.function.name);
}

export interface ToolResult {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly content: string;
}

/** Every tool result the request carries, named by the call it answers. */
export function toolResults(body: ChatToolBody): ToolResult[] {
  const calls = new Map(body.messages.flatMap((message) => message.tool_calls ?? []).map((call) => [call.id, call.function]));
  return body.messages.filter((message) => message.role === 'tool').map((message) => {
    const call = calls.get(message.tool_call_id ?? '');
    return { name: call?.name ?? '', args: JSON.parse(call?.arguments || '{}') as Record<string, unknown>, content: String(message.content ?? '') };
  });
}

/** Answer one request with one streamed tool call. */
export function fulfillToolCall(route: Route, call: StubToolCall, id?: string): Promise<void> {
  return route.fulfill({ status: 200, contentType: 'text/event-stream', body: toolCallSse(call, id) });
}

/** The default turn: read_period with `readArgs`, then an answer built from the reading it got. */
export function fulfillReadThenAnswer(route: Route, body: ChatToolBody, readArgs: Readonly<Record<string, unknown>>): Promise<void> {
  return fulfillToolCall(route, stubCallFor(body, readArgs), `call_${body.messages.length}`);
}

/** A request that is not a chat turn's (a summary, a reading section): a harmless empty JSON answer. */
export function fulfillEmpty(route: Route): Promise<void> {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: '' } }] }) });
}
