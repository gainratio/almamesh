// Chat task: drive the REAL chat prompt (sanitizeChartForLlm +
// buildChatMessages, imported from src) with canned questions, then run the
// narration through the fence checker against the same chart's engine truth.

import type { SiderealChart } from "@almamesh/browser/types";

import { buildChatMessages } from "../../src/prompt";
import { sanitizeChartForLlm } from "../../src/sanitize";

import { fenceCheck } from "./fenceCheck";
import { scoreLanguage } from "./langid";
import {
  benchChatCompletion,
  estimateTokens,
  type BenchClientOptions,
  type FetchLike,
} from "./openaiClient";
import type { ChatQuestion, ChatScore, EngineTruth, FenceViolation, LanguageTally } from "./types";

export interface ScoreChatOptions {
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly chart: SiderealChart;
  readonly truth: EngineTruth;
  readonly questions: readonly ChatQuestion[];
  readonly fetchBase: FetchLike;
  /** Pinned "now" so dasha relativization is deterministic across runs. */
  readonly now: Date;
  readonly maxTokens?: number;
  /** Returns false when the spend cap is exhausted — remaining questions skip. */
  readonly trySpendTokens?: (tokens: number) => boolean;
}

export async function scoreChat(options: ScoreChatOptions): Promise<ChatScore> {
  const sanitized = sanitizeChartForLlm(options.chart, { basis: "chart", instant: options.now });
  const maxTokens = options.maxTokens ?? 450;
  const clientOptions: Omit<BenchClientOptions, "fetchBase"> & { fetchBase: FetchLike } = {
    baseUrl: options.baseUrl,
    model: options.model,
    maxTokens,
    fetchBase: options.fetchBase,
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
  };

  const failures: string[] = [];
  const violations: FenceViolation[] = [];
  const latenciesMs: number[] = [];
  const inLanguage: Record<"es" | "pt", { ok: number; total: number }> = {
    es: { ok: 0, total: 0 },
    pt: { ok: 0, total: 0 },
  };
  let completionTokens = 0;
  let thinkBlocksSeen = 0;
  let answered = 0;

  for (const question of options.questions) {
    if (options.trySpendTokens && !options.trySpendTokens(maxTokens)) {
      failures.push(`${question.id}: skipped (spend cap reached)`);
      continue;
    }
    const messages = buildChatMessages(
      sanitized,
      question.text,
      "layman",
      [],
      [],
      undefined,
      question.language,
    );
    try {
      const completion = await benchChatCompletion(clientOptions, messages);
      answered += 1;
      latenciesMs.push(completion.ms);
      const tokens = completion.completionTokens ?? estimateTokens(completion.content);
      completionTokens += tokens;
      if (completion.thinkStripped) {
        thinkBlocksSeen += 1;
      }
      violations.push(...fenceCheck(options.truth, completion.content));
      if (question.language === "es" || question.language === "pt") {
        const tally = inLanguage[question.language];
        tally.total += 1;
        if (scoreLanguage(completion.content, question.language).inLanguage) {
          tally.ok += 1;
        }
      }
    } catch (err) {
      failures.push(`${question.id}: ${String(err)}`);
    }
  }

  return {
    questions: answered,
    failures,
    completionTokens,
    violations,
    violationsPer1k:
      completionTokens === 0 ? 0 : (violations.length / completionTokens) * 1000,
    latenciesMs,
    thinkBlocksSeen,
    inLanguage: inLanguage as Readonly<Record<"es" | "pt", LanguageTally>>,
  };
}
