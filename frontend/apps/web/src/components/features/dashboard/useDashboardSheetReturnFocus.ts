import { useEffect, useRef, type RefObject } from 'react';

export type DashboardTravelSheet = 'closed' | 'new' | 'change';

export interface DashboardSheetReturnFocus {
  /** On the Dashboard's Time travel button. */
  readonly buttonRef: RefObject<HTMLButtonElement | null>;
  /** On the Dashboard banner's Change button. */
  readonly changeRef: RefObject<HTMLButtonElement | null>;
}

/**
 * Put focus back where the Dashboard sheet was opened from once it closes
 * (Cancel, Escape or a successful Go). WebKit never focuses a button on a click
 * or tap, so the sheet's own return (document.activeElement at mount) is <body>
 * there; this names the opener explicitly. Opened from the banner's Change, focus
 * returns to Change while it is mounted, else to the Time travel button. This
 * runs after the sheet's unmount cleanup, so it has the last word.
 */
export function useDashboardSheetReturnFocus(sheet: DashboardTravelSheet): DashboardSheetReturnFocus {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const changeRef = useRef<HTMLButtonElement | null>(null);
  const openedFrom = useRef<DashboardTravelSheet>('closed');
  useEffect(() => {
    const from = openedFrom.current;
    openedFrom.current = sheet;
    if (sheet !== 'closed' || from === 'closed') return;
    const change = from === 'change' ? changeRef.current : null;
    (change ?? buttonRef.current)?.focus();
  }, [sheet]);
  return { buttonRef, changeRef };
}
