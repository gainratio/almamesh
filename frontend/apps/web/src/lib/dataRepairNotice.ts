/**
 * What a data repair changed, in words the user can act on. Export, import and
 * the boot self-heal all repair dangling references (repairPortableReferences);
 * each must say so on screen, never only in a console warning.
 */
import type { TFunction } from 'i18next';
import { create } from 'zustand';

import type { PortableRepairReport } from '@almamesh/store';

/** One sentence per kind of change the user would care about; empty when none. */
export function repairNoteLines(t: TFunction, repairs: PortableRepairReport): string[] {
  const counts = [
    ['backup.note_unlinked_chat', repairs.unlinkedChatThreadIds.length],
    ['backup.note_dropped_readings', repairs.droppedReadingChartIds.length],
    ['backup.note_dropped_records', repairs.droppedPersonRecords.length],
    ['backup.note_set_aside', repairs.setAside.length],
  ] as const;
  return counts.filter(([, count]) => count > 0).map(([key, count]) => t(key, { count }));
}

interface DataRepairNoticeState {
  /** The last boot repair, shown until dismissed (this session only). */
  readonly report: PortableRepairReport | null;
  readonly show: (report: PortableRepairReport) => void;
  readonly dismiss: () => void;
}

export const useDataRepairNotice = create<DataRepairNoticeState>((set) => ({
  report: null,
  show: (report) => set({ report }),
  dismiss: () => set({ report: null }),
}));
