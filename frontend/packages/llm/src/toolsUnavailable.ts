// Used by the toolLoop seam: the one copy of the
// tools-unavailable degrade (detect an endpoint that rejects tools, tell the
// user, answer from supplied facts) and the status-event shape the UI labels.
// No AI SDK import here, so the eager chat UI can name the status shape.

import { LlmRequestError } from "./client";

/** Safe, presentation-ready lifecycle events. No arguments, results, or reasoning. */
export type AgentStatusEvent =
  | { readonly phase: "deciding"; readonly round: number }
  | {
      readonly phase: "using_tool";
      readonly round: number;
      readonly toolName: string;
      readonly label: string;
      readonly callNumber: number;
    }
  | { readonly phase: "answering" }
  | { readonly phase: "complete" };

export const TOOLS_UNAVAILABLE_INSTRUCTION =
  "LOCAL TOOLS ARE UNAVAILABLE for this turn. Answer only from facts already present in the " +
  "conversation. Verified local facts already supplied remain available; interpret those facts " +
  "and do not claim they could not be verified. Additional local lookups or UI actions cannot run. " +
  "Never guess a current date, current time, timezone, chart fact, or current " +
  "planetary context that is not explicitly supplied; say that the required local fact is " +
  "unavailable instead.";

export const TOOLS_UNAVAILABLE_NOTICE =
  "Your AI provider does not support chat tools. I can interpret the verified local facts already supplied, " +
  "but cannot run additional tools or change the selected date this turn.\n\n";

/** The refusal's text: a 400/404/422 body (or message), else undefined. */
function refusalDetail(error: unknown): string | undefined {
  if (!(error instanceof LlmRequestError)) return undefined;
  if (![400, 404, 422].includes(error.status ?? 0)) return undefined;
  return error.body ?? error.message;
}

/**
 * A 400/404/422 whose body (or message) says the endpoint does not do tools. OpenRouter's
 * "No endpoints found that support tool use" counts.
 */
export function explicitlyRejectsTools(error: unknown): boolean {
  const detail = refusalDetail(error);
  if (detail === undefined) return false;
  const namesCapability = /\b(?:tool|tools|function|functions|tool_choice|tool_calls)\b|enable-auto-tool-choice/i;
  const namesRejection = /unsupported|not supported|unknown|invalid|requires?|enable|no endpoints found that support/i;
  return namesCapability.test(detail) && namesRejection.test(detail);
}

/**
 * A 400/404/422 that refuses the `tool_choice` value (e.g. "required"), not tools themselves:
 * OpenRouter's "No endpoints found that support the provided 'tool_choice' value", "tool_choice
 * is not supported", "Unknown parameter: tool_choice". The turn reruns under "auto".
 */
export function refusesToolChoice(error: unknown): boolean {
  const detail = refusalDetail(error);
  return detail !== undefined && /\btool_choice\b/i.test(detail) && /support|unknown|invalid|requires?/i.test(detail);
}
