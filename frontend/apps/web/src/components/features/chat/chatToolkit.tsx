/**
 * The chat tool registry (plan 2026-10-13, "The assistant-ui toolkit is the
 * registry"). One seam file: `@assistant-ui/react`'s toolkit API is imported
 * here and in the other chat seam files only.
 *
 * `buildChatToolkit` turns the turn's bound AgentTools (chatToolset.ts: trip
 * binding and handlers) into an assistant-ui toolkit: description, JSON schema,
 * execute and a renderer per tool. The agent loop reads its tool list back out
 * of that same toolkit (`agentToolsOf`), and the visible Tools list reads it too
 * (`toolListOf`), so what the model is offered and what the person sees cannot
 * disagree. Only tools the catalog names are registered.
 */
import { defineToolkit, type Toolkit, type ToolCallMessagePartProps } from '@assistant-ui/react';
import type { AgentJsonObject, AgentTool, AgentToolContext } from '@almamesh/llm';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface ChatToolCatalogEntry {
  /** chat.json key for the one-line name shown in the Tools list and on each call row. */
  readonly labelKey: string;
}

/** Every tool the chat may register, with its plain-words label. */
export const CHAT_TOOL_CATALOG: Readonly<Record<string, ChatToolCatalogEntry>> = {
  get_natal_summary: { labelKey: 'tools.get_natal_summary' },
  get_trip_context: { labelKey: 'tools.get_trip_context' },
  get_timing: { labelKey: 'tools.get_timing' },
  resolve_place: { labelKey: 'tools.resolve_place' },
  time_travel: { labelKey: 'tools.time_travel' },
  get_chart_facts: { labelKey: 'tools.get_chart_facts' },
  get_current_datetime: { labelKey: 'tools.get_current_datetime' },
};

/** The bound AgentTool behind each registered toolkit entry (the handler the agent loop runs). */
const boundTools = new WeakMap<Toolkit, ReadonlyMap<string, AgentTool>>();

export function buildChatToolkit(tools: readonly AgentTool[]): Toolkit {
  const registered = tools.filter((tool) => Object.hasOwn(CHAT_TOOL_CATALOG, tool.name));
  const toolkit = defineToolkit(Object.fromEntries(registered.map((tool) => [tool.name, {
    type: 'frontend' as const,
    description: tool.description,
    parameters: tool.parameters,
    // The agent loop (packages/llm) executes; assistant-ui's own tool
    // invocation stays off (unstable_enableToolInvocations is not set).
    execute: (args: Record<string, unknown>, context: unknown) => tool.execute(args as AgentJsonObject, context as AgentToolContext),
    render: ToolCallRow,
  }])));
  boundTools.set(toolkit, new Map(registered.map((tool) => [tool.name, tool])));
  return toolkit;
}

/** The model's tool list, read from the toolkit: its names and schemas, the bound handlers. */
export function agentToolsOf(toolkit: Toolkit): AgentTool[] {
  const bound = boundTools.get(toolkit);
  return Object.entries(toolkit).flatMap(([name, entry]) => {
    const tool = bound?.get(name);
    if (!tool) return [];
    return [{
      ...tool,
      name,
      description: entry.description ?? tool.description,
      parameters: (entry.parameters ?? tool.parameters) as AgentJsonObject,
    }];
  });
}

export interface ChatToolListRow {
  readonly name: string;
  readonly label: string;
}

/** The visible "Tools" list: every registered tool, labelled in plain words. */
export function toolListOf(toolkit: Toolkit, translate: (key: string) => string): ChatToolListRow[] {
  return Object.keys(toolkit).map((name) => ({ name, label: translate(CHAT_TOOL_CATALOG[name]?.labelKey ?? name) }));
}

type ToolCallRowProps = Pick<ToolCallMessagePartProps, 'toolName' | 'toolCallId' | 'args' | 'argsText' | 'result' | 'isError' | 'status'>;

interface ResultHints {
  readonly period?: { readonly label?: unknown; readonly start?: unknown; readonly end?: unknown };
  readonly place?: { readonly label?: unknown };
  readonly places?: ReadonlyArray<{ readonly label?: unknown }>;
}

const SECTIONS = new Set(['dashas', 'transits', 'strength', 'domains']);

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function lastDayOf(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** A period as people say it: "May 2019", "2019", "4 May 2019", else its two dates. */
function periodText(start: string, end: string, language: string): string {
  const [y, m, d] = start.split('-').map(Number);
  const noon = new Date(`${start}T12:00:00Z`);
  const format = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(language, { ...options, timeZone: 'UTC' }).format(noon);
  if (start === end) return format({ day: 'numeric', month: 'short', year: 'numeric' });
  if (start.endsWith('-01-01') && end === `${y}-12-31`) return String(y);
  if (d === 1 && end === `${start.slice(0, 7)}-${String(lastDayOf(y, m)).padStart(2, '0')}`) return format({ month: 'long', year: 'numeric' });
  return `${start} – ${end}`;
}

/** What the call was about: the section asked for, else the tool, in plain words. */
function subjectOf(toolName: string, args: unknown, translate: (key: string) => string): string {
  const section = text((args as { section?: unknown } | null)?.section);
  if (toolName === 'get_timing' && section && SECTIONS.has(section)) return translate(`tools.sections.${section}`);
  return Object.hasOwn(CHAT_TOOL_CATALOG, toolName) ? translate(`tools.rows.${toolName}`) : toolName;
}

/** "Looked up transits · Singapore · May 2019": what, where and when, from the result the model got. */
function summaryOf(toolName: string, args: unknown, result: unknown, language: string, translate: (key: string) => string): string {
  const hints = (result ?? {}) as ResultHints;
  const place = text(hints.place?.label) ?? text(hints.places?.[0]?.label);
  const start = text(hints.period?.start);
  const end = text(hints.period?.end);
  const period = text(hints.period?.label) ?? (start && end ? periodText(start, end, language) : undefined);
  return [subjectOf(toolName, args, translate), place, period].filter((part): part is string => part !== undefined).join(' · ');
}

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return '';
  }
}

/**
 * One tool call in the transcript, collapsed to a sentence. Opening it shows
 * the exact args and result the model got (rendered only once opened).
 */
export function ToolCallRow({ toolName, toolCallId, args, result, isError }: ToolCallRowProps) {
  const { t, i18n } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const failed = isError === true || (result as { code?: unknown } | null)?.code !== undefined;
  const summary = summaryOf(toolName, args, result, i18n.language || 'en', (key) => t(key));
  return (
    <details className="mb-2 rounded-lg border border-ui-border bg-background-tertiary/60 px-3 py-2 text-xs text-text-secondary"
      data-testid="chat-tool-call" data-tool-name={toolName} data-tool-call-id={toolCallId} data-status={failed ? 'error' : 'complete'}
      onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer select-none truncate" data-testid="chat-tool-call-summary">
        {t(failed ? 'tools.row_failed' : 'tools.row', { what: summary })}
      </summary>
      {open && (
        <div className="mt-2 space-y-2">
          <p className="text-text-muted">{t('tools.args')}</p>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-background-primary p-2" data-testid="chat-tool-call-args">{pretty(args)}</pre>
          <p className="text-text-muted">{t('tools.result')}</p>
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-background-primary p-2" data-testid="chat-tool-call-result">{pretty(result)}</pre>
        </div>
      )}
    </details>
  );
}
