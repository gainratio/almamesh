/**
 * Lazy loading utilities for GSAP and its plugins.
 * Only loads GSAP on pages that need storytelling animations,
 * reducing initial bundle size for other pages.
 *
 * @example
 * ```tsx
 * import { useGSAPLazy } from '@/animations/storytelling/lazyLoad';
 *
 * function StorytellingPage() {
 *   const { isLoaded, gsap, ScrollTrigger, error } = useGSAPLazy();
 *
 *   if (error) {
 *     return <div>Failed to load animations</div>;
 *   }
 *
 *   if (!isLoaded) {
 *     return <LoadingSkeleton />;
 *   }
 *
 *   return <HeroAnimation gsap={gsap} />;
 * }
 * ```
 */

import { useState, useEffect, useCallback } from 'react';
import type { default as GSAPType } from 'gsap';
import type { ScrollTrigger as ScrollTriggerType } from 'gsap/ScrollTrigger';

// Cached promise to avoid multiple dynamic imports
let gsapPromise: Promise<{
  gsap: typeof GSAPType;
  ScrollTrigger: typeof ScrollTriggerType;
}> | null = null;

// Cached loaded modules
let cachedGSAP: typeof GSAPType | null = null;
let cachedScrollTrigger: typeof ScrollTriggerType | null = null;

/**
 * Lazy load GSAP and ScrollTrigger.
 * Returns cached modules if already loaded.
 */
export async function loadGSAP(): Promise<{
  gsap: typeof GSAPType;
  ScrollTrigger: typeof ScrollTriggerType;
}> {
  // Return cached if available
  if (cachedGSAP && cachedScrollTrigger) {
    return { gsap: cachedGSAP, ScrollTrigger: cachedScrollTrigger };
  }

  // Create or return existing promise
  if (!gsapPromise) {
    gsapPromise = (async () => {
      // Dynamic import GSAP core
      const gsapModule = await import('gsap');
      const gsap = gsapModule.default || gsapModule.gsap;

      // Dynamic import ScrollTrigger
      const scrollTriggerModule = await import('gsap/ScrollTrigger');
      const ScrollTrigger = scrollTriggerModule.ScrollTrigger;

      // Register plugin
      gsap.registerPlugin(ScrollTrigger);

      // Cache for future use
      cachedGSAP = gsap;
      cachedScrollTrigger = ScrollTrigger;

      return { gsap, ScrollTrigger };
    })();
  }

  return gsapPromise;
}

/**
 * Lazy load MotionPathPlugin for orbital animations.
 * Call this only on pages that need planetary orbit animations.
 */
export async function loadMotionPathPlugin(): Promise<void> {
  const { gsap } = await loadGSAP();

  // Dynamic import MotionPathPlugin
  const motionPathModule = await import('gsap/MotionPathPlugin');
  gsap.registerPlugin(motionPathModule.MotionPathPlugin);
}

/**
 * Check if GSAP is already loaded and cached.
 */
export function isGSAPLoaded(): boolean {
  return cachedGSAP !== null && cachedScrollTrigger !== null;
}

/**
 * Kill every ScrollTrigger if a page has loaded GSAP; otherwise do nothing.
 *
 * Shared UI such as route transitions calls this instead of importing
 * ScrollTrigger: importing it enables it, which arms a page-lifetime 250 ms
 * interval plus scroll/wheel/pointer listeners on every page.
 */
export function killLoadedScrollTriggers(): void {
  cachedScrollTrigger?.getAll().forEach((trigger) => trigger.kill());
}

/**
 * Get cached GSAP instance (throws if not loaded).
 * Use after ensuring GSAP is loaded via loadGSAP() or useGSAPLazy.
 */
export function getGSAP(): typeof GSAPType {
  if (!cachedGSAP) {
    throw new Error(
      'GSAP not loaded. Call loadGSAP() or use useGSAPLazy hook first.'
    );
  }
  return cachedGSAP;
}

/**
 * Get cached ScrollTrigger instance (throws if not loaded).
 */
export function getScrollTrigger(): typeof ScrollTriggerType {
  if (!cachedScrollTrigger) {
    throw new Error(
      'ScrollTrigger not loaded. Call loadGSAP() or use useGSAPLazy hook first.'
    );
  }
  return cachedScrollTrigger;
}

interface UseGSAPLazyResult {
  /** Whether GSAP is loaded and ready */
  isLoaded: boolean;
  /** Whether GSAP is currently loading */
  isLoading: boolean;
  /** Error if loading failed */
  error: Error | null;
  /** GSAP instance (null if not loaded) */
  gsap: typeof GSAPType | null;
  /** ScrollTrigger instance (null if not loaded) */
  ScrollTrigger: typeof ScrollTriggerType | null;
  /** Manually trigger loading */
  load: () => Promise<void>;
}

/**
 * React hook for lazy loading GSAP.
 * Automatically loads GSAP when the component mounts.
 *
 * @param autoLoad - Whether to automatically load on mount (default: true)
 *
 * @example
 * ```tsx
 * function HeroSection() {
 *   const { isLoaded, gsap, ScrollTrigger } = useGSAPLazy();
 *
 *   useEffect(() => {
 *     if (!isLoaded || !gsap) return;
 *
 *     const tl = gsap.timeline();
 *     tl.from('.title', { opacity: 0, y: 30 });
 *
 *     return () => tl.kill();
 *   }, [isLoaded, gsap]);
 *
 *   if (!isLoaded) return <HeroSkeleton />;
 *
 *   return <div>...</div>;
 * }
 * ```
 */
export function useGSAPLazy(autoLoad = true): UseGSAPLazyResult {
  const [isLoaded, setIsLoaded] = useState(() => isGSAPLoaded());
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [modules, setModules] = useState<{
    gsap: typeof GSAPType | null;
    ScrollTrigger: typeof ScrollTriggerType | null;
  }>({
    gsap: cachedGSAP,
    ScrollTrigger: cachedScrollTrigger,
  });

  const load = useCallback(async () => {
    if (isLoaded || isLoading) return;

    setIsLoading(true);
    setError(null);

    try {
      const result = await loadGSAP();
      setModules(result);
      setIsLoaded(true);
    } catch (err) {
      setError(
        err instanceof Error ? err : new Error('Failed to load GSAP')
      );
    } finally {
      setIsLoading(false);
    }
  }, [isLoaded, isLoading]);

  useEffect(() => {
    if (autoLoad && !isLoaded && !isLoading) {
      load();
    }
  }, [autoLoad, isLoaded, isLoading, load]);

  return {
    isLoaded,
    isLoading,
    error,
    gsap: modules.gsap,
    ScrollTrigger: modules.ScrollTrigger,
    load,
  };
}

/**
 * Preload GSAP before user navigates to storytelling pages.
 * Call this on hover/focus of navigation links to story pages.
 *
 * @example
 * ```tsx
 * <Link
 *   to="/about"
 *   onMouseEnter={() => preloadGSAP()}
 *   onFocus={() => preloadGSAP()}
 * >
 *   About Us
 * </Link>
 * ```
 */
export function preloadGSAP(): void {
  if (!isGSAPLoaded()) {
    // Fire and forget - we don't need to await
    loadGSAP().catch(() => {
      // Silently fail for preload - actual load will show error
    });
  }
}

export default {
  loadGSAP,
  loadMotionPathPlugin,
  isGSAPLoaded,
  getGSAP,
  getScrollTrigger,
  useGSAPLazy,
  preloadGSAP,
};
