import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Logo } from '../../components/ui/Logo';

interface LegalPageLayoutProps {
  title: string;
  lastUpdated: string;
  children: React.ReactNode;
  /** Shown above the prose body, outside its typography styles (a lede, a figure). */
  lead?: React.ReactNode;
  /** The "English is legally authoritative" note; off for pages that are not legal documents. */
  translationNote?: boolean;
}

export function LegalPageLayout({ title, lastUpdated, children, lead, translationNote = true }: LegalPageLayoutProps) {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation('legal');
  const isTranslated = translationNote && i18n.language !== 'en';

  return (
    <div className="min-h-screen bg-background-primary flex flex-col">
      {/* Header */}
      <header className="bg-background-secondary border-b border-ui-border py-4 px-6">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <Logo size="md" linkToHome />
          <button
            onClick={() => navigate(-1)}
            className="text-text-secondary hover:text-text-primary transition-colors text-sm flex items-center gap-1"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10 19l-7-7m0 0l7-7m-7 7h18"
              />
            </svg>
            {t('layout.back')}
          </button>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 max-w-3xl mx-auto px-6 py-12 w-full">
        {isTranslated && (
          <div
            role="note"
            className="mb-6 rounded-md border border-ui-border bg-background-secondary px-4 py-3 text-sm text-text-muted"
          >
            {t('layout.mt_disclaimer')}
          </div>
        )}

        <h1 className="text-3xl font-bold text-text-primary mb-2">{title}</h1>
        <p className="text-sm text-text-muted mb-8">
          {t('layout.last_updated', { date: lastUpdated })}
        </p>

        {lead}

        <div className="prose prose-invert max-w-none text-text-secondary [&_h2]:text-text-primary [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:mt-8 [&_h2]:mb-4 [&_h3]:text-text-primary [&_h3]:text-lg [&_h3]:font-medium [&_h3]:mt-6 [&_h3]:mb-3 [&_p]:mb-4 [&_ul]:mb-4 [&_ul]:list-disc [&_ul]:pl-6 [&_li]:mb-2 [&_a]:text-accent-blue [&_a]:underline [&_a]:hover:text-accent-gold [&_strong]:text-text-primary">
          {children}
        </div>
      </main>

      {/* Footer */}
      <footer className="bg-background-secondary border-t border-ui-border py-6 px-6 mt-auto">
        <div className="max-w-3xl mx-auto flex flex-wrap gap-4 md:gap-6 text-sm text-text-muted items-center justify-between">
          <div className="flex flex-wrap gap-4 md:gap-6">
            <Link to="/privacy" className="hover:text-text-secondary transition-colors">
              {t('layout.privacy_link')}
            </Link>
            <Link to="/terms" className="hover:text-text-secondary transition-colors">
              {t('layout.terms_link')}
            </Link>
            <Link to="/data-deletion" className="hover:text-text-secondary transition-colors">
              {t('layout.data_deletion_link')}
            </Link>
            <Link to="/how-we-test" className="hover:text-text-secondary transition-colors">
              {t('layout.how_we_test_link')}
            </Link>
          </div>
          <span>{t('layout.copyright', { year: new Date().getFullYear() })}</span>
        </div>
      </footer>
    </div>
  );
}
