/**
 * The storage-block screen shows only the steps for the browser in front of
 * the user, so the detector must map real user-agent strings correctly.
 */
import { describe, expect, it } from 'vitest';
import { detectStorageBrowser, type NavigatorLike } from '../detectStorageBrowser';

const SAFARI_18_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const IPHONE_IOS_18 =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const EDGE_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0';
const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
const FIREFOX_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0';
const CHROME_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.6668.69 Mobile/15E148 Safari/604.1';
const FIREFOX_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/131.0 Mobile/15E148 Safari/605.1.15';

function nav(userAgent: string, extra: Partial<NavigatorLike> = {}): NavigatorLike {
  return { userAgent, platform: '', maxTouchPoints: 0, ...extra };
}

describe('detectStorageBrowser', () => {
  it.each<[string, NavigatorLike, string]>([
    ['Safari 18 on macOS', nav(SAFARI_18_MAC, { platform: 'MacIntel' }), 'safari-macos'],
    ['Safari on iPhone iOS 18', nav(IPHONE_IOS_18, { platform: 'iPhone', maxTouchPoints: 5 }), 'safari-ios'],
    ['iPadOS desktop-mode UA with touch', nav(SAFARI_18_MAC, { platform: 'MacIntel', maxTouchPoints: 5 }), 'safari-ios'],
    ['Chrome on macOS', nav(CHROME_MAC, { platform: 'MacIntel' }), 'chromium'],
    ['Edge on Windows', nav(EDGE_WINDOWS, { platform: 'Win32' }), 'chromium'],
    ['Chrome on Android', nav(CHROME_ANDROID, { platform: 'Linux armv8l', maxTouchPoints: 5 }), 'chromium'],
    ['Firefox on macOS', nav(FIREFOX_MAC, { platform: 'MacIntel' }), 'firefox'],
    // Safari's settings do not apply to other iOS browsers: no guessing.
    ['Chrome on iPhone', nav(CHROME_IOS, { platform: 'iPhone', maxTouchPoints: 5 }), 'other'],
    ['Firefox on iPhone', nav(FIREFOX_IOS, { platform: 'iPhone', maxTouchPoints: 5 }), 'other'],
    ['an empty user agent', nav(''), 'other'],
  ])('maps %s', (_name, navigator, expected) => {
    expect(detectStorageBrowser(navigator)).toBe(expected);
  });

  it('trusts userAgentData Chromium brands even with a reduced user agent', () => {
    const reduced = nav('Mozilla/5.0', {
      userAgentData: { brands: [{ brand: 'Brave' }, { brand: 'Chromium' }], platform: 'Windows' },
    });
    expect(detectStorageBrowser(reduced)).toBe('chromium');
  });

  it('returns other when no navigator is available', () => {
    expect(detectStorageBrowser(undefined)).toBe('other');
  });
});
