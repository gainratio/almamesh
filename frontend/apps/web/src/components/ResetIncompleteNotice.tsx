import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Shown when Reset & reload could not confirm that saved data was deleted
 * (another tab or the browser still holds a database open). The page does not
 * reload: a reload would look like a finished reset with data still on disk.
 */
export function ResetIncompleteNotice({ databases }: { readonly databases: readonly string[] }): ReactElement {
  const { t } = useTranslation('common');
  return (
    <p
      role="alert"
      data-testid="reset-incomplete"
      data-databases={databases.join(' ')}
      className="mt-2 rounded-md border border-status-error/40 bg-status-error/10 p-3 text-xs leading-relaxed text-status-error"
    >
      {t('reset_incomplete')}
    </p>
  );
}

/** The databases a failed reset names; empty when the failure has no list. */
export function incompleteDatabases(error: unknown): readonly string[] {
  const databases = (error as { databases?: unknown } | null)?.databases;
  return Array.isArray(databases) ? databases.filter((name): name is string => typeof name === 'string') : [];
}
