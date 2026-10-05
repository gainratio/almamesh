import type { StorageBrowser } from './detectStorageBrowser';

/** How the browser's setting should look once storage is allowed. */
export type SwitchArt = 'checkbox-off' | 'toggle-off' | 'toggle-on';

export interface BrowserSteps {
  /** i18n key segment under storage_blocked.{browser,steps}. */
  readonly key: string;
  /** Step ids, in order, under storage_blocked.steps.<key>. */
  readonly steps: readonly string[];
  readonly art: SwitchArt;
  /** i18n key under storage_blocked.illustration naming the setting. */
  readonly setting: string;
}

export const BROWSER_STEPS: Readonly<Record<StorageBrowser, BrowserSteps>> = {
  'safari-macos': {
    key: 'safari_macos',
    steps: ['open', 'privacy', 'untick', 'back', 'private'],
    art: 'checkbox-off',
    setting: 'safari_macos_setting',
  },
  'safari-ios': {
    key: 'safari_ios',
    steps: ['open', 'safari', 'toggle', 'back', 'private'],
    art: 'toggle-off',
    setting: 'safari_ios_setting',
  },
  chromium: {
    key: 'chromium',
    steps: ['open', 'allow', 'site_info', 'back', 'private'],
    art: 'toggle-on',
    setting: 'generic_setting',
  },
  firefox: {
    key: 'firefox',
    steps: ['padlock', 'settings', 'allow', 'private'],
    art: 'toggle-on',
    setting: 'generic_setting',
  },
  other: {
    key: 'other',
    steps: ['settings', 'back', 'private'],
    art: 'toggle-on',
    setting: 'generic_setting',
  },
};
