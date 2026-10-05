import { lazy, Suspense, type ReactElement } from 'react';
import { DEMO_CHART } from '../../../lib/demoChart';
import { useReducedMotion } from '../../../hooks/useReducedMotion';
import { WebGlGate } from '../../WebGlGate';

/**
 * Lazy-load the Three.js force-field so the headline/CTA paint first and the
 * heavy R3F scene hydrates after. `React.lazy` requires a default export, so the
 * named `ForceFieldExperience` is wrapped to `{ default: ... }`. This keeps
 * three.js OUT of the landing chunk's first paint.
 */
const ForceFieldExperience = lazy(() =>
  import('../../forcefield').then((m) => ({ default: m.ForceFieldExperience })),
);

/**
 * The decorative hero backdrop: the app's signature planetary force-field driven
 * by the STATIC `DEMO_CHART` fixture — no Pyodide boot, no engine download. The
 * energy frame comes from the pure `buildEnergyFrame` adapter inside the scene.
 *
 * - `aria-hidden` — the canvas is pure atmosphere; the hero's meaning lives in
 *   the headline/subhead text, so it is hidden from assistive tech.
 * - Honors `prefers-reduced-motion` — renders nothing animated for reduced-motion
 *   users (a calm static gradient shows through from the hero behind it).
 * - SSR/prerender-safe (Spec 064): with no `window` (the build-time Node
 *   prerender of the landing), render the static gradient and NEVER mount the
 *   lazy scene — `React.lazy` would otherwise kick off the three.js/R3F chunk
 *   import in Node, whose module-scope `scheduler` MessageChannel keeps the
 *   `vite build` process alive forever after the build finishes.
 */
export function HeroForceField(): ReactElement {
  const reducedMotion = useReducedMotion();

  if (reducedMotion || typeof window === 'undefined') {
    // Reduced motion (or build-time prerender): skip the animated WebGL scene
    // entirely. The hero's own radial glow provides a quiet, still backdrop.
    return (
      <div
        aria-hidden="true"
        data-testid="hero-forcefield-static"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_38%,rgba(58,79,176,0.18),transparent_60%)]"
      />
    );
  }

  return (
    <div
      aria-hidden="true"
      data-testid="hero-forcefield"
      className="pointer-events-none absolute inset-0 flex items-center justify-center [mask-image:radial-gradient(circle_at_50%_42%,#000_0%,#000_45%,transparent_78%)]"
    >
      {/* No WebGL: keep the landing page and drop only the backdrop. */}
      <WebGlGate available fallback={null}>
        <Suspense fallback={null}>
          {/* Dialed back from full strength so the animated core reads as a quiet
              backdrop, not a competitor to the headline seated over it. */}
          <div className="w-full max-w-3xl opacity-70">
            <ForceFieldExperience chart={DEMO_CHART} height={560} />
          </div>
        </Suspense>
      </WebGlGate>
    </div>
  );
}
