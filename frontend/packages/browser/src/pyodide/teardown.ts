// Engine boot vs page teardown. A reload must never print console errors, and
// two WebKit behaviours made it do so (seen in e2e/chart-durable-reload.spec.ts):
//
// 1. A Worker constructed after `pagehide` is refused synchronously and WebKit
//    logs "Cannot load <worker url> due to access control checks." with the
//    constructing stack. Page JS cannot catch that log; it can only not spawn.
//    `trackPageTeardown` tells the runtime when to stop.
// 2. Pyodide's `loadPyodide` starts the lockfile, stdlib and wasm fetches in
//    parallel. When a reload kills them, the first one awaited fails the boot,
//    which is reported through the boot reply; the others are left un-awaited
//    and WebKit reports each as "Unhandled Promise Rejection: TypeError: Load
//    failed". `observeOrphanedLoadFailures` marks only those echoes handled.

/** A boot abandoned because the page is going away. Not an engine failure. */
export class EngineBootCancelledError extends Error {
  public constructor(message = "AlmaMesh engine boot cancelled: the page is unloading") {
    super(message);
    this.name = "EngineBootCancelledError";
  }
}

/** The `TypeError` text each engine gives a fetch that failed at the network layer. */
const NETWORK_FAILURE_MESSAGES: ReadonlySet<string> = new Set([
  "Load failed", // WebKit
  "Failed to fetch", // Chromium
  "NetworkError when attempting to fetch resource.", // Firefox
]);

/** True for a fetch that never got an HTTP response (cancelled, offline, reset). */
export function isNetworkLoadFailure(reason: unknown): boolean {
  return reason instanceof TypeError && NETWORK_FAILURE_MESSAGES.has(reason.message);
}

export interface PageLifecycle {
  /** True between `pagehide` and the next `pageshow` (a bfcache restore). */
  isTearingDown(): boolean;
}

/** Follow `pagehide`/`pageshow` on `target` (the window). */
export function trackPageTeardown(target: EventTarget): PageLifecycle {
  let tearingDown = false;
  target.addEventListener("pagehide", () => {
    tearingDown = true;
  });
  target.addEventListener("pageshow", () => {
    tearingDown = false;
  });
  return { isTearingDown: () => tearingDown };
}

/**
 * In the chart Worker: mark an unhandled network-failure rejection handled
 * while the Pyodide runtime is not ready. That failure always reaches the main
 * thread through the boot reply (the boot awaits the same runtime start), so
 * the orphaned copies are noise. Every other rejection, and any rejection once
 * the runtime is ready, is still reported.
 */
export function observeOrphanedLoadFailures(scope: EventTarget, isRuntimeReady: () => boolean): void {
  scope.addEventListener("unhandledrejection", (event) => {
    const { reason } = event as PromiseRejectionEvent;
    if (!isRuntimeReady() && isNetworkLoadFailure(reason)) event.preventDefault();
  });
}
