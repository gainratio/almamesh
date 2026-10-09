/**
 * BirthZoneMissingCard — the honest state for a stored chart whose birthplace
 * timezone is missing (or unrecognised). The timing layer reads every Vedic
 * weekday off the birthplace's civil calendar, so without the zone nothing is
 * computed; this says why and links to the one place that fixes it, instead of
 * "generate your chart first" or a silently vanished section.
 */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Card } from '../../ui';

/** Where the birthplace field lives (ProfileSettings marks it `id="birthplace"`). */
export const BIRTHPLACE_SETTINGS_PATH = '/settings/profile#birthplace';

export function BirthZoneMissingCard(): ReactElement {
  const { t } = useTranslation('predictive');
  return (
    <Card title={t('gate.zone_missing_title')} data-testid="birth-zone-missing">
      <p className="mb-3 max-w-prose text-sm leading-relaxed text-text-secondary">
        {t('gate.zone_missing_body')}
      </p>
      <Link to={BIRTHPLACE_SETTINGS_PATH} className="text-sm font-medium text-accent-gold hover:underline">
        {t('gate.zone_missing_link')}
      </Link>
    </Card>
  );
}
