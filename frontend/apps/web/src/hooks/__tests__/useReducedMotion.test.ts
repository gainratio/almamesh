/**
 * Tests for useReducedMotion (Spec 032).
 *
 * The only live animation hook: it drives motion-reduction across AnimatedPage,
 * AnimatedRoutes and HeroForceField. (The
 * former sibling hooks useMediaQuery / useAnimationPerformance / useScrollReveal
 * were unused product code kept green only by their own tests, and were removed.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useReducedMotion } from '../useReducedMotion';

// ============================================================================
// Helper functions for mocking matchMedia
// ============================================================================

interface MockMediaQueryList {
  matches: boolean;
  media: string;
  onchange: ((ev: MediaQueryListEvent) => void) | null;
  addListener: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  dispatchEvent: ReturnType<typeof vi.fn>;
}

type ChangeHandler = (e: MediaQueryListEvent) => void;

/**
 * Creates a mock matchMedia implementation with control over the matches value.
 * Returns a function to trigger change events.
 */
function createMockMatchMedia(initialMatches: boolean) {
  const listeners: Map<string, ChangeHandler[]> = new Map();
  let currentMatches = initialMatches;

  const mockMatchMedia = vi.fn().mockImplementation((query: string): MockMediaQueryList => ({
    matches: currentMatches,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn((event: string, handler: ChangeHandler) => {
      if (event === 'change') {
        const existing = listeners.get(query) || [];
        existing.push(handler);
        listeners.set(query, existing);
      }
    }),
    removeEventListener: vi.fn((event: string, handler: ChangeHandler) => {
      if (event === 'change') {
        const existing = listeners.get(query) || [];
        listeners.set(
          query,
          existing.filter((h) => h !== handler)
        );
      }
    }),
    dispatchEvent: vi.fn(),
  }));

  const setMatches = (matches: boolean, query?: string) => {
    currentMatches = matches;
    // Trigger change events for all registered listeners
    const targetQueries = query ? [query] : Array.from(listeners.keys());
    for (const q of targetQueries) {
      const handlers = listeners.get(q) || [];
      for (const handler of handlers) {
        handler({ matches, media: q } as MediaQueryListEvent);
      }
    }
  };

  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: mockMatchMedia,
  });

  return { mockMatchMedia, setMatches, listeners };
}

/**
 * Simple mock matchMedia that always returns a fixed matches value.
 */
function mockMatchMediaSimple(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

// ============================================================================
// useReducedMotion Tests
// ============================================================================

describe('useReducedMotion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Reset matchMedia to default false
    mockMatchMediaSimple(false);
  });

  describe('initial state', () => {
    it('should return false when no preference is set', () => {
      mockMatchMediaSimple(false);
      const { result } = renderHook(() => useReducedMotion());
      expect(result.current).toBe(false);
    });

    it('should return true when prefers-reduced-motion: reduce is set', () => {
      mockMatchMediaSimple(true);
      const { result } = renderHook(() => useReducedMotion());
      expect(result.current).toBe(true);
    });

    it('should query the correct media query string', () => {
      const mockFn = vi.fn().mockReturnValue({
        matches: false,
        media: '',
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      });

      Object.defineProperty(window, 'matchMedia', {
        writable: true,
        value: mockFn,
      });

      renderHook(() => useReducedMotion());

      expect(mockFn).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
    });
  });

  describe('dynamic updates', () => {
    it('should update when preference changes from false to true', async () => {
      const { setMatches } = createMockMatchMedia(false);
      const { result } = renderHook(() => useReducedMotion());

      expect(result.current).toBe(false);

      act(() => {
        setMatches(true);
      });

      await waitFor(() => {
        expect(result.current).toBe(true);
      });
    });

    it('should update when preference changes from true to false', async () => {
      const { setMatches } = createMockMatchMedia(true);
      const { result } = renderHook(() => useReducedMotion());

      expect(result.current).toBe(true);

      act(() => {
        setMatches(false);
      });

      await waitFor(() => {
        expect(result.current).toBe(false);
      });
    });

    it('should add and remove event listener on mount/unmount', () => {
      let addEventListenerMock: ReturnType<typeof vi.fn>;
      let removeEventListenerMock: ReturnType<typeof vi.fn>;

      Object.defineProperty(window, 'matchMedia', {
        writable: true,
        value: vi.fn().mockImplementation(() => {
          addEventListenerMock = vi.fn();
          removeEventListenerMock = vi.fn();
          return {
            matches: false,
            media: '',
            onchange: null,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: addEventListenerMock,
            removeEventListener: removeEventListenerMock,
            dispatchEvent: vi.fn(),
          };
        }),
      });

      const { unmount } = renderHook(() => useReducedMotion());

      expect(addEventListenerMock!).toHaveBeenCalledWith('change', expect.any(Function));

      unmount();

      expect(removeEventListenerMock!).toHaveBeenCalledWith('change', expect.any(Function));
    });
  });
});
