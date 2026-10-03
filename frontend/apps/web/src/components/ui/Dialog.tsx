import { useEffect, useId, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { cn } from './cn';

export interface DialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Called when the dialog requests close (Esc, overlay click, close button). */
  onClose: () => void;
  /** Optional accessible title (also rendered as a heading). */
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * Dialog — accessible modal wrapping framer-motion. Closes on Escape and
 * overlay click; locks body scroll while open; labelled by its title.
 * Animation is skipped automatically under prefers-reduced-motion (the global
 * CSS rule collapses transition/animation durations).
 *
 * Rendered through a PORTAL into `document.body`. `position: fixed` resolves
 * against the viewport only while no ancestor establishes a containing block
 * for it — and any non-`none` `backdrop-filter` / `filter` / `transform` /
 * `perspective` on an ancestor does exactly that. The app shell's sticky,
 * blurred header (`backdrop-blur-xs`, inner bar `h-14`) hosts the profile
 * switcher, so its dialog resolved `fixed inset-0` against a 56px box and
 * rendered clipped above the fold. Portalling fixes the RELATIONSHIP, at one
 * file, for every dialog present and future — never patch the coordinates.
 */
export function Dialog({ open, onClose, title, children, className }: DialogProps) {
  const { t } = useTranslation();
  const titleId = useId();

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  // No document (SSR / non-DOM render target) means there is nothing to portal
  // into; render nothing rather than throwing. Placed AFTER every hook so the
  // hook order never varies between renders.
  if (typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
        >
          <button
            type="button"
            aria-label={t('dialog.close_aria')}
            className="absolute inset-0 cursor-default bg-ui-overlay backdrop-blur-xs"
            onClick={onClose}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby={title != null ? titleId : undefined}
            className={cn(
              'relative z-10 max-h-[85dvh] w-full max-w-lg overflow-y-auto rounded-lg border border-ui-border',
              'bg-background-secondary shadow-[0_24px_64px_-16px_rgba(0,0,0,0.8)]',
              className,
            )}
            initial={{ opacity: 0, scale: 0.97, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            {title != null && (
              <div className="border-b border-ui-border px-5 py-4">
                <h2 id={titleId} className="font-display text-lg text-text-primary">
                  {title}
                </h2>
              </div>
            )}
            <div className="px-5 py-4">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
