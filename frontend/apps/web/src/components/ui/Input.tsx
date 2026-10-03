import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from './cn';

/**
 * Input — engraved field on obsidian. Hairline border, brass focus ring.
 */
export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = 'text', ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        'flex h-10 w-full rounded-md border border-ui-border bg-background-darker px-3 py-2',
        'font-sans text-sm text-text-primary placeholder:text-text-muted',
        'transition-colors duration-200 ease-orbital',
        'focus-visible:outline-hidden focus-visible:border-accent-gold/60',
        'focus-visible:ring-2 focus-visible:ring-ui-focus/40',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);

Input.displayName = 'Input';
