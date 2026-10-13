import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Page, Route } from '@playwright/test';

/**
 * The stubbed OpenRouter for the agent-loop context-budget stress
 * (e2e/agent-budget.stress.spec.ts). Every chat/completions body is captured;
 * a chat turn is driven to its maximum tool rounds with parallel, repeated and
 * identical calls, and answered once the app forces the final round.
 */
export const MOCK_MODELS = [
  { id: 'mock/ctx-1m', name: '1M', context_length: 1_000_000 },
  { id: 'mock/ctx-8k', name: '8k', context_length: 8192 },
] as const;
export type MockModelId = (typeof MOCK_MODELS)[number]['id'];

export const BUDGET_REPORT =
  '/private/tmp/claude-501/-Users-harish-dev-oss/38c35802-3a7a-4542-ba44-684db134e40e/scratchpad/tt-screens/budget-p1.json';

/** Decision rounds the stub keeps answering with tool calls (round 5+ is answered in text). */
export const STUB_TOOL_ROUNDS = 4;

export interface WireToolCall {
  readonly id: string;
  readonly type?: string;
  readonly function: { readonly name: string; readonly arguments: string };
}

export interface WireMessage {
  readonly role: string;
  readonly name?: string;
  readonly content?: string | null;
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly WireToolCall[];
}

interface WireBody {
  readonly messages?: readonly WireMessage[];
  readonly tools?: ReadonlyArray<{ readonly function?: { readonly name?: string } }>;
  readonly tool_choice?: string;
}

export interface CapturedRequest {
  /** 0-based index of the question this request answers. */
  readonly turn: number;
  /** 1-based request number within the turn. */
  readonly round: number;
  readonly messages: readonly WireMessage[];
  readonly tools: readonly unknown[];
  readonly toolNames: readonly string[];
  readonly toolChoice: string | undefined;
  /** What the stub answered: tool-call names, or 'answer'. */
  readonly reply: readonly string[] | 'answer';
}

interface PlannedCall {
  readonly name: string;
  readonly args: Record<string, string>;
}

const natal: PlannedCall = { name: 'get_natal_summary', args: {} };
const trip: PlannedCall = { name: 'get_trip_context', args: {} };
const periodReading: PlannedCall = { name: 'get_period_reading', args: {} };
const timing = (section: string): PlannedCall => ({ name: 'get_timing', args: { section } });

/**
 * The app gives a trip extra decision rounds only while a grounding tool is
 * still missing, so the stub holds get_trip_context back until round 4:
 * round 1 grounds the natal chart and the dashas; round 2 adds detail plus an
 * IDENTICAL repeat of round 1's natal call; round 3 asks for six calls at once
 * (four repeats, one new section, the trip sixth, past the per-round limit);
 * round 4 finally reads the trip and repeats a section. Only tools the request
 * actually offers are called.
 */
const ROUND_PLANS: ReadonlyArray<readonly PlannedCall[]> = [
  [natal, timing('dashas'), periodReading],
  [timing('transits'), timing('strength'), natal],
  [timing('domains'), timing('dashas'), timing('transits'), natal, timing('strength'), trip],
  [trip, timing('domains')],
];

export const answerText = (turn: number): string => `Budget answer ${turn + 1}.`;

const sseLine = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

function finalChunk(finish: string, bodyChars: number, completion: number): string {
  const usage = { prompt_tokens: Math.ceil(bodyChars / 4), completion_tokens: completion, total_tokens: Math.ceil(bodyChars / 4) + completion };
  return sseLine({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage }) + 'data: [DONE]\n\n';
}

function answerStream(text: string, bodyChars: number): string {
  const words = text.split(' ');
  const pieces = [words[0] ?? '', ` ${words.slice(1, 2).join(' ')}`, ` ${words.slice(2).join(' ')}`];
  const deltas = pieces.map((content) => sseLine({ choices: [{ index: 0, delta: { content } }] })).join('');
  return deltas + finalChunk('stop', bodyChars, 12);
}

function toolCallStream(calls: ReadonlyArray<PlannedCall & { id: string }>, bodyChars: number): string {
  const chunks = calls.flatMap((call, index) => {
    const args = JSON.stringify(call.args);
    const half = Math.ceil(args.length / 2);
    return [
      { index, id: call.id, type: 'function', function: { name: call.name, arguments: args.slice(0, half) } },
      { index, function: { arguments: args.slice(half) } },
    ];
  });
  const deltas = chunks.map((row) => sseLine({ choices: [{ index: 0, delta: { tool_calls: [row] } }] })).join('');
  return deltas + finalChunk('tool_calls', bodyChars, 10 * calls.length);
}

/** Tool messages, across every captured body, whose content contains `marker`. */
export function toolMessagesContaining(captured: readonly CapturedRequest[], marker: string): number {
  return captured.reduce((count, request) =>
    count + request.messages.filter((message) => message.role === 'tool' && (message.content ?? '').includes(marker)).length, 0);
}

/** The in-flight turn: everything after the last user message. */
const turnMessages = (messages: readonly WireMessage[]): readonly WireMessage[] =>
  messages.slice(messages.map((message) => message.role).lastIndexOf('user') + 1);

const lastUserText = (messages: readonly WireMessage[]): string =>
  [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';

/** Everything the stub saw, per turn, plus the knobs a journey sets. */
export class BudgetProvider {
  readonly captured: CapturedRequest[] = [];
  readonly unmatched: string[] = [];
  private readonly questions: string[] = [];
  private readonly roundsByTurn = new Map<number, number>();
  private callNumber = 0;

  /** Register the next question; its turn index is the registration order. */
  ask(question: string): number {
    this.questions.push(question);
    return this.questions.length - 1;
  }

  async install(page: Page): Promise<void> {
    await page.route('**/api/v1/models**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: MOCK_MODELS }) }),
    );
    await page.route('**/api/v1/chat/completions', (route) => this.handle(route));
  }

  private turnOf(body: WireBody): number {
    if (!Array.isArray(body.tools)) return -1;
    const text = lastUserText(body.messages ?? []);
    for (let index = this.questions.length - 1; index >= 0; index -= 1) {
      if (text.includes(this.questions[index] ?? '\u0000')) return index;
    }
    return -1;
  }

  private async handle(route: Route): Promise<void> {
    const raw = route.request().postData() ?? '{}';
    const body = JSON.parse(raw) as WireBody;
    const turn = this.turnOf(body);
    if (turn < 0) {
      // Readings, summaries and other non-chat requests: a harmless empty answer.
      this.unmatched.push(raw.slice(0, 200));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: '' } }] }) });
    }
    const round = (this.roundsByTurn.get(turn) ?? 0) + 1;
    this.roundsByTurn.set(turn, round);
    const toolNames = (body.tools ?? []).map((tool) => tool.function?.name ?? '');
    const offered = new Set(toolNames);
    const plan = body.tool_choice !== 'none' && round <= STUB_TOOL_ROUNDS
      ? (ROUND_PLANS[round - 1] ?? []).filter((call) => offered.has(call.name))
      : [];
    const calls = plan.map((call) => {
      this.callNumber += 1;
      return { ...call, id: `budget-call-${this.callNumber}` };
    });
    this.captured.push({
      turn, round, messages: body.messages ?? [], tools: body.tools ?? [], toolNames,
      toolChoice: body.tool_choice, reply: calls.length > 0 ? calls.map((call) => call.name) : 'answer',
    });
    const stream = calls.length > 0 ? toolCallStream(calls, raw.length) : answerStream(answerText(turn), raw.length);
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: stream });
  }
}

/** The prompt footprint the budget is measured in: messages + tools, chars / 4. */
export function estimatePromptTokens(request: Pick<CapturedRequest, 'messages' | 'tools'>): number {
  return Math.ceil(JSON.stringify({ messages: request.messages, tools: request.tools ?? [] }).length / 4);
}

/**
 * OpenAI pairing: every assistant tool_call id is answered by a tool message
 * with that tool_call_id in the run of tool messages straight after it.
 */
export function pairingViolations(messages: readonly WireMessage[]): string[] {
  const violations: string[] = [];
  messages.forEach((message, index) => {
    if (message.role !== 'assistant' || !message.tool_calls?.length) return;
    const answered = new Set<string>();
    for (let next = index + 1; next < messages.length && messages[next]?.role === 'tool'; next += 1) {
      answered.add(messages[next]?.tool_call_id ?? '');
    }
    for (const call of message.tool_calls) {
      if (!answered.has(call.id)) violations.push(`message ${index}: tool_call ${call.id} (${call.function.name}) has no following tool message`);
    }
  });
  return violations;
}

export interface RoundRecord {
  readonly model: MockModelId;
  readonly journey: string;
  readonly turn: number;
  readonly round: number;
  readonly estimated_prompt_tokens: number;
  readonly tool_choice: string | null;
  readonly tool_messages: number;
  readonly compacted_tool_messages: number;
  readonly budget: number;
  readonly reply: readonly string[] | 'answer';
  /** The turn's system notes after the question (finalization, missing grounding, budget), first 100 chars each. */
  readonly closing_notes: readonly string[];
  /** Tools whose result reached this request in full or compacted form (names of tool messages). */
  readonly tool_names_answered: readonly string[];
}

export interface TurnRecord {
  readonly model: MockModelId;
  readonly journey: string;
  readonly turn: number;
  readonly requests: number;
  readonly peak: number;
  readonly sum: number;
  readonly budget: number;
}

export function roundRecords(model: MockModelId, journey: string, budget: number, captured: readonly CapturedRequest[]): RoundRecord[] {
  return captured.map((request) => {
    const tools = request.messages.filter((message) => message.role === 'tool');
    return {
      model, journey, turn: request.turn + 1, round: request.round,
      estimated_prompt_tokens: estimatePromptTokens(request),
      tool_choice: request.toolChoice ?? null,
      tool_messages: tools.length,
      compacted_tool_messages: tools.filter((message) => (message.content ?? '').includes('compacted')).length,
      budget, reply: request.reply,
      closing_notes: turnMessages(request.messages).filter((message) => message.role === 'system').map((message) => (message.content ?? '').slice(0, 100)),
      tool_names_answered: [...new Set(turnMessages(request.messages).filter((message) => message.role === 'tool').map((message) => message.name ?? '?'))],
    };
  });
}

export function turnRecords(rounds: readonly RoundRecord[]): TurnRecord[] {
  const byTurn = new Map<number, RoundRecord[]>();
  for (const round of rounds) byTurn.set(round.turn, [...(byTurn.get(round.turn) ?? []), round]);
  return [...byTurn.entries()].map(([turn, rows]) => {
    const first = rows[0] as RoundRecord;
    const sizes = rows.map((row) => row.estimated_prompt_tokens);
    return { model: first.model, journey: first.journey, turn, requests: rows.length, peak: Math.max(...sizes), sum: sizes.reduce((a, b) => a + b, 0), budget: first.budget };
  });
}

/** The app's own per-round rows (window.__almameshAgentRounds()), kept verbatim for comparison. */
export interface AppTelemetry {
  readonly model: MockModelId;
  readonly journey: string;
  readonly rows: readonly unknown[];
}

interface BudgetReport {
  rounds: RoundRecord[];
  turns: TurnRecord[];
  app_telemetry: AppTelemetry[];
}

/** Merge one (model, journey) run into the report, replacing that run's earlier rows. */
export function writeBudgetReport(model: MockModelId, journey: string, rounds: readonly RoundRecord[], telemetry: readonly unknown[]): void {
  mkdirSync(dirname(BUDGET_REPORT), { recursive: true });
  let report: BudgetReport = { rounds: [], turns: [], app_telemetry: [] };
  try {
    report = { ...report, ...(JSON.parse(readFileSync(BUDGET_REPORT, 'utf8')) as Partial<BudgetReport>) };
  } catch {
    // First run: start a fresh report.
  }
  const other = (row: { model: string; journey: string }) => row.model !== model || row.journey !== journey;
  report.rounds = [...report.rounds.filter(other), ...rounds];
  report.turns = [...report.turns.filter(other), ...turnRecords(rounds)];
  report.app_telemetry = [...(report.app_telemetry ?? []).filter(other), { model, journey, rows: telemetry }];
  writeFileSync(BUDGET_REPORT, `${JSON.stringify(report, null, 2)}\n`);
}
