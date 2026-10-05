/**
 * Boot-to-ready memory budget for the memory-budget e2e lane
 * (e2e/memory-budget.e2e.spec.ts). Budgets are MiB, measured on the production
 * build in Chromium with an iPhone 13 user agent and viewport.
 *
 * Reference (2026-10-04, main 28d6034, macOS arm64, n=3 medians):
 *   page+workers JS/wasm heap (measureUserAgentSpecificMemory) 243 MiB at boot;
 *   338 MiB once the chat embedder has loaded (it adds ~95 MiB).
 *   renderer RSS: peak 901, settled 698 MiB.
 * Linux (Playwright 1.63 noble container, n=6): heap 244, renderer RSS peak
 * 933-955, settled 893-933 MiB.
 *
 * The heap budget is the sharp guard: 300 sits between "no embedder" (243) and
 * "embedder loaded" (338), so loading the chat model during boot fails it. The
 * RSS budgets are wider backstops (RSS is noisy, +-150 MiB run to run) that
 * catch gross regressions like a second Pyodide runtime.
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
    .filter(([key]) => sample[key] > budget[key])
    .map(([key, label]) => `${label} ${sample[key].toFixed(0)} MiB > budget ${budget[key]} MiB`);
}
