import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

interface FooterProps {
  className?: string;
}

export function Footer({ className = '' }: FooterProps) {
  const { t } = useTranslation();
  return (
    <footer className={`bg-background-secondary border-t border-ui-border py-6 px-4 sm:px-6 ${className}`}>
      <div className="max-w-7xl mx-auto flex flex-wrap gap-4 md:gap-6 text-sm text-text-muted items-center justify-between">
        <div className="flex flex-wrap gap-4 md:gap-6">
          <Link to="/privacy" className="hover:text-text-secondary transition-colors">
            {t('footer.privacy')}
          </Link>
          <Link to="/terms" className="hover:text-text-secondary transition-colors">
            {t('footer.terms')}
          </Link>
          <Link to="/data-deletion" className="hover:text-text-secondary transition-colors">
            {t('footer.data_deletion')}
          </Link>
          <Link to="/how-we-test" className="hover:text-text-secondary transition-colors">
            {t('footer.how_we_test')}
          </Link>
        </div>
        <span>&copy; {new Date().getFullYear()} AlmaMesh</span>
      </div>
    </footer>
  );
}
