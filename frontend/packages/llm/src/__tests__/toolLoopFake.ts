// A fake OpenAI-compatible chat-completions endpoint for the toolLoop seam
// tests. No network: every request is recorded, and each answer is a scripted
// SSE stream (or an HTTP error) in order.

export interface FakeCall {
  readonly id: string;
  readonly name: string;
  /** Raw JSON argument text; split into several deltas when an array is given. */
  readonly args: string | readonly string[];
}

export interface FakeTurn {
  readonly text?: string;
  readonly calls?: readonly FakeCall[];
  readonly usage?: { readonly prompt: number; readonly completion: number };
  /** Answer with this HTTP status and body instead of a stream. */
  readonly status?: number;
  readonly errorBody?: string;
  /** Never answer; error the body when the request is aborted. */
  readonly hang?: boolean;
  /** Never even send headers; reject the fetch when the request is aborted. */
  readonly hangFetch?: boolean;
  /** Fail like a network error (no HTTP status): a browser's or Node's fetch. */
  readonly networkError?: "browser" | "node";
}

export interface RecordedRequest {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

export interface WireMessage {
  readonly role: string;
  readonly content: unknown;
  readonly tool_call_id?: string;
}

type Chunk = Record<string, unknown>;

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): Chunk {
  return { id: "chatcmpl-1", object: "chat.completion.chunk", created: 0, model: "fake", choices: [{ index: 0, delta, finish_reason: finishReason }] };
}

function toolChunks(call: FakeCall, index: number): Chunk[] {
  const pieces = typeof call.args === "string" ? [call.args] : call.args;
  return [
    chunk({ tool_calls: [{ index, id: call.id, type: "function", function: { name: call.name, arguments: "" } }] }),
    ...pieces.map((piece) => chunk({ tool_calls: [{ index, function: { arguments: piece } }] })),
  ];
}

export function sseBody(turn: FakeTurn): string {
  const chunks: Chunk[] = [chunk({ role: "assistant", content: "" })];
  for (const piece of turn.text?.match(/.{1,8}/gs) ?? []) chunks.push(chunk({ content: piece }));
  (turn.calls ?? []).forEach((call, index) => chunks.push(...toolChunks(call, index)));
  chunks.push(chunk({}, turn.calls?.length ? "tool_calls" : "stop"));
  const prompt = turn.usage?.prompt ?? 10;
  const completion = turn.usage?.completion ?? 5;
  chunks.push({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 0, model: "fake", choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion } });
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

function hangingResponse(signal: AbortSignal | null | undefined): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener("abort", () => controller.error(signal.reason));
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function rejectOnAbort(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason));
  });
}

function respond(turn: FakeTurn, init: RequestInit | undefined): Response {
  if (turn.hang) return hangingResponse(init?.signal);
  if (turn.status) {
    return new Response(turn.errorBody ?? "", { status: turn.status, headers: { "content-type": "application/json" } });
  }
  return new Response(sseBody(turn), { headers: { "content-type": "text/event-stream" } });
}

export interface FakeEndpoint {
  readonly fetchImpl: typeof fetch;
  readonly requests: RecordedRequest[];
}

export function fakeEndpoint(turns: readonly FakeTurn[]): FakeEndpoint {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const turn = turns[requests.length - 1];
    if (!turn) throw new Error(`unexpected request #${requests.length}`);
    if (turn.networkError === "browser") throw new TypeError("Failed to fetch");
    if (turn.networkError === "node") {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), { code: "ECONNREFUSED" }) });
    }
    if (turn.hangFetch) return rejectOnAbort(init?.signal);
    return respond(turn, init);
  }) as typeof fetch;
  return { fetchImpl, requests };
}

export function messagesOf(request: RecordedRequest | undefined): WireMessage[] {
  return (request?.body.messages ?? []) as WireMessage[];
}

export function toolMessage(request: RecordedRequest | undefined, toolCallId: string): string {
  const found = messagesOf(request).find((m) => m.role === "tool" && m.tool_call_id === toolCallId);
  if (!found) throw new Error(`no tool message for ${toolCallId}`);
  return String(found.content);
}

export interface WireTool {
  readonly type: string;
  readonly function: { readonly name: string; readonly description?: string; readonly parameters: { readonly required?: string[] }; readonly strict?: boolean };
}

export function toolsOf(request: RecordedRequest | undefined): WireTool[] {
  return (request?.body.tools ?? []) as WireTool[];
}

export async function collect(stream: AsyncGenerator<string, unknown>): Promise<{ snapshots: string[]; result: unknown }> {
  const snapshots: string[] = [];
  for (;;) {
    const next = await stream.next();
    if (next.done) return { snapshots, result: next.value };
    snapshots.push(next.value);
  }
}
