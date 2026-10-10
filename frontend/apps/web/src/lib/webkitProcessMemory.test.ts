import { describe, expect, it } from 'vitest';

import {
  formatWebKitRssCsv,
  parseWebKitPs,
  summarizeWebKitRss,
  webkitRole,
  type WebKitRssSample,
} from '../../scripts/webkitProcessMemory.mjs';

const WEBKIT = '/Users/runner/Library/Caches/ms-playwright/webkit-2359';
const XPC = `${WEBKIT}/Playwright.app/Contents/Frameworks/WebKit.framework/Versions/A/XPCServices`;

const PS = [
  `  101     1  204800 ${XPC}/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent`,
  `  102     1   51200 ${XPC}/com.apple.WebKit.Networking.xpc/Contents/MacOS/com.apple.WebKit.Networking`,
  `  103     1   10240 ${XPC}/com.apple.WebKit.GPU.xpc/Contents/MacOS/com.apple.WebKit.GPU`,
  `  104    90   30720 ${WEBKIT}/Playwright.app/Contents/MacOS/Playwright --inspector-pipe --headless`,
  '  105     1  999999 /Applications/Safari.app/Contents/MacOS/Safari',
  '  106     1  777777 /usr/bin/grep ms-playwright/webkit',
  '',
].join('\n');

describe('parseWebKitPs (macOS `ps -axww -o pid=,ppid=,rss=,command=`)', () => {
  it('keeps only Playwright WebKit processes, with their role and RSS in bytes', () => {
    expect(parseWebKitPs(PS)).toEqual([
      { pid: 101, role: 'web', rssBytes: 204800 * 1024 },
      { pid: 102, role: 'network', rssBytes: 51200 * 1024 },
      { pid: 103, role: 'gpu', rssBytes: 10240 * 1024 },
      { pid: 104, role: 'ui', rssBytes: 30720 * 1024 },
    ]);
  });

  it('ignores a malformed line instead of inventing a process', () => {
    expect(parseWebKitPs(`garbage ${WEBKIT}/x\n  7  1  notanumber ${WEBKIT}/y`)).toEqual([]);
  });
});

describe('webkitRole', () => {
  it.each([
    ['.../com.apple.WebKit.WebContent', 'web'],
    ['.../com.apple.WebKit.WebContent.Development', 'web'],
    ['.../com.apple.WebKit.Networking', 'network'],
    ['.../com.apple.WebKit.GPU', 'gpu'],
    ['.../Playwright.app/Contents/MacOS/Playwright', 'ui'],
  ])('%s is %s', (command, role) => {
    expect(webkitRole(command)).toBe(role);
  });
});

describe('summarizeWebKitRss', () => {
  it('reports each role at its own peak, and the largest single web process', () => {
    const samples: WebKitRssSample[] = [
      { atMs: 0, processes: [{ pid: 1, role: 'web', rssBytes: 100 * 1024 * 1024 }, { pid: 2, role: 'web', rssBytes: 50 * 1024 * 1024 }] },
      { atMs: 1000, processes: [{ pid: 1, role: 'web', rssBytes: 900 * 1024 * 1024 }, { pid: 3, role: 'ui', rssBytes: 30 * 1024 * 1024 }] },
    ];
    expect(summarizeWebKitRss(samples)).toEqual({
      samples: 2,
      peakTotalMiB: 930,
      peakByRoleMiB: { web: 900, ui: 30 },
      peakSingleWebMiB: 900,
    });
  });

  it('says nothing was measured rather than reporting zero', () => {
    expect(summarizeWebKitRss([])).toEqual({ samples: 0, peakTotalMiB: null, peakByRoleMiB: {}, peakSingleWebMiB: null });
  });
});

describe('formatWebKitRssCsv', () => {
  it('writes one row per process per sample, in MiB', () => {
    const csv = formatWebKitRssCsv([{ atMs: 1500, processes: [{ pid: 9, role: 'web', rssBytes: 3 * 1024 * 1024 }] }]);
    expect(csv).toBe('at_ms,pid,role,rss_mib\n1500,9,web,3\n');
  });
});
