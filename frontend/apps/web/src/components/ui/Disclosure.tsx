/**
 * Disclosure — one polished, accessible inline expand/collapse primitive.
 *
 * Collapsed it shows only a `summary` line; toggling reveals `children`
 * (the full reading) inline, in place. This replaces the old `Accordion`
 * and its `max-h-[5000px]` hack.
 *
 * Animation: the expandable region animates its REAL height via the CSS
 * `grid-template-rows: 0fr → 1fr` technique — smooth, no magic pixel cap, no
 * JS measurement (which happy-dom/SSR can't do). The content stays mounted
 * across toggles, so in-flight markdown and focus survive; collapsed it is
 * removed from the a11y tree (`aria-hidden`) and the tab order (`inert`).
 *
 * Accessibility: a real <button> trigger with `aria-expanded` + `aria-controls`
 * pointing at the region. Native button keyboard semantics (Enter/Space) come
 * for free — no hand-rolled key handling.
 */

import { useId, useState, type ReactNode } from 'react';
import { cn } from './cn';

interface DisclosureProps {
  /** Always-visible summary line; becomes the trigger's accessible content. */
  summary: ReactNode;
  /** Full content revealed inline on expand. */
  children: ReactNode;
  /** Start expanded. Default: collapsed. */
  defaultOpen?: boolean;
  /**
   * Short verb label for the affordance (e.g. "Read full reading"). Rendered
   * next to the chevron and folded into the trigger's accessible name. When
   * `open`, callers may pass the "show less" variant.
   */
  toggleLabel?: ReactNode;
  /** Label to show when expanded (falls back to `toggleLabel`). */
  toggleLabelOpen?: ReactNode;
  className?: string;
  /** Extra classes for the trigger row. */
  triggerClassName?: string;
  /** Extra classes for the inner content wrapper. */
  contentClassName?: string;
}

export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  toggleLabel,
  toggleLabelOpen,
  className,
  triggerClassName,
  contentClassName,
}: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  const activeToggleLabel = open ? (toggleLabelOpen ?? toggleLabel) : toggleLabel;

  return (
    <div className={cn('group/disclosure', className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className={cn(
          'flex w-full items-center justify-between gap-4 text-left',
          'rounded-lg outline-hidden transition-colors',
          'focus-visible:ring-2 focus-visible:ring-accent-gold/60',
          triggerClassName,
        )}
      >
        <span className="min-w-0 flex-1">{summary}</span>
        <span className="flex shrink-0 items-center gap-1.5 text-text-muted">
          {activeToggleLabel && (
            <span className="text-xs font-medium uppercase tracking-wide text-accent-gold/90 transition-colors group-hover/disclosure:text-accent-gold">
              {activeToggleLabel}
            </span>
          )}
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            className={cn(
              'h-4 w-4 transform transition-transform duration-300 ease-orbital motion-reduce:transition-none',
              open && 'rotate-180',
            )}
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </span>
      </button>

      {/* grid-rows 0fr→1fr animates the real measured height with no cap. */}
      <div
        className={cn(
          'grid transition-[grid-template-rows] duration-300 ease-orbital motion-reduce:transition-none',
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
      >
        <div
          id={panelId}
          aria-hidden={!open}
          inert={!open}
          className={cn(
            'overflow-hidden transition-opacity duration-300 motion-reduce:transition-none',
            open ? 'opacity-100' : 'opacity-0',
          )}
        >
          {/* Caller box styles (padding/borders) must live INSIDE the
              overflow-hidden panel: on the panel itself they would keep
              contributing height while the 0fr row is collapsed. */}
          <div className={contentClassName}>{children}</div>
        </div>
      </div>
    </div>
  );
}
