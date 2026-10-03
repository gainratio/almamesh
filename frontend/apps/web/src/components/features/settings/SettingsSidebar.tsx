/**
 * SettingsSidebar Component
 *
 * Navigation sidebar for the Settings hub with category links.
 * Supports icons and active state highlighting.
 */

import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

interface SettingsNavItem {
  path: string;
  /** Stable, untranslated key used for the data-testid (kept for selectors). */
  testid: string;
  labelKey: string;
  descriptionKey: string;
  icon: React.ReactNode;
}

const SETTINGS_NAV_ITEMS: SettingsNavItem[] = [
  {
    path: '/settings/profile',
    testid: 'profile',
    labelKey: 'nav.profile',
    descriptionKey: 'nav.profile_description',
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
        />
      </svg>
    ),
  },
  {
    path: '/settings/people',
    testid: 'people',
    labelKey: 'nav.people',
    descriptionKey: 'nav.people_description',
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-1.13a4 4 0 10-4-4 4 4 0 004 4zm6-3a3 3 0 10-3-3 3 3 0 003 3z"
        />
      </svg>
    ),
  },
  {
    path: '/settings/ai',
    testid: 'ai model',
    labelKey: 'nav.ai',
    descriptionKey: 'nav.ai_description',
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
        />
      </svg>
    ),
  },
  {
    path: '/settings/preferences',
    testid: 'preferences',
    labelKey: 'nav.preferences',
    descriptionKey: 'nav.preferences_description',
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
        />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
  {
    path: '/settings/data',
    testid: 'data',
    labelKey: 'nav.data',
    descriptionKey: 'nav.data_description',
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M4 7v10c0 1.657 3.582 3 8 3s8-1.343 8-3V7M4 7c0 1.657 3.582 3 8 3s8-1.343 8-3M4 7c0-1.657 3.582-3 8-3s8 1.343 8 3"
        />
      </svg>
    ),
  },
];

export function SettingsSidebar() {
  const { t } = useTranslation('settings');
  return (
    <nav className="w-64 shrink-0" aria-label={t('layout.sidebar_aria')}>
      <ul className="space-y-1">
        {SETTINGS_NAV_ITEMS.map((item) => (
          <li key={item.path}>
            <NavLink
              to={item.path}
              className={({ isActive }) =>
                `flex items-start gap-3 px-4 py-3 rounded-lg transition-colors ${
                  isActive
                    ? 'bg-accent-gold/10 text-accent-gold border border-accent-gold/30'
                    : 'text-text-secondary hover:bg-background-tertiary hover:text-text-primary border border-transparent'
                }`
              }
              data-testid={`settings-nav-${item.testid}`}
            >
              <span className="shrink-0 mt-0.5">{item.icon}</span>
              <div className="flex-1 min-w-0">
                <span className="block font-medium">{t(item.labelKey)}</span>
                <span className="block text-xs text-text-muted mt-0.5">
                  {t(item.descriptionKey)}
                </span>
              </div>
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export default SettingsSidebar;
