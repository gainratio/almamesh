/**
 * Boot-to-ready memory budget for the memory-budget e2e lane
 * (e2e/memory-budget.e2e.spec.ts). Budgets are MiB, measured on the production
 * build in Chromium with an iPhone 13 user agent and viewport.
 *
 * Reference, CI main (Dagger browser gate, Linux, n=1 per run):
 *   run 37261138765 (278a693, Pyodide 314.0.7): heap 278 MiB, renderer RSS
 *   peak 989, settled 955 MiB. That is 22 MiB (7%) under the heap budget.
 *   Earlier: 254 (PR run 37223199200), 267 (release PR run 37252603946).
 * Once the chat embedder loads the heap rises by ~95 MiB (macOS, 2026-10-04:
 * 243 -> 338). The PR that raised this lane's measurements records the local
 * Linux numbers per lane, including the report-only ones below.
 *
 * The heap budget is the sharp guard: 300 sits between "no embedder" (278 on
 * main) and "embedder loaded" (~370 by the same +95 MiB), so loading the chat
 * model during boot fails it. Its headroom is thin; raising it to get a red
 * run green is the trap, not the fix. The
 * RSS budgets are wider backstops (RSS is noisy, +-150 MiB run to run) that
 * catch gross regressions like a second Pyodide runtime.
 *
 * Report-only samples (printed as `memory-report <lane> {...}`, never gated
 * yet): the heap peak DURING boot, the heap after a chat search has loaded
 * the embedder, the one-core 4x-throttled lane, and the WebKit web-content
 * process RSS. Each gets a budget once 5 main runs have recorded it.
 */
export interface MemoryBudget {
  readonly heapPeakMiB: number;
  readonly rendererRssPeakMiB: number;
  readonly rendererRssSettledMiB: number;
}

export const BOOT_MEMORY_BUDGET: MemoryBudget = {
  heapPeakMiB: 300,
  rendererRssPeakMiB: 1400,
  rendererRssSettledMiB: 1100,
};

export interface BootMemorySample {
  readonly heapPeakMiB: number;
  readonly rendererRssPeakMiB: number;
  readonly rendererRssSettledMiB: number;
}

/** Every budget line the sample breaks, as readable messages (empty = within budget). */
export function overBudget(sample: BootMemorySample, budget: MemoryBudget): string[] {
  const lines: [keyof MemoryBudget, string][] = [
    ['heapPeakMiB', 'page+workers JS/wasm heap peak'],
    ['rendererRssPeakMiB', 'renderer RSS peak'],
    ['rendererRssSettledMiB', 'renderer RSS settled'],
  ];
  return lines
    // `!(x <= budget)` rather than `x > budget`: an unmeasured NaN fails.
    .filter(([key]) => !(sample[key] <= budget[key]))
    .map(([key, label]) => `${label} ${sample[key].toFixed(0)} MiB > budget ${budget[key]} MiB`);
}

