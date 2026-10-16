/**
 * The chat tool registry (plan 2026-10-13, "The assistant-ui toolkit is the
 * registry"; chat tool layer redesign 2026-10-14). One seam file: `@assistant-ui/react`'s
 * toolkit API is imported here and in the other chat seam files only.
 *
 * The model's tools are read_period and travel (lib/chatTurn.ts runs them through the
 * tool loop, loaded on send). This registry gives each a plain-words label for the
 * visible Tools list and a renderer for its rows in the transcript; it carries no
 * schema and no handler, so the page's first chunk never loads the tool loop.
 */
import { defineToolkit, type Toolkit, type ToolCallMessagePartProps } from '@assistant-ui/react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface ChatToolCatalogEntry {
  /** chat.json key for the one-line name shown in the Tools list and on each call row. */
  readonly labelKey: string;
}

/** Every tool the chat registers, with its plain-words label. */
export const CHAT_TOOL_CATALOG: Readonly<Record<string, ChatToolCatalogEntry>> = {
  read_period: { labelKey: 'tools.read_period' },
  travel: { labelKey: 'tools.travel' },
};

/** Render-only entries: the tool loop (lib/chatTurn.ts) runs the tools; assistant-ui only draws their rows. */
export const CHAT_TOOLKIT: Toolkit = defineToolkit(Object.fromEntries(Object.keys(CHAT_TOOL_CATALOG).map((name) => [name, {
  type: 'backend' as const,
  render: ToolCallRow,
}])));

export interface ChatToolListRow {
  readonly name: string;
  readonly label: string;
}

/** The visible "Tools" list: every registered tool, labelled in plain words. */
export function toolListOf(toolkit: Toolkit, translate: (key: string) => string): ChatToolListRow[] {
  return Object.keys(toolkit).map((name) => ({ name, label: translate(CHAT_TOOL_CATALOG[name]?.labelKey ?? name) }));
}

type ToolCallRowProps = Pick<ToolCallMessagePartProps, 'toolName' | 'toolCallId' | 'args' | 'argsText' | 'result' | 'isError' | 'status' | 'artifact'>;

type RowOutcome = 'complete' | 'error' | 'skipped';

/**
 * Threads saved before the tool redesign (2026-10-14) hold rows for the old tools. They are
 * drawn under the subject the new tools use (tools.rows.<subject>); a bare tool name is never shown.
 */
const LEGACY_SUBJECTS: Readonly<Record<string, string>> = {
  get_timing: 'read_period',
  get_period_reading: 'read_period',
  get_period_detail: 'read_period',
  get_trip_context: 'read_period',
  resolve_place: 'place',
  time_travel: 'travel',
  get_natal_summary: 'context',
  get_chart_facts: 'context',
  get_current_datetime: 'context',
};

function isLegacy(toolName: string): boolean {
  return Object.hasOwn(LEGACY_SUBJECTS, toolName);
}

/** An old row recorded a failure as {code} or {error}; a new read_period ask may carry a code and still be complete. */
function legacyFailed(result: unknown): boolean {
  const old = result as { code?: unknown; error?: unknown } | null | undefined;
  return old?.code !== undefined || old?.error !== undefined;
}

/** Skipped (answered without running) is its own neutral outcome; then a failure; else complete. */
function outcomeOf(toolName: string, isError: boolean | undefined, result: unknown, artifact: unknown): RowOutcome {
  if (isError !== true && (artifact as { status?: unknown } | null | undefined)?.status === 'skipped') return 'skipped';
  // A returned "unavailable" (read_period's typed reasons) is a lookup that got nothing. An ask (needs_place, a place to pick) completed.
  if (isLegacy(toolName) && legacyFailed(result)) return 'error';
  return isError === true || (result as { available?: unknown } | null)?.available === false ? 'error' : 'complete';
}

const ROW_KEYS: Readonly<Record<RowOutcome, string>> = { complete: 'tools.row', error: 'tools.row_failed', skipped: 'tools.row_skipped' };

interface ResultHints {
  readonly period?: { readonly label?: unknown; readonly start?: unknown; readonly end?: unknown };
  readonly place?: { readonly label?: unknown };
  /** travel's result. */
  readonly period_label?: unknown;
  readonly place_label?: unknown;
}

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

/** What the call was about: the tool, in plain words. */
function subjectOf(toolName: string, translate: (key: string) => string): string {
  if (isLegacy(toolName)) return translate(`tools.rows.${LEGACY_SUBJECTS[toolName]}`);
  return Object.hasOwn(CHAT_TOOL_CATALOG, toolName) ? translate(`tools.rows.${toolName}`) : toolName;
}

/**
 * "Looked up the period reading · May 2019 · Singapore": what, when and where, from the result the model got.
 * When before where: a narrow row truncates the place (the thread header names it), never the period.
 */
function summaryOf(toolName: string, result: unknown, language: string, translate: (key: string) => string): string {
  const hints = (result ?? {}) as ResultHints;
  const place = text(hints.place?.label) ?? text(hints.place_label);
  const start = text(hints.period?.start);
  const end = text(hints.period?.end);
  const period = text(hints.period?.label) ?? text(hints.period_label) ?? (start && end ? periodText(start, end, language) : undefined);
  return [subjectOf(toolName, translate), period, place].filter((part): part is string => part !== undefined).join(' · ');
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
export function ToolCallRow({ toolName, toolCallId, args, result, isError, artifact }: ToolCallRowProps) {
  const { t, i18n } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const outcome = outcomeOf(toolName, isError, result, artifact);
  const summary = summaryOf(toolName, result, i18n.language || 'en', (key) => t(key));
  const sentence = t(ROW_KEYS[outcome], { what: summary });
  return (
    <details className={`mb-2 rounded-lg border border-ui-border bg-background-tertiary/60 px-3 py-2 text-xs ${outcome === 'skipped' ? 'text-text-muted' : 'text-text-secondary'}`}
      data-testid="chat-tool-call" data-tool-name={toolName} data-tool-call-id={toolCallId} data-status={outcome}
      onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer select-none truncate" data-testid="chat-tool-call-summary" title={sentence}>
        {sentence}
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
