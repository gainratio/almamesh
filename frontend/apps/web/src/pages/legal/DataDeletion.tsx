import { useTranslation } from 'react-i18next';
import { LegalPageLayout } from './LegalPageLayout';

export default function DataDeletion() {
  const { t } = useTranslation('legal');

  return (
    <LegalPageLayout
      title={t('data_deletion.title')}
      lastUpdated={t('data_deletion.last_updated')}
    >
      <p>{t('data_deletion.intro')}</p>

      <h2>{t('data_deletion.opt1_heading')}</h2>
      <ol>
        <li>{t('data_deletion.opt1_li1_prefix')}</li>
        <li>
          {t('data_deletion.opt1_li2_prefix')} <strong>{t('data_deletion.opt1_li2_strong')}</strong>{' '}
          {t('data_deletion.opt1_li2_suffix')}
        </li>
        <li>
          {t('data_deletion.opt1_li3_prefix')} <strong>{t('data_deletion.opt1_li3_strong')}</strong>{' '}
          {t('data_deletion.opt1_li3_suffix')}
        </li>
        <li>
          {t('data_deletion.opt1_li4_prefix')} <strong>{t('data_deletion.opt1_li4_strong')}</strong>
        </li>
        <li>{t('data_deletion.opt1_li5_prefix')}</li>
      </ol>
      <p>{t('data_deletion.opt1_p1')}</p>

      <h2>{t('data_deletion.opt2_heading')}</h2>
      <p>{t('data_deletion.opt2_p1')}</p>
      <p>
        <strong>
          <a href="mailto:support@almamesh.com">support@almamesh.com</a>
        </strong>
      </p>
      <p>{t('data_deletion.opt2_p2')}</p>
      <ul>
        <li>{t('data_deletion.opt2_li1')}</li>
        <li>{t('data_deletion.opt2_li2')}</li>
      </ul>
      <p>{t('data_deletion.opt2_p3')}</p>

      <h2>{t('data_deletion.deleted_heading')}</h2>
      <p>{t('data_deletion.deleted_p1')}</p>
      <ul>
        <li>{t('data_deletion.deleted_li1')}</li>
        <li>{t('data_deletion.deleted_li2')}</li>
        <li>{t('data_deletion.deleted_li3')}</li>
        <li>{t('data_deletion.deleted_li4')}</li>
        <li>{t('data_deletion.deleted_li5')}</li>
      </ul>
      <p>{t('data_deletion.deleted_quarantine')}</p>

      <h2>{t('data_deletion.retention_heading')}</h2>
      <ul>
        <li>{t('data_deletion.retention_li1')}</li>
        <li>{t('data_deletion.retention_li2')}</li>
      </ul>

      <h2>{t('data_deletion.questions_heading')}</h2>
      <p>
        {t('data_deletion.questions_p1_prefix')}{' '}
        <a href="mailto:privacy@almamesh.com">privacy@almamesh.com</a>{' '}
        {t('data_deletion.questions_p1_suffix')}
      </p>
    </LegalPageLayout>
  );
}
