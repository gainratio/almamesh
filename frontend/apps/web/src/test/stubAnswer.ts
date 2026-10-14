/**
 * A scripted chat provider for stubbed tests, unit and e2e alike (chat tool layer redesign,
 * 2026-10-14): round 1 calls read_period, the next round answers with an `answer` call built
 * from the reading that round received, so the answer passes the turn's checks (answer.ts).
 * Pure: request body in, OpenAI-compatible SSE text out. No Playwright, no network.
 */

export interface StubToolCall {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

interface WireMessage {
  readonly role: string;
  readonly content?: unknown;
}

interface ReadingLike {
  readonly period: { readonly label?: string };
  readonly place?: { readonly label?: string };
  readonly dashas: { readonly maha: readonly { readonly lord: string }[]; readonly antar: readonly { readonly lord: string }[] };
  readonly lords?: readonly { readonly lord: string; readonly rules?: readonly number[] }[];
  readonly sky?: readonly { readonly tags: readonly string[] }[];
  readonly themes?: readonly { readonly domain: string }[];
  readonly windows?: readonly { readonly date: string }[];
}

/** read_period's arguments with every key written (strict mode). */
export function readPeriodArgs(start: string, overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return { start, end: null, place: null, time: null, focus: null, ...overrides };
}

function parsed(content: unknown): unknown {
  if (typeof content !== 'string') return content;
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
}

function isReading(value: unknown): value is ReadingLike {
  return typeof value === 'object' && value !== null && 'period' in value && 'dashas' in value;
}

/** A reading the context budget sent compact: its grounding facts (chatTurn.ts, readPeriodGrounding). */
interface CompactReading {
  readonly compacted: true;
  readonly period: { readonly label?: string };
  readonly place?: { readonly label?: string };
  readonly maha: readonly string[];
  readonly antar: readonly string[];
  readonly rules: Readonly<Record<string, readonly number[]>>;
  readonly tags: readonly string[];
  readonly windows: readonly string[];
  readonly domains: readonly string[];
}

function isCompactReading(value: unknown): value is CompactReading {
  return typeof value === 'object' && value !== null && 'compacted' in value && 'maha' in value && 'antar' in value;
}

/** The facts a compact reading still gives, in a reading's shape. */
function fromCompact(compact: CompactReading): ReadingLike {
  return {
    period: compact.period,
    ...(compact.place ? { place: compact.place } : {}),
    dashas: { maha: compact.maha.map((lord) => ({ lord })), antar: compact.antar.map((lord) => ({ lord })) },
    lords: Object.entries(compact.rules).map(([lord, rules]) => ({ lord, rules })),
    sky: [{ tags: compact.tags }],
    themes: compact.domains.map((domain) => ({ domain })),
    windows: compact.windows.map((date) => ({ date })),
  };
}

function toolResults(body: { readonly messages?: readonly WireMessage[] }): unknown[] {
  return (body.messages ?? []).filter((message) => message.role === 'tool').map((message) => parsed(message.content));
}

/** Every read_period reading the request carries (whole or compact), oldest first. */
export function readingsOf(body: { readonly messages?: readonly WireMessage[] }): ReadingLike[] {
  return toolResults(body).flatMap((result) => (isReading(result) ? [result] : isCompactReading(result) ? [fromCompact(result)] : []));
}

/** The newest read_period reading the request carries, if any. */
export function readingOf(body: { readonly messages?: readonly WireMessage[] }): ReadingLike | undefined {
  const readings = readingsOf(body);
  return readings[readings.length - 1];
}

const EMPTY = { markdown: null, period: null, place: null, opening: null, dashas: null, moon: null, themes: null, windows: null, advice: null };

export function generalAnswer(markdown: string): Readonly<Record<string, unknown>> {
  return { ...EMPTY, kind: 'general', markdown };
}

/**
 * A period answer that cites only what the turn's readings say: the newest reading's period,
 * place, lords and their houses, and a Moon tag and a window from any reading (the answer
 * check takes them from every reading of the turn).
 */
export function periodAnswerFrom(readings: readonly ReadingLike[], opening = 'A steady stretch for work.'): Readonly<Record<string, unknown>> {
  const reading = readings[readings.length - 1]!;
  const rules = (lord: string) => [...(reading.lords?.find((row) => row.lord === lord)?.rules ?? [])];
  const line = (lord: string) => ({ lord, rules: rules(lord), note: `${lord} sets the tone.` });
  const tag = readings.flatMap((each) => each.sky ?? []).flatMap((span) => span.tags)[0];
  const window = readings.flatMap((each) => each.windows ?? [])[0]?.date;
  return {
    ...EMPTY,
    kind: 'period',
    period: reading.period.label ?? 'this period',
    place: reading.place?.label ?? '',
    opening,
    dashas: { maha: line(reading.dashas.maha[0]!.lord), antar: line(reading.dashas.antar[0]!.lord), pratyantar: null },
    moon: tag ? [{ tag, meaning: 'The Moon colours the mood.' }] : [],
    // An obstacle is always named: a turn that read several spans may have one with an obstacles theme.
    themes: [{ area: 'Career', direction: 'mixed', confidence: 'medium', text: 'Work asks for patience.', obstacle: 'Paperwork slows things down.' }],
    windows: window ? [{ date: window, what: 'A day to watch.' }] : [],
  };
}

/**
 * The scripted reply to one request: an answer from the reading once one came back; a general
 * answer once any other tool result came back (an ask, say); else a read_period call.
 */
export function stubCallFor(body: { readonly messages?: readonly WireMessage[] }, readArgs: Readonly<Record<string, unknown>>, opening?: string): StubToolCall {
  const readings = readingsOf(body);
  if (readings.length > 0) return { name: 'answer', args: periodAnswerFrom(readings, opening) };
  if (toolResults(body).length > 0) return { name: 'answer', args: generalAnswer('I could not read that period here.') };
  return { name: 'read_period', args: readArgs };
}

function frame(chunk: Readonly<Record<string, unknown>>): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

const choice = (delta: Readonly<Record<string, unknown>>, finish: string | null = null) =>
  ({ id: 'stub', object: 'chat.completion.chunk', created: 0, model: 'stub', choices: [{ index: 0, delta, finish_reason: finish }] });

/** One streamed tool call, OpenAI-compatible, with usage; the arguments arrive in two pieces. */
export function toolCallSse(call: StubToolCall, id = `call_${call.name}`): string {
  const args = JSON.stringify(call.args);
  const half = Math.floor(args.length / 2);
  const piece = (text: string) => choice({ tool_calls: [{ index: 0, function: { arguments: text } }] });
  return [
    frame(choice({ role: 'assistant', content: null, tool_calls: [{ index: 0, id, type: 'function', function: { name: call.name, arguments: '' } }] })),
    frame(piece(args.slice(0, half))),
    frame(piece(args.slice(half))),
    frame(choice({}, 'tool_calls')),
    frame({ id: 'stub', object: 'chat.completion.chunk', created: 0, model: 'stub', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
    'data: [DONE]\n\n',
  ].join('');
}

export interface StubEndpoint {
  readonly fetchImpl: typeof fetch;
  /** Every chat request body, in order (the model catalog read is not one). */
  readonly bodies: Record<string, unknown>[];
}

type ScriptStep = StubToolCall | ((body: Record<string, unknown>) => StubToolCall);

/** A fake OpenAI-compatible endpoint: each chat request gets the next scripted call; a model-catalog read gets a 404. */
export function stubEndpoint(script: readonly ScriptStep[]): StubEndpoint {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    if (typeof init?.body !== 'string') return new Response('{}', { status: 404 });
    const body = JSON.parse(init.body) as Record<string, unknown>;
    bodies.push(body);
    const step = script[bodies.length - 1];
    if (!step) throw new Error(`unexpected request #${bodies.length}`);
    const call = typeof step === 'function' ? step(body) : step;
    return new Response(toolCallSse(call, `c${bodies.length}`), { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  return { fetchImpl, bodies };
}
