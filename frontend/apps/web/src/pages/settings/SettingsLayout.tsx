/**
 * SettingsLayout Component
 *
 * Main layout for the Settings hub with sidebar navigation and main content area.
 */

import { Outlet, Link, Navigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Logo } from '../../components/ui/Logo';
import { SettingsSidebar } from '../../components/features/settings/SettingsSidebar';
import { AvatarDropdown } from '../../components/AvatarDropdown';

export default function SettingsLayout() {
  const location = useLocation();
  const { t } = useTranslation('settings');

  // Redirect /settings to /settings/profile
  if (location.pathname === '/settings') {
    return <Navigate to="/settings/profile" replace />;
  }

  return (
    <div className="min-h-screen bg-background-primary">
      {/* Top Navigation Bar */}
      <header className="border-b border-ui-border bg-background-secondary">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Logo size="md" showText linkToHome />
            {/* Breadcrumb */}
            <nav className="flex items-center gap-2 text-sm" aria-label={t('layout.breadcrumb_aria')}>
              <span className="text-text-muted">/</span>
              <Link
                to="/settings"
                className="text-text-secondary hover:text-text-primary transition-colors"
              >
                {t('layout.breadcrumb_settings')}
              </Link>
            </nav>
          </div>
          <div className="flex items-center gap-4">
            <Link
              to="/dashboard"
              className="text-text-muted hover:text-text-primary transition-colors flex items-center gap-2"
              data-testid="back-to-dashboard-link"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M10 19l-7-7m0 0l7-7m-7 7h18"
                />
              </svg>
              <span className="hidden sm:inline">{t('layout.back_to_dashboard')}</span>
            </Link>
            <AvatarDropdown />
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="max-w-7xl mx-auto px-6 py-8">
        {/* Two-column layout: Sidebar + Content */}
        <div className="flex flex-col lg:flex-row gap-8">
          {/* Sidebar Navigation - Hidden on mobile, shown on desktop */}
          <div className="hidden lg:block">
            <SettingsSidebar />
          </div>

          {/* Mobile Navigation - Shown on mobile, hidden on desktop */}
          <div className="lg:hidden">
            <MobileSettingsNav />
          </div>

          {/* Main Content Area */}
          <div className="flex-1 min-w-0">
            <div className="bg-background-secondary border border-ui-border rounded-xl p-6">
              <Outlet />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

/**
 * Mobile-friendly navigation tabs for settings sections
 */
function MobileSettingsNav() {
  const { t } = useTranslation('settings');
  return (
    <nav className="flex gap-2 overflow-x-auto pb-2" aria-label={t('layout.mobile_nav_aria')}>
      <Link
        to="/settings/profile"
        className="shrink-0 px-4 py-2 rounded-lg text-sm font-medium transition-colors bg-background-secondary border border-ui-border text-text-secondary hover:text-text-primary"
      >
        {t('nav.profile')}
      </Link>
      <Link
        to="/settings/people"
        className="shrink-0 px-4 py-2 rounded-lg text-sm font-medium transition-colors bg-background-secondary border border-ui-border text-text-secondary hover:text-text-primary"
      >
        {t('nav.people')}
      </Link>
      <Link
        to="/settings/ai"
        className="shrink-0 px-4 py-2 rounded-lg text-sm font-medium transition-colors bg-background-secondary border border-ui-border text-text-secondary hover:text-text-primary"
      >
        {t('nav.ai')}
      </Link>
      <Link
        to="/settings/preferences"
        className="shrink-0 px-4 py-2 rounded-lg text-sm font-medium transition-colors bg-background-secondary border border-ui-border text-text-secondary hover:text-text-primary"
      >
        {t('nav.preferences')}
      </Link>
      <Link
        to="/settings/data"
        className="shrink-0 px-4 py-2 rounded-lg text-sm font-medium transition-colors bg-background-secondary border border-ui-border text-text-secondary hover:text-text-primary"
      >
        {t('nav.data')}
      </Link>
    </nav>
  );
}
