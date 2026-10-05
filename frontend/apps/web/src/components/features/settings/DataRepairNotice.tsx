import { useTranslation } from 'react-i18next';

import { repairNoteLines, useDataRepairNotice } from '../../../lib/dataRepairNotice';

/** Says what the boot self-heal repaired; renders nothing when it changed nothing. */
export function DataRepairNotice() {
  const { t } = useTranslation('settings');
  const report = useDataRepairNotice((state) => state.report);
  const dismiss = useDataRepairNotice((state) => state.dismiss);
  if (report === null) return null;
  const lines = repairNoteLines(t, report);
  if (lines.length === 0) return null;
  return (
    <div
      role="status"
      data-testid="data-repair-notice"
      className="mb-4 rounded-xl border border-ui-border bg-background-secondary p-4 text-sm text-text-secondary"
    >
      <p className="mb-1 font-semibold text-text-primary">{t('backup.repair_notice_title')}</p>
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
      <button
        type="button"
        onClick={dismiss}
        className="mt-2 text-accent-gold hover:text-accent-gold-bright"
      >
        {t('backup.repair_notice_dismiss')}
      </button>
    </div>
  );
}
