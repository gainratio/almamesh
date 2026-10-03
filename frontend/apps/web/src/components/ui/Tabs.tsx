import { createContext, useContext, useId, type ReactNode } from 'react';
import { cn } from './cn';

interface TabsContextValue {
  value: string;
  setValue: (value: string) => void;
  baseId: string;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabsContext(component: string): TabsContextValue {
  const ctx = useContext(TabsContext);
  if (ctx === null) {
    throw new Error(`<${component}> must be used within <Tabs>`);
  }
  return ctx;
}

export interface TabsProps {
  /** Controlled active tab value. */
  value: string;
  /** Called when the active tab changes. */
  onValueChange: (value: string) => void;
  children: ReactNode;
  className?: string;
}

/** Tabs — controlled, accessible (ARIA tablist) observatory tab group. */
export function Tabs({ value, onValueChange, children, className }: TabsProps) {
  const baseId = useId();
  return (
    <TabsContext.Provider value={{ value, setValue: onValueChange, baseId }}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  );
}

export interface TabsListProps {
  children: ReactNode;
  className?: string;
}

export function TabsList({ children, className }: TabsListProps) {
  return (
    <div
      role="tablist"
      className={cn(
        'inline-flex max-w-full items-center gap-1 overflow-x-auto border-b border-ui-border [scrollbar-width:thin]',
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface TabsTriggerProps {
  value: string;
  children: ReactNode;
  className?: string;
  /** Optional hook for tests / live gates (e.g. `periods-tab`). */
  'data-testid'?: string;
}

export function TabsTrigger({ value, children, className, 'data-testid': testId }: TabsTriggerProps) {
  const ctx = useTabsContext('TabsTrigger');
  const active = ctx.value === value;
  return (
    <button
      type="button"
      role="tab"
      id={`${ctx.baseId}-tab-${value}`}
      data-testid={testId}
      aria-selected={active}
      aria-controls={`${ctx.baseId}-panel-${value}`}
      onClick={() => ctx.setValue(value)}
      className={cn(
        'relative -mb-px border-b-2 px-3 py-2 font-sans text-sm transition-colors duration-200 ease-orbital',
        'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ui-focus/40',
        active
          ? 'border-accent-gold text-text-primary'
          : 'border-transparent text-text-secondary hover:text-text-primary',
        className,
      )}
    >
      {children}
    </button>
  );
}

export interface TabsContentProps {
  value: string;
  children: ReactNode;
  className?: string;
}

export function TabsContent({ value, children, className }: TabsContentProps) {
  const ctx = useTabsContext('TabsContent');
  if (ctx.value !== value) {
    return null;
  }
  return (
    <div
      role="tabpanel"
      id={`${ctx.baseId}-panel-${value}`}
      aria-labelledby={`${ctx.baseId}-tab-${value}`}
      className={className}
    >
      {children}
    </div>
  );
}
