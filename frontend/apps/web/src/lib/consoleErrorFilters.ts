/**
 * Chromium reports an in-flight request aborted by `BrowserContext.setOffline`
 * as a `console.error` with one of two texts, inconsistently across builds:
 * `net::ERR_INTERNET_DISCONNECTED` or `net::ERR_FAILED`. Both are the SAME
 * benign, intentional signal — not a product bug — whenever an e2e journey
 * deliberately drives the browser offline.
 *
 * Playwright delivers the underlying `page.on('console', ...)` event
 * asynchronously. Under CI CPU contention that delivery can be delayed past
 * the point a test has already re-enabled the network and moved on, so a
 * caller must not assume every benign offline-abort message lands inside the
 * offline window it filters by array position/timing — filter by CONTENT,
 * wherever in the journey the message ends up.
 */
const EXPECTED_OFFLINE_ABORT_PATTERN =
  /^\[console\.error\] Failed to load resource: net::ERR_(?:INTERNET_DISCONNECTED|FAILED)$/;

export function filterExpectedOfflineAbortErrors(errors: readonly string[]): string[] {
  return errors.filter((message) => !EXPECTED_OFFLINE_ABORT_PATTERN.test(message));
}
