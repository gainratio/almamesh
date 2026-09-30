import { describe, expect, it } from 'vitest';
import { filterExpectedOfflineAbortErrors } from './consoleErrorFilters';

describe('filterExpectedOfflineAbortErrors', () => {
  it('drops the Chromium offline-abort console errors', () => {
    const errors = [
      '[console.error] Failed to load resource: net::ERR_FAILED',
      '[console.error] Failed to load resource: net::ERR_INTERNET_DISCONNECTED',
    ];
    expect(filterExpectedOfflineAbortErrors(errors)).toEqual([]);
  });

  it('keeps genuine, unrelated console errors', () => {
    const errors = ['[console.error] TypeError: cannot read properties of undefined'];
    expect(filterExpectedOfflineAbortErrors(errors)).toEqual(errors);
  });

  it('keeps a genuine error alongside a benign offline abort, dropping only the latter', () => {
    const errors = [
      '[console.error] Failed to load resource: net::ERR_FAILED',
      '[console.error] Uncaught ReferenceError: x is not defined',
    ];
    expect(filterExpectedOfflineAbortErrors(errors)).toEqual([
      '[console.error] Uncaught ReferenceError: x is not defined',
    ]);
  });

  it('reproduces the main-CI leak: an offline abort delivered after the splice boundary must still be excluded', () => {
    // Regression for the main-CI flake (report-pdf.e2e.spec.ts "REAL onboarding
    // -> rectify -> offline reload -> predictive PDF is correct"): Playwright's
    // 'console' event for a request that failed WHILE the context was offline
    // can be delivered asynchronously under CPU contention, sometimes AFTER the
    // offline block's positional `errors.splice(offlineConsoleStart)` already
    // ran. The event still carries the benign offline-abort text, so filtering
    // by content (not by array position/timing) must catch it wherever it lands
    // -- including in the final whole-journey clean-console gate.
    const leakedIntoFinalGate = ['[console.error] Failed to load resource: net::ERR_FAILED'];
    expect(filterExpectedOfflineAbortErrors(leakedIntoFinalGate)).toEqual([]);
  });
});
