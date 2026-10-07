import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLanguageStore, type Language } from '@almamesh/store';
import { Select } from '../../ui';

/** Canonical public source repository. */
export const GITHUB_URL = 'https://github.com/gainratio/almamesh';

/**
 * The GitHub octocat mark, inlined as an SVG so the open-source signal renders
 * with zero external requests (project rule: no icon CDN, offline-first). Sized
 * in `em` so it scales with the surrounding text; pass sizing/color via
 * `className`. Decorative — always paired with a visible or aria label.
 */
export function GithubMark({ className }: { className?: string }): ReactElement {
  return (
    <svg
      viewBox="0 0 16 16"
      width="1em"
      height="1em"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path
        fillRule="evenodd"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
  );
}

/**
 * The splash footer — one honest line, the legal/source links, and the language
 * switcher (mirroring the nav so a visitor who scrolled can still re-language).
 */
export function LandingFooter(): ReactElement {
  const { t } = useTranslation('landing');
  const language = useLanguageStore((s) => s.language);
  const setLanguage = useLanguageStore((s) => s.setLanguage);

  return (
    <footer className="border-t border-ui-border/60 bg-background-darker">
      <div className="mx-auto w-full max-w-6xl px-5 py-12 md:px-8">
        <div className="flex flex-col gap-8 md:flex-row md:items-start md:justify-between">
          <div className="max-w-md">
            <p className="font-display text-lg text-text-primary">
              Alma<span className="text-accent-gold">Mesh</span>
            </p>
            <p className="mt-3 text-sm leading-relaxed text-text-muted">{t('footer.tagline')}</p>
          </div>

          <nav
            aria-label={t('footer.tagline')}
            className="flex flex-col gap-3 text-sm text-text-secondary"
          >
            <Link to="/privacy" className="transition-colors hover:text-accent-gold-bright">
              {t('footer.privacy')}
            </Link>
            <Link to="/terms" className="transition-colors hover:text-accent-gold-bright">
              {t('footer.terms')}
            </Link>
            <Link to="/data-deletion" className="transition-colors hover:text-accent-gold-bright">
              {t('footer.dataDeletion')}
            </Link>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 transition-colors hover:text-accent-gold-bright"
            >
              <GithubMark className="h-4 w-4" />
              {t('footer.github')}
            </a>
          </nav>

          <div className="flex flex-col gap-2">
            <label
              htmlFor="landing-footer-language"
              className="text-xs uppercase tracking-[0.2em] text-text-muted"
            >
              {t('nav.languageLabel')}
            </label>
            <Select
              id="landing-footer-language"
              aria-label={t('nav.languageLabel')}
              value={language}
              onChange={(e) => setLanguage(e.target.value as Language)}
              className="w-auto min-w-[9rem]"
            >
              <option value="en">English</option>
              <option value="es">Español</option>
              <option value="pt">Português</option>
            </Select>
          </div>
        </div>

        <div className="mt-10 border-t border-ui-border/40 pt-6 text-xs text-text-muted">
          <span>&copy; {new Date().getFullYear()} AlmaMesh</span>
        </div>
      </div>
    </footer>
  );
}
