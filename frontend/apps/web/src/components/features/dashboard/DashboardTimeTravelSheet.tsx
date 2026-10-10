/**
 * The chat's Time travel sheet, on the Dashboard. The sheet is `absolute
 * inset-x-0 bottom-0` and needs a positioned parent: this fixed scrim is that
 * parent. z-[55] sits above the floating chat button and panel and tooltips
 * (all z-50) and below the update banner and set-aside notice (z-[60]). role="dialog", the focus trap and return-focus stay on the sheet.
 */
import type { ChatThreadAsOf } from '@almamesh/shared-types';

import { viewerTodayDay } from '../../../lib/chatAgentTools';
import { TimeTravelSheet } from '../chat/TimeTravelSheet';

export interface DashboardTimeTravelSheetProps {
  readonly open: boolean;
  readonly current?: ChatThreadAsOf;
  readonly birthYear?: number;
  /** The viewer's today (YYYY-MM-DD). Default: today in the viewer's own zone. */
  readonly today?: string;
  readonly intro?: string;
  readonly onGo: (asOf: ChatThreadAsOf) => Promise<void>;
  readonly onClose: () => void;
}

export function DashboardTimeTravelSheet(props: DashboardTimeTravelSheetProps) {
  if (!props.open) return null;
  return (
    <div data-testid="dashboard-time-travel-sheet-overlay" className="fixed inset-0 z-[55] bg-black/50">
      <TimeTravelSheet open current={props.current} birthYear={props.birthYear} today={props.today ?? viewerTodayDay(new Date())} intro={props.intro}
        onGo={props.onGo} onClose={props.onClose} />
    </div>
  );
}
