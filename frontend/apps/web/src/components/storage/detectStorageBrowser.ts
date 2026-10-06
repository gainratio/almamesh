/**
 * Which browser's storage settings the block screen should explain.
 *
 * Pure and navigator-shaped so it can be unit-tested with real user-agent
 * strings. Private windows are not detected: no browser exposes that
 * honestly, so the screen shows a short "not in a private window" step instead.
 */
export type StorageBrowser = 'safari-macos' | 'safari-ios' | 'chromium' | 'firefox' | 'other';

export interface NavigatorLike {
  readonly userAgent: string;
  readonly platform?: string;
  readonly maxTouchPoints?: number;
  readonly userAgentData?: {
    readonly brands?: ReadonlyArray<{ readonly brand: string }>;
    readonly platform?: string;
  };
}

const IOS_DEVICE = /iPhone|iPad|iPod/;
// Chrome, Firefox and Edge on iOS: WebKit inside, but Safari's settings do not apply.
const IOS_OTHER_BROWSER = /CriOS|FxiOS|EdgiOS|OPiOS/;
const CHROMIUM_UA = /Chrome\/|Chromium\/|Edg\/|OPR\//;
const CHROMIUM_BRANDS = /Chromium|Google Chrome|Microsoft Edge|Opera|Brave/;

function isIos(nav: NavigatorLike): boolean {
  if (IOS_DEVICE.test(nav.userAgent)) return true;
  // iPadOS asks for desktop sites with a Mac user agent; only touch tells it apart.
  return /Macintosh/.test(nav.userAgent) && (nav.maxTouchPoints ?? 0) > 1;
}

function isChromium(nav: NavigatorLike): boolean {
  const brands = nav.userAgentData?.brands ?? [];
  return brands.some(({ brand }) => CHROMIUM_BRANDS.test(brand)) || CHROMIUM_UA.test(nav.userAgent);
}

export function detectStorageBrowser(nav: NavigatorLike | undefined): StorageBrowser {
  if (nav === undefined) return 'other';
  if (isIos(nav)) return IOS_OTHER_BROWSER.test(nav.userAgent) ? 'other' : 'safari-ios';
  if (/Firefox\//.test(nav.userAgent)) return 'firefox';
  if (isChromium(nav)) return 'chromium';
  if (/Macintosh/.test(nav.userAgent) && /Version\/[\d.]+.*Safari\//.test(nav.userAgent)) return 'safari-macos';
  return 'other';
}
