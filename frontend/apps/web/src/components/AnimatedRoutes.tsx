import { AnimatePresence } from 'framer-motion';
import { Routes, useLocation } from 'react-router-dom';
import type { ComponentProps } from 'react';
import { useReducedMotion } from '../hooks/useReducedMotion';
// Not the storytelling barrel: importing ScrollTrigger enables it, which runs a
// 250 ms interval for the life of the page even though no route uses it.
import { killLoadedScrollTriggers } from '../animations/storytelling/lazyLoad';

type RoutesChildren = ComponentProps<typeof Routes>['children'];

interface AnimatedRoutesProps {
  children: RoutesChildren;
  /**
   * AnimatePresence mode:
   * - "wait": Wait for exit animation before entering (default)
   * - "sync": Enter and exit animations play simultaneously
   * - "popLayout": Pop layout for shared element transitions
   */
  mode?: 'wait' | 'sync' | 'popLayout';
  /**
   * Whether to cleanup ScrollTrigger instances on route change.
   * Recommended for storytelling pages with GSAP animations.
   */
  cleanupScrollTriggers?: boolean;
}

/**
 * Wrapper component for animated route transitions.
 * Combines React Router with Framer Motion's AnimatePresence
 * for smooth page transitions.
 *
 * @example
 * ```tsx
 * import { BrowserRouter } from 'react-router-dom';
 * import { AnimatedRoutes } from '@/components/AnimatedRoutes';
 * import { AnimatedPage } from '@/components/AnimatedPage';
 *
 * function App() {
 *   return (
 *     <BrowserRouter>
 *       <AnimatedRoutes>
 *         <Route path="/dashboard" element={
 *           <AnimatedPage>
 *             <Dashboard />
 *           </AnimatedPage>
 *         } />
 *         <Route path="/chart/:id" element={
 *           <AnimatedPage>
 *             <ChartDetail />
 *           </AnimatedPage>
 *         } />
 *       </AnimatedRoutes>
 *     </BrowserRouter>
 *   );
 * }
 * ```
 */
export function AnimatedRoutes({
  children,
  mode = 'wait',
  cleanupScrollTriggers = true,
}: AnimatedRoutesProps) {
  const location = useLocation();
  const reducedMotion = useReducedMotion();

  // Handler for when exit animation completes
  const handleExitComplete = () => {
    // Clean up GSAP ScrollTrigger instances on route change
    // This prevents memory leaks and stale scroll animations
    if (cleanupScrollTriggers) {
      killLoadedScrollTriggers();
    }

    // Scroll to top on page change
    window.scrollTo(0, 0);
  };

  // Skip AnimatePresence for users who prefer reduced motion
  if (reducedMotion) {
    return (
      <Routes location={location} key={location.pathname}>
        {children}
      </Routes>
    );
  }

  return (
    <AnimatePresence mode={mode} onExitComplete={handleExitComplete}>
      <Routes location={location} key={location.pathname}>
        {children}
      </Routes>
    </AnimatePresence>
  );
}

export default AnimatedRoutes;
