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

/** A 400/404/422 whose body (or message) says the endpoint does not do tools. */
export function explicitlyRejectsTools(error: unknown): boolean {
  if (!(error instanceof LlmRequestError)) return false;
  if (![400, 404, 422].includes(error.status ?? 0)) return false;
  const detail = error.body ?? error.message;
  const namesCapability = /\b(?:tool|tools|function|functions|tool_choice|tool_calls)\b|enable-auto-tool-choice/i;
  const namesRejection = /unsupported|not supported|unknown|invalid|requires?|enable/i;
  return namesCapability.test(detail) && namesRejection.test(detail);
}
