import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './cn';

/**
 * Button — the astrolabe control. Brass-gold primary, engraved secondary,
 * ghost, and hairline outline variants. Measured orbital transition.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-md font-sans font-medium ' +
    'whitespace-nowrap transition-colors duration-200 ease-orbital ' +
    'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ui-focus ' +
    'focus-visible:ring-offset-2 focus-visible:ring-offset-background-primary ' +
    'disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary:
          'bg-accent-gold text-background-darkest hover:bg-accent-gold-bright ' +
          'shadow-[0_4px_16px_-6px_rgba(201,162,75,0.5)]',
        secondary:
          'bg-background-elevated text-text-body border border-ui-border ' +
          'hover:bg-background-tertiary hover:border-ui-borderLight',
        ghost: 'bg-transparent text-text-secondary hover:bg-background-elevated hover:text-text-primary',
        outline:
          'bg-transparent text-accent-gold border border-accent-gold/50 ' +
          'hover:border-accent-gold hover:bg-accent-gold/10',
      },
      size: {
        sm: 'h-8 px-3 text-sm',
        md: 'h-10 px-4 text-sm',
        lg: 'h-12 px-6 text-base',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
    },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
);

Button.displayName = 'Button';

export { buttonVariants };
