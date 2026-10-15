// Tool-result compaction (spec 2026-10-13, "Context budget for the agentic loop",
// rules 2 and 3). Within a turn, a result the budget cannot carry in full goes
// out in its compact form (`compactToolResult`). A past turn's tool results reach
// the next turn only as deterministic one-line summaries plus their key cited
// factors (`toolFactsNote`), never as full payloads. Results are deterministic,
// so the model can read again.

/** A tool result reduced to one line plus the factors it cites. */
export interface ToolSummary {
  readonly line: string;
  readonly factors?: readonly string[];
}

/** A tool's own summarizer. Must be pure and deterministic. */
export type ToolSummarizer = (result: unknown) => ToolSummary;

const MAX_LINE_CHARS = 240;
const MAX_FACTORS = 6;
const MAX_FACTOR_CHARS = 80;
const MAX_SCALAR_CHARS = 60;
const MAX_NOTE_CHARS = 1_600;

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function labelOf(value: unknown): string | undefined {
  const label = record(value)?.label;
  return typeof label === "string" && label.length > 0 ? label : undefined;
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === "string") return value.length <= MAX_SCALAR_CHARS ? value : undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

/** "error: x", the period and place labels, then short scalar fields in key order. */
function objectLine(row: Readonly<Record<string, unknown>>): string {
  if ("error" in row) return `error: ${scalarText(row.error) ?? "the tool reported an error"}`;
  const labels = [labelOf(row.period), labelOf(row.place)].filter((part): part is string => part !== undefined);
  const scalars = Object.keys(row)
    .sort()
    .flatMap((key) => {
      const text = scalarText(row[key]);
      return text === undefined ? [] : [`${key}: ${text}`];
    });
  const parts = [...labels, ...scalars];
  return parts.length > 0 ? parts.join(" · ") : `fields: ${Object.keys(row).sort().join(", ")}`;
}

/** The deterministic summary for a tool that does not give its own. */
export function defaultToolSummary(result: unknown): ToolSummary {
  if (result === null || result === undefined) return { line: "no result" };
  if (Array.isArray(result)) return { line: `${result.length} items` };
  const row = record(result);
  const line = row ? objectLine(row) : String(result);
  return { line: oneLine(line, MAX_LINE_CHARS) };
}

function bounded(summary: ToolSummary): ToolSummary {
  const factors = (summary.factors ?? [])
    .filter((factor): factor is string => typeof factor === "string" && factor.trim().length > 0)
    .slice(0, MAX_FACTORS)
    .map((factor) => oneLine(factor, MAX_FACTOR_CHARS));
  const line = oneLine(summary.line, MAX_LINE_CHARS);
  return factors.length > 0 ? { line, factors } : { line };
}

/** A result's summary: the tool's own when it gives a valid one, else the default. Always bounded. */
export function summarizeToolResult(summarize: ToolSummarizer | undefined, result: unknown): ToolSummary {
  if (summarize) {
    try {
      const own = summarize(result);
      if (typeof own?.line === "string" && own.line.trim().length > 0) return bounded(own);
    } catch {
      // A summarizer bug must never cost the turn; the default still describes the result.
    }
  }
  return bounded(defaultToolSummary(result));
}

/**
 * A result's compact form inside a turn: the tool's own compact object when it
 * gives one, else the default one-line summary. Always marked `compacted`.
 */
export function compactToolResult(result: unknown, compact?: (result: unknown) => unknown): Readonly<Record<string, unknown>> {
  if (compact) {
    try {
      const own = record(compact(result));
      if (own) return { compacted: true, ...own };
    } catch {
      // A compactor bug must never cost the turn; the default summary still describes the result.
    }
  }
  const summary = summarizeToolResult(undefined, result);
  return { ok: true, compacted: true, facts: summary.line, ...(summary.factors ? { factors: summary.factors } : {}) };
}

/** One tool call of an earlier turn, as the thread persisted it. */
export interface PriorToolCall {
  readonly toolName: string;
  readonly result: unknown;
  readonly status: "complete" | "error" | "skipped";
}

function factLine(call: PriorToolCall, summarizers: Readonly<Record<string, ToolSummarizer>>): string {
  const summary = summarizeToolResult(summarizers[call.toolName], call.result);
  const factors = summary.factors?.length ? ` (${summary.factors.join("; ")})` : "";
  return `- ${call.toolName}: ${summary.line}${factors}`;
}

/**
 * Earlier turns' successful tool results as one-line summaries, newest kept
 * when the note runs past its cap. Undefined when there is nothing to say.
 */
export function toolFactsNote(
  calls: readonly PriorToolCall[],
  summarizers: Readonly<Record<string, ToolSummarizer>> = {},
): string | undefined {
  const header = "Facts gathered by tools in earlier turns of this thread (summaries; call the tool again for full detail):";
  const lines: string[] = [];
  let chars = header.length;
  const succeeded = calls.filter((call) => call.status === "complete");
  for (let i = succeeded.length - 1; i >= 0; i -= 1) {
    const line = factLine(succeeded[i]!, summarizers);
    if (chars + line.length + 1 > MAX_NOTE_CHARS) break;
    lines.unshift(line);
    chars += line.length + 1;
  }
  return lines.length === 0 ? undefined : [header, ...lines].join("\n");
}
