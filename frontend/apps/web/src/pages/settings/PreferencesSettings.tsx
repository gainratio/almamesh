/**
 * PreferencesSettings Component
 *
 * Display and notification preferences including:
 * - Content mode toggle (layman/technical)
 * - Theme selection (placeholder)
 * - Notification preferences (placeholder)
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useLanguageStore, type Language } from '@almamesh/store';
import { useContentModeStore } from '../../stores/contentMode';
import { Select } from '../../components/ui/Select';
import { Dialog } from '../../components/ui/Dialog';
import { resetEverything } from '../../lib/resetEverything';

export default function PreferencesSettings() {
  const { contentMode, setContentMode } = useContentModeStore();
  const { t } = useTranslation('settings');
  const navigate = useNavigate();
  const language = useLanguageStore((s) => s.language);
  const setLanguage = useLanguageStore((s) => s.setLanguage);

  // Danger zone: a confirmed "start fresh" that erases the chart + everything
  // derived from it (but keeps language, AI settings and the downloaded engine).
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const handleStartFresh = async () => {
    setResetting(true);
    await resetEverything();
    setResetOpen(false);
    setResetting(false);
    navigate('/');
  };

  return (
    <div className="space-y-8">
      {/* Section Header */}
      <div className="border-b border-ui-border pb-4">
        <h2 className="text-xl font-semibold text-text-primary">{t('preferences.title')}</h2>
        <p className="text-text-secondary text-sm mt-1">{t('preferences.description')}</p>
      </div>

      {/* Display Settings Section */}
      <section>
        <h3 className="text-lg font-medium text-text-primary mb-4">{t('preferences.display')}</h3>

        <div className="space-y-4">
          {/* Content Mode */}
          <div className="p-4 bg-background-tertiary border border-ui-border rounded-lg">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <p className="text-text-primary font-medium">{t('preferences.content_style')}</p>
                <p className="text-text-secondary text-sm mt-1">
                  {t('preferences.content_style_description')}
                </p>
              </div>
              <div className="flex items-center gap-2 bg-background-secondary rounded-lg p-1">
                <button
                  onClick={() => setContentMode('layman')}
                  className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
                    contentMode === 'layman'
                      ? 'bg-accent-gold text-background-primary'
                      : 'text-text-secondary hover:text-text-primary'
                  }`}
                  data-testid="content-mode-layman"
                >
                  {t('preferences.content_for_you')}
                </button>
                <button
                  onClick={() => setContentMode('technical')}
                  className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
                    contentMode === 'technical'
                      ? 'bg-accent-gold text-background-primary'
                      : 'text-text-secondary hover:text-text-primary'
                  }`}
                  data-testid="content-mode-technical"
                >
                  {t('preferences.content_for_astrologer')}
                </button>
              </div>
            </div>
            <div className="mt-4 p-3 bg-background-secondary rounded-lg">
              <p className="text-text-muted text-sm">
                {contentMode === 'layman' ? (
                  <>
                    <strong className="text-text-secondary">
                      {t('preferences.content_for_you_label')}
                    </strong>
                    {t('preferences.content_for_you_detail')}
                  </>
                ) : (
                  <>
                    <strong className="text-text-secondary">
                      {t('preferences.content_for_astrologer_label')}
                    </strong>
                    {t('preferences.content_for_astrologer_detail')}
                  </>
                )}
              </p>
            </div>
          </div>

          {/* Theme (Placeholder) */}
          <div className="p-4 bg-background-tertiary border border-ui-border rounded-lg opacity-60">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-text-primary font-medium">{t('preferences.theme')}</p>
                  <span className="px-2 py-0.5 text-xs bg-background-secondary text-text-muted rounded-sm">
                    {t('preferences.coming_soon')}
                  </span>
                </div>
                <p className="text-text-secondary text-sm mt-1">
                  {t('preferences.theme_description')}
                </p>
              </div>
              <div className="flex items-center gap-2 bg-background-secondary rounded-lg p-1">
                <button
                  disabled
                  className="px-4 py-2 text-sm font-medium rounded-md bg-accent-gold text-background-primary cursor-not-allowed"
                >
                  {t('preferences.theme_dark')}
                </button>
                <button
                  disabled
                  className="px-4 py-2 text-sm font-medium rounded-md text-text-muted cursor-not-allowed"
                >
                  {t('preferences.theme_light')}
                </button>
              </div>
            </div>
          </div>

          {/*
            Language — bound to the persisted, on-device language store. Selecting
            a language persists immediately; the app's global sync effect applies it
            to i18next + document.lang (we only call setLanguage here).
            NOTE: the es/pt UI strings are machine-translated (project transparency
            stance) — see the locale catalogs.
          */}
          <div className="p-4 bg-background-tertiary border border-ui-border rounded-lg">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <p className="text-text-primary font-medium">{t('language.title')}</p>
                <p className="text-text-secondary text-sm mt-1">{t('language.description')}</p>
              </div>
              <Select
                id="language-select"
                aria-label={t('language.title')}
                value={language}
                onChange={(e) => setLanguage(e.target.value as Language)}
                className="w-auto min-w-[10rem]"
                data-testid="language-select"
              >
                <option value="en">{t('language.english')}</option>
                <option value="es">{t('language.spanish')}</option>
                <option value="pt">{t('language.portuguese')}</option>
              </Select>
            </div>
          </div>
        </div>
      </section>

      {/* Notification Settings Section (Placeholder) */}
      <section>
        <h3 className="text-lg font-medium text-text-primary mb-4">{t('preferences.notifications')}</h3>

        <div className="p-4 bg-background-tertiary border border-ui-border rounded-lg opacity-60">
          <div className="flex items-center gap-3 mb-4">
            <svg className="h-5 w-5 text-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
              />
            </svg>
            <div>
              <p className="text-text-primary font-medium">{t('preferences.email_notifications')}</p>
              <span className="px-2 py-0.5 text-xs bg-background-secondary text-text-muted rounded-sm">
                {t('preferences.coming_soon')}
              </span>
            </div>
          </div>

          <div className="space-y-3">
            <label className="flex items-center justify-between cursor-not-allowed">
              <span className="text-text-secondary text-sm">{t('preferences.notify_weekly')}</span>
              <input
                type="checkbox"
                disabled
                className="rounded-sm border-ui-border text-accent-gold focus:ring-accent-gold/50"
              />
            </label>
            <label className="flex items-center justify-between cursor-not-allowed">
              <span className="text-text-secondary text-sm">{t('preferences.notify_dasha')}</span>
              <input
                type="checkbox"
                disabled
                className="rounded-sm border-ui-border text-accent-gold focus:ring-accent-gold/50"
              />
            </label>
            <label className="flex items-center justify-between cursor-not-allowed">
              <span className="text-text-secondary text-sm">{t('preferences.notify_product')}</span>
              <input
                type="checkbox"
                disabled
                className="rounded-sm border-ui-border text-accent-gold focus:ring-accent-gold/50"
              />
            </label>
          </div>
        </div>
      </section>

      {/* Info Box */}
      <div className="flex items-start gap-3 p-4 bg-background-tertiary border border-ui-border rounded-lg">
        <svg
          className="h-5 w-5 text-accent-gold shrink-0 mt-0.5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <div>
          <p className="text-text-primary font-medium text-sm">{t('preferences.info_title')}</p>
          <p className="text-text-secondary text-sm mt-1">{t('preferences.info_description')}</p>
        </div>
      </div>

      {/* Danger Zone — reset chart / start fresh */}
      <section data-testid="danger-zone">
        <h3 className="text-lg font-medium text-status-error mb-4">{t('reset.title')}</h3>
        <div className="p-4 bg-status-error/5 border border-status-error/30 rounded-lg">
          <div className="flex items-start justify-between gap-4">
            <p className="text-text-secondary text-sm flex-1">{t('reset.description')}</p>
            <button
              type="button"
              data-testid="reset-start-fresh"
              onClick={() => setResetOpen(true)}
              className="shrink-0 px-4 py-2 text-sm font-medium rounded-md border border-status-error/50 text-status-error hover:bg-status-error/10 transition-colors"
            >
              {t('reset.button')}
            </button>
          </div>
        </div>
      </section>

      <Dialog open={resetOpen} onClose={() => !resetting && setResetOpen(false)} title={t('reset.modal_title')}>
        <div className="space-y-4">
          <p className="text-text-secondary text-sm">{t('reset.modal_body')}</p>
          <p className="text-text-muted text-xs">{t('reset.modal_preserved')}</p>
          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={() => setResetOpen(false)}
              disabled={resetting}
              className="flex-1 px-4 py-2.5 bg-background-tertiary border border-ui-border text-text-primary rounded-md hover:bg-ui-border transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
            >
              {t('reset.modal_cancel')}
            </button>
            <button
              type="button"
              data-testid="reset-confirm"
              onClick={() => void handleStartFresh()}
              disabled={resetting}
              className="flex-1 px-4 py-2.5 bg-status-error text-background-primary rounded-md hover:bg-status-error/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm font-bold"
            >
              {t('reset.modal_confirm')}
            </button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
