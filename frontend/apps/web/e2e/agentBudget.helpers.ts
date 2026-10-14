import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Page, Route } from '@playwright/test';

import { periodAnswerFrom, readingsOf, readPeriodArgs } from './stubChatProvider';

/**
 * The stubbed OpenRouter for the chat turn's context-budget stress
 * (e2e/agent-budget.stress.spec.ts). Every chat/completions body is captured;
 * a chat turn is driven through three read_period rounds with parallel,
 * identical and over-the-cap calls, then answers with an `answer` call built
 * from its readings (chat tool layer redesign, 2026-10-14).
 */
export const MOCK_MODELS = [
  { id: 'mock/ctx-1m', name: '1M', context_length: 1_000_000 },
  { id: 'mock/ctx-8k', name: '8k', context_length: 8192 },
] as const;
export type MockModelId = (typeof MOCK_MODELS)[number]['id'];

export const BUDGET_REPORT =
  '/private/tmp/claude-501/-Users-harish-dev-oss/38c35802-3a7a-4542-ba44-684db134e40e/scratchpad/tt-screens/budget-p1.json';

/** Rounds the stub answers with read_period calls; the next one answers. */
export const STUB_TOOL_ROUNDS = 3;

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
  /** "required", or an object naming the one tool the request must call. */
  readonly tool_choice?: unknown;
}

export interface CapturedRequest {
  /** 0-based index of the question this request answers. */
  readonly turn: number;
  /** 1-based request number within the turn. */
  readonly round: number;
  readonly messages: readonly WireMessage[];
  readonly tools: readonly unknown[];
  readonly toolNames: readonly string[];
  /** "required", or the forced tool choice as JSON (e.g. the budget's forced answer). */
  readonly toolChoice: string | undefined;
  /** What the stub answered: tool-call names, or 'answer'. */
  readonly reply: readonly string[] | 'answer';
}

interface PlannedCall {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

const read = (start: string): PlannedCall => ({ name: 'read_period', args: readPeriodArgs(start) });

/**
 * Round 1 reads the trip's month; round 2 repeats it IDENTICALLY (the tool answers
 * from its turn cache) and reads the next month; round 3 asks for six reads at once,
 * past the per-turn read_period cap (3), so they come back skipped.
 */
const ROUND_PLANS: ReadonlyArray<readonly PlannedCall[]> = [
  [read('2019-05')],
  [read('2019-05'), read('2019-06')],
  ['2019-01', '2019-02', '2019-03', '2019-04', '2019-07', '2019-08'].map(read),
];

export const answerText = (turn: number): string => `Budget answer ${turn + 1}.`;

const sseLine = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

function finalChunk(finish: string, bodyChars: number, completion: number): string {
  const usage = { prompt_tokens: Math.ceil(bodyChars / 4), completion_tokens: completion, total_tokens: Math.ceil(bodyChars / 4) + completion };
  return sseLine({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage }) + 'data: [DONE]\n\n';
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
    const plan = round <= STUB_TOOL_ROUNDS ? (ROUND_PLANS[round - 1] ?? []).filter((call) => offered.has(call.name)) : [];
    const readings = readingsOf(body);
    const planned = plan.length > 0 || readings.length === 0 ? plan : [{ name: 'answer', args: periodAnswerFrom(readings, answerText(turn)) }];
    const calls = planned.map((call) => {
      this.callNumber += 1;
      return { ...call, id: `budget-call-${this.callNumber}` };
    });
    this.captured.push({
      turn, round, messages: body.messages ?? [], tools: body.tools ?? [], toolNames,
      toolChoice: typeof body.tool_choice === 'string' || body.tool_choice === undefined ? body.tool_choice : JSON.stringify(body.tool_choice), reply: plan.length > 0 ? calls.map((call) => call.name) : 'answer',
    });
    const stream = toolCallStream(calls, raw.length);
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
