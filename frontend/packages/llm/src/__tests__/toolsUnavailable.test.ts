// One copy of the tools-unavailable helpers, shared by agent.ts and the
// toolLoop seam (fix round 1: they were copied, and copies drift).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { LlmRequestError } from "../client";
import { explicitlyRejectsTools, TOOLS_UNAVAILABLE_INSTRUCTION, TOOLS_UNAVAILABLE_NOTICE } from "../toolsUnavailable";

const source = (file: string): string => readFileSync(resolve(import.meta.dirname, "..", file), "utf8");

describe("explicitlyRejectsTools", () => {
  it.each([
    [400, "tools are not supported by this model", true],
    [404, "Unknown parameter: tool_choice", true],
    [422, "--enable-auto-tool-choice is required", true],
    [400, "context length exceeded", false],
    [500, "tools are not supported", false],
  ])("status %i with %j -> %s", (status, body, expected) => {
    expect(explicitlyRejectsTools(new LlmRequestError("x", { status, body }))).toBe(expected);
  });

  it("reads the message when there is no body", () => {
    expect(explicitlyRejectsTools(new LlmRequestError("functions are unsupported", { status: 400 }))).toBe(true);
  });

  it("is false for anything but an LlmRequestError", () => {
    expect(explicitlyRejectsTools(new Error("tools are not supported"))).toBe(false);
  });

  it("pins the notice and instruction text", () => {
    expect(TOOLS_UNAVAILABLE_NOTICE).toBe(
      "Your AI provider does not support chat tools. I can interpret the verified local facts already supplied, " +
        "but cannot run additional tools or change the selected date this turn.\n\n",
    );
    expect(TOOLS_UNAVAILABLE_INSTRUCTION.startsWith("LOCAL TOOLS ARE UNAVAILABLE for this turn.")).toBe(true);
  });
});

describe("one copy", () => {
  it.each(["agent.ts", "toolLoop.ts"])("%s imports the helpers instead of defining them", (file) => {
    const text = source(file);
    expect(text).not.toMatch(/function explicitlyRejectsTools/);
    expect(text).not.toMatch(/TOOLS_UNAVAILABLE_(?:NOTICE|INSTRUCTION)\s*=/);
    expect(text).not.toMatch(/type AgentStatusEvent\s*=/);
    expect(text).toMatch(/from "\.\/toolsUnavailable"/);
  });

  it("the shared module and agent.ts never import the AI SDK", () => {
    for (const file of ["toolsUnavailable.ts", "agent.ts"]) {
      expect(source(file)).not.toMatch(/from "(?:ai|zod|@ai-sdk\/[^"]+)"/);
    }
  });
});
