import { useTranslation } from 'react-i18next';
import { LegalPageLayout } from './LegalPageLayout';

export default function PrivacyPolicy() {
  const { t } = useTranslation('legal');

  return (
    <LegalPageLayout title={t('privacy.title')} lastUpdated={t('privacy.last_updated')}>
      <p>{t('privacy.intro')}</p>

      <h2>{t('privacy.s1_heading')}</h2>

      <h3>{t('privacy.s1_sub1_heading')}</h3>
      <ul>
        <li>
          <strong>{t('privacy.s1_sub1_li1_label')}</strong>: {t('privacy.s1_sub1_li1_text')}
        </li>
        <li>
          <strong>{t('privacy.s1_sub1_li2_label')}</strong>: {t('privacy.s1_sub1_li2_text')}
        </li>
        <li>
          <strong>{t('privacy.s1_sub1_li3_label')}</strong>: {t('privacy.s1_sub1_li3_text')}
        </li>
      </ul>

      <h3>{t('privacy.s1_sub2_heading')}</h3>
      <ul>
        <li>
          <strong>{t('privacy.s1_sub2_li1_label')}</strong>: {t('privacy.s1_sub2_li1_text')}
        </li>
        <li>
          <strong>{t('privacy.s1_sub2_li2_label')}</strong>: {t('privacy.s1_sub2_li2_text')}
        </li>
        <li>
          <strong>{t('privacy.s1_sub2_li3_label')}</strong>: {t('privacy.s1_sub2_li3_text')}
        </li>
      </ul>

      <h2>{t('privacy.s2_heading')}</h2>
      <p>{t('privacy.s2_p1')}</p>
      <ul>
        <li>{t('privacy.s2_li1')}</li>
        <li>{t('privacy.s2_li3')}</li>
        <li>{t('privacy.s2_li2')}</li>
        <li>{t('privacy.s2_li4')}</li>
        <li>{t('privacy.s2_li8')}</li>
      </ul>

      <p>
        {t('privacy.s2_p2_prefix')} <strong>{t('privacy.s2_p2_emphasis')}</strong>
        {t('privacy.s2_p2_suffix')}
      </p>
      <ul>
        <li>{t('privacy.s2_li5')}</li>
        <li>{t('privacy.s2_li6')}</li>
        <li>{t('privacy.s2_li7')}</li>
      </ul>

      <h2>{t('privacy.s3_heading')}</h2>
      <ul>
        <li>{t('privacy.s3_li1')}</li>
        <li>{t('privacy.s3_li2')}</li>
        <li>{t('privacy.s3_li3')}</li>
      </ul>

      <h2>{t('privacy.s4_heading')}</h2>
      <p>{t('privacy.s4_p1')}</p>

      <h2>{t('privacy.s5_heading')}</h2>
      <p>{t('privacy.s5_p1')}</p>
      <ul>
        <li>
          <strong>{t('privacy.s5_li1_label')}</strong> {t('privacy.s5_li1_text')}
        </li>
        <li>
          <strong>{t('privacy.s5_li2_label')}</strong> {t('privacy.s5_li2_text')}
        </li>
        <li>
          <strong>{t('privacy.s5_li3_label')}</strong> {t('privacy.s5_li3_text')}
        </li>
      </ul>

      <h2>{t('privacy.s6_heading')}</h2>
      <ul>
        <li>{t('privacy.s6_li1')}</li>
        <li>{t('privacy.s6_li2')}</li>
        <li>{t('privacy.s6_li3')}</li>
      </ul>

      <h2>{t('privacy.s7_heading')}</h2>
      <p>{t('privacy.s7_p1')}</p>

      <h2>{t('privacy.s8_heading')}</h2>
      <p>{t('privacy.s8_p1')}</p>

      <h2>{t('privacy.s9_heading')}</h2>
      <p>{t('privacy.s9_p1')}</p>
      <ul>
        <li>
          <strong>{t('privacy.s9_li1_label')}</strong>:{' '}
          <a href="mailto:privacy@almamesh.com">privacy@almamesh.com</a>
        </li>
        <li>
          <strong>{t('privacy.s9_li2_label')}</strong>: {t('privacy.s9_li2_visit')}{' '}
          <a href="/data-deletion">/data-deletion</a> {t('privacy.s9_li2_or_email')}{' '}
          <a href="mailto:support@almamesh.com">support@almamesh.com</a>
        </li>
      </ul>
    </LegalPageLayout>
  );
}
