import { afterEach, describe, expect, it, vi } from 'vitest';

import { isDocumentLeaving, LEAVING_WINDOW_MS } from '../documentLeaving';

afterEach(() => {
  window.dispatchEvent(new Event('pageshow'));
  vi.useRealTimers();
});

describe('isDocumentLeaving', () => {
  it('is false while nobody is navigating away', () => {
    expect(isDocumentLeaving()).toBe(false);
  });

  it('is true once a navigation away has started (beforeunload)', () => {
    window.dispatchEvent(new Event('beforeunload'));
    expect(isDocumentLeaving()).toBe(true);
  });

  it('is false again when the page is shown again (back/forward cache)', () => {
    window.dispatchEvent(new Event('beforeunload'));
    window.dispatchEvent(new Event('pageshow'));
    expect(isDocumentLeaving()).toBe(false);
  });

  it('lapses 10 s after a navigation that never committed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T00:00:00Z'));
    window.dispatchEvent(new Event('beforeunload'));
    vi.setSystemTime(Date.now() + 9_999);
    expect(isDocumentLeaving()).toBe(true);
    vi.setSystemTime(Date.now() + 1);
    expect(isDocumentLeaving()).toBe(false);
    expect(LEAVING_WINDOW_MS).toBe(10_000);
  });

  it('watches any target it is asked about', () => {
    const target = new EventTarget();
    expect(isDocumentLeaving(target)).toBe(false);
    target.dispatchEvent(new Event('beforeunload'));
    expect(isDocumentLeaving(target)).toBe(true);
    expect(isDocumentLeaving()).toBe(false);
  });
});
