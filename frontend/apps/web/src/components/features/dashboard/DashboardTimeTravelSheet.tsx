/**
 * The chat's Time travel sheet, on the Dashboard. The sheet is `absolute
 * inset-x-0 bottom-0` and needs a positioned parent: this fixed scrim is that
 * parent. z-[55] sits above the floating chat button and panel (z-50) and below
 * toasts/update banners/tooltips (z-[60]). role="dialog", the focus trap and return-focus stay on the sheet.
 */
import { useEffect, useRef, type RefObject } from 'react';
import type { ChatThreadAsOf } from '@almamesh/shared-types';

import { TimeTravelSheet } from '../chat/TimeTravelSheet';

export interface DashboardTimeTravelSheetProps {
  readonly open: boolean;
  readonly current?: ChatThreadAsOf;
  readonly birthYear?: number;
  readonly today: string;
  readonly intro?: string;
  readonly onGo: (asOf: ChatThreadAsOf) => Promise<void>;
  readonly onClose: () => void;
}

export function DashboardTimeTravelSheet(props: DashboardTimeTravelSheetProps) {
  if (!props.open) return null;
  return (
    <div data-testid="dashboard-time-travel-sheet-overlay" className="fixed inset-0 z-[55] bg-black/50">
      <TimeTravelSheet open current={props.current} birthYear={props.birthYear} today={props.today} intro={props.intro}
        onGo={props.onGo} onClose={props.onClose} />
    </div>
  );
}

export type DashboardTravelSheet = 'closed' | 'new' | 'change';

/**
 * Put focus back where the Dashboard sheet was opened from once it closes
 * (Cancel, Escape or a successful Go). WebKit never focuses a button on a click
 * or tap, so the sheet's own return (document.activeElement at mount) is <body>
 * there; this names the opener explicitly. Opened from the banner's Change, focus
 * returns to Change while it exists, else to the Time travel button. This runs
 * after the sheet's unmount cleanup, so it has the last word.
 */
export function useDashboardSheetReturnFocus(sheet: DashboardTravelSheet): RefObject<HTMLButtonElement | null> {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const openedFrom = useRef<DashboardTravelSheet>('closed');
  useEffect(() => {
    const from = openedFrom.current;
    openedFrom.current = sheet;
    if (sheet !== 'closed' || from === 'closed') return;
    const change = from === 'change'
      ? document.querySelector<HTMLElement>('[data-testid="dashboard-time-travel-change"]')
      : null;
    (change ?? buttonRef.current)?.focus();
  }, [sheet]);
  return buttonRef;
}
