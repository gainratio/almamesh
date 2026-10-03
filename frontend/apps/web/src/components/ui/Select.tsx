import { forwardRef, type SelectHTMLAttributes } from 'react';
import { cn } from './cn';

/**
 * Select — native styled to the observatory aesthetic. A brass chevron is drawn
 * via background SVG so it stays consistent across platforms.
 */
export type SelectProps = SelectHTMLAttributes<HTMLSelectElement>;

const CHEVRON =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23C9A24B' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E\")";

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, children, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        'flex h-10 w-full appearance-none rounded-md border border-ui-border bg-background-darker',
        'px-3 pr-9 py-2 font-sans text-sm text-text-primary',
        'bg-no-repeat [background-position:right_0.75rem_center]',
        'transition-colors duration-200 ease-orbital',
        'focus-visible:outline-hidden focus-visible:border-accent-gold/60',
        'focus-visible:ring-2 focus-visible:ring-ui-focus/40',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      style={{ backgroundImage: CHEVRON }}
      {...props}
    >
      {children}
    </select>
  ),
);

Select.displayName = 'Select';
