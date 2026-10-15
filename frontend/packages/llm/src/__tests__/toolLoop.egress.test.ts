// Egress guard for the toolLoop seam: the AI SDK may only ever contact the
// configured endpoint. A string model id would route through the Vercel AI
// Gateway (ai-gateway.vercel.sh); the seam must never do that, and the fetch it
// hands the provider refuses every other origin before any byte leaves.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PrivacyViolationError, type ProviderConfig } from "../config";
import { defineTool, guardedFetch, runToolTurn, z, type ToolDef } from "../toolLoop";
import { collect, fakeEndpoint, type FakeTurn } from "./toolLoopFake";

const CONFIG: ProviderConfig = {
  engine: "openai-http",
  model: "deepseek/deepseek-chat",
  privacyMode: "cloud_premium",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "test-key",
};

const read: ToolDef<{ readonly start: string }> = defineTool<{ readonly start: string }>({
  name: "read_period",
  description: "Read the sky for a period.",
  reads: true,
  input: z.object({ start: z.string() }),
  execute: async ({ start }) => ({ start }),
});

const TURNS: FakeTurn[] = [
  { calls: [{ id: "c1", name: "read_period", args: '{"start":"Sept"}' }] },
  { calls: [{ id: "c2", name: "read_period", args: '{"start":"2019"}' }] },
  { calls: [{ id: "a1", name: "answer", args: '{"text":"Venus."}' }] },
];

function turn(fetchImpl?: typeof fetch): AsyncGenerator<string, unknown> {
  return runToolTurn({
    config: CONFIG,
    messages: [{ role: "user", content: "September 2019?" }],
    tools: [read] as unknown as readonly ToolDef<unknown>[],
    answer: { schema: z.object({ text: z.string() }), render: (p) => p.text ?? "" },
    readFirst: true,
    now: new Date("2030-01-01T00:00:00Z"),
    fetchImpl,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("guardedFetch", () => {
  it.each([
    ["https://ai-gateway.vercel.sh/v4/ai/language-model", "https://ai-gateway.vercel.sh"],
    ["https://example.com", "https://example.com"],
    ["https://openrouter.ai.evil.test/api/v1/chat/completions", "https://openrouter.ai.evil.test"],
  ])("refuses %s without calling the inner fetch", async (url, origin) => {
    const inner = vi.fn<typeof fetch>();
    const guarded = guardedFetch("https://openrouter.ai/api/v1", inner);
    const failure = await Promise.resolve()
      .then(() => guarded(url))
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(PrivacyViolationError);
    expect((failure as Error).message).toBe(
      `Refused a request to ${origin}: only the configured AI endpoint may be contacted.`,
    );
    expect(inner).toHaveBeenCalledTimes(0);
  });

  it("passes a same-origin request through untouched", async () => {
    const inner = vi.fn<typeof fetch>(async () => new Response("ok"));
    const guarded = guardedFetch("https://openrouter.ai/api/v1", inner);
    const init = { method: "POST", body: "{}" };
    await guarded("https://openrouter.ai/api/v1/chat/completions", init);
    expect(inner).toHaveBeenCalledWith("https://openrouter.ai/api/v1/chat/completions", init);
  });

  it("reads a Request or URL input's own address", async () => {
    const inner = vi.fn<typeof fetch>(async () => new Response("ok"));
    const guarded = guardedFetch("https://openrouter.ai/api/v1", inner);
    await expect(guarded(new Request("https://example.com/x"))).rejects.toBeInstanceOf(PrivacyViolationError);
    await expect(guarded(new URL("https://example.com/x"))).rejects.toBeInstanceOf(PrivacyViolationError);
    expect(inner).toHaveBeenCalledTimes(0);
  });

  it("defaults to the global fetch at call time", async () => {
    const trap = vi.fn<typeof fetch>(async () => new Response("ok"));
    const guarded = guardedFetch("https://openrouter.ai/api/v1");
    vi.stubGlobal("fetch", trap);
    await guarded("https://openrouter.ai/api/v1/models");
    expect(trap).toHaveBeenCalledTimes(1);
  });
});

describe("a full runToolTurn only contacts the configured endpoint", () => {
  it("with fetchImpl: every URL is under baseUrl; the global fetch is never touched", async () => {
    const globalTrap = vi.fn<typeof fetch>(async () => new Response("unexpected", { status: 599 }));
    vi.stubGlobal("fetch", globalTrap);
    const { fetchImpl, requests } = fakeEndpoint(TURNS);
    await collect(turn(fetchImpl));
    expect(requests).toHaveLength(3);
    for (const { url } of requests) {
      expect(url.startsWith(CONFIG.baseUrl)).toBe(true);
      expect(url).not.toContain("ai-gateway.vercel.sh");
    }
    expect(globalTrap).toHaveBeenCalledTimes(0);
  });

  it("without fetchImpl: the global fetch sees only baseUrl requests", async () => {
    const { fetchImpl, requests } = fakeEndpoint(TURNS);
    vi.stubGlobal("fetch", fetchImpl);
    await collect(turn());
    expect(requests.map((r) => r.url)).toEqual(Array(3).fill(`${CONFIG.baseUrl}/chat/completions`));
  });

  it("refuses a local_only config pointed at a cloud host before any request", async () => {
    const { fetchImpl, requests } = fakeEndpoint(TURNS);
    const stream = runToolTurn({
      config: { ...CONFIG, privacyMode: "local_only" },
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      answer: { schema: z.object({ text: z.string() }), render: (p) => p.text ?? "" },
      readFirst: false,
      now: new Date(),
      fetchImpl,
    });
    await expect(collect(stream)).rejects.toBeInstanceOf(PrivacyViolationError);
    expect(requests).toHaveLength(0);
  });
});

describe("the seam source cannot reach the AI Gateway by construction", () => {
  const source = readFileSync(resolve(import.meta.dirname, "../toolLoop.ts"), "utf8");

  it("passes no string model id", () => {
    expect(source).not.toMatch(/model:\s*['"`]/);
  });

  it("imports nothing gateway-shaped", () => {
    expect(source).not.toMatch(/from\s+['"][^'"]*gateway[^'"]*['"]/);
    expect(source).not.toMatch(/\bgateway\s*\(/);
  });
});

describe("only the seam may import ai, @ai-sdk/* or zod", () => {
  interface LintMessage {
    readonly ruleId: string | null;
  }
  interface ESLintApi {
    lintText(code: string, options: { filePath: string }): Promise<Array<{ messages: LintMessage[] }>>;
  }
  type ESLintCtor = new (options: { cwd: string }) => ESLintApi;
  const frontend = resolve(import.meta.dirname, "../../../..");
  const { ESLint } = createRequire(resolve(frontend, "package.json"))("eslint") as { ESLint: ESLintCtor };
  const eslint = new ESLint({ cwd: frontend });

  async function restricted(code: string, file: string): Promise<boolean> {
    const [result] = await eslint.lintText(code, { filePath: resolve(frontend, file) });
    return result.messages.some((m) => m.ruleId === "no-restricted-imports");
  }

  it.each([
    'import { streamText } from "ai";\nexport const s = streamText;\n',
    'import { createOpenAICompatible } from "@ai-sdk/openai-compatible";\nexport const c = createOpenAICompatible;\n',
    'import { z } from "zod";\nexport const zz = z;\n',
    'import { z } from "zod/v4";\nexport const zz = z;\n',
  ])("fails outside the seam: %s", async (code) => {
    expect(await restricted(code, "packages/llm/src/notTheSeam.ts")).toBe(true);
    expect(await restricted(code, "apps/web/src/lib/notTheSeam.ts")).toBe(true);
  }, 30_000);

  it("passes inside the seam", async () => {
    expect(await restricted('import { streamText } from "ai";\nexport const s = streamText;\n', "packages/llm/src/toolLoop.ts")).toBe(false);
  }, 30_000);
});
