import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  descendantPids,
  parseProcStat,
  parseSmapsPrivateBytes,
  parseVmRssBytes,
  processKind,
  processTreeReport,
  readProcessTree,
  sampleProcessTreePeak,
  summarizeProcessTree,
} from '../../scripts/processMemory.mjs';

const MiB = 1024 * 1024;

describe('/proc parsing', () => {
  it('reads pid and parent pid, even when the command name has spaces and parentheses', () => {
    expect(parseProcStat('4242 (Web Content (x)) S 4100 4242 4242 0 -1')).toEqual({ pid: 4242, ppid: 4100 });
  });

  it('reads VmRSS in bytes', () => {
    expect(parseVmRssBytes('Name:\tchrome\nVmPeak:\t 9 kB\nVmRSS:\t  2048 kB\n')).toBe(2 * MiB);
  });

  it('reads private (USS) bytes from smaps_rollup: clean + dirty private pages, shared libraries excluded', () => {
    expect(
      parseSmapsPrivateBytes('Rss:  400000 kB\nPss:  300000 kB\nShared_Clean: 150000 kB\nPrivate_Clean: 1024 kB\nPrivate_Dirty: 2048 kB\n'),
    ).toBe(3 * MiB);
    expect(parseSmapsPrivateBytes('')).toBeNull();
  });

  it('returns null for a kernel thread or exited process with no VmRSS line', () => {
    expect(parseVmRssBytes('Name:\tkthreadd\n')).toBeNull();
  });
});

describe('process kinds', () => {
  it('classifies Chromium processes by --type', () => {
    expect(processKind(['/ms-playwright/chromium/chrome', '--type=renderer', '--lang=en'])).toBe('renderer');
    expect(processKind(['/ms-playwright/chromium/chrome', '--type=gpu-process'])).toBe('gpu');
    expect(processKind(['/ms-playwright/chromium/chrome', '--type=utility'])).toBe('utility');
    expect(processKind(['/ms-playwright/chromium/chrome', '--headless'])).toBe('browser');
  });

  it('reads a process title Chromium rewrote into one space-separated string', () => {
    expect(processKind(['/ms-playwright/chromium_headless_shell/headless_shell --type=renderer --lang=en-US'])).toBe('renderer');
    expect(processKind(['/ms-playwright/chromium_headless_shell/headless_shell --type=gpu-process'])).toBe('gpu');
  });

  it('classifies the WebKit web content and network processes by executable', () => {
    expect(processKind(['/ms-playwright/webkit/minibrowser-wpe/bin/WebKitWebProcess', '7', '12'])).toBe('webkit-web');
    expect(processKind(['/ms-playwright/webkit/minibrowser-wpe/bin/WebKitNetworkProcess', '7'])).toBe('webkit-network');
  });

  it('classifies the WPE build Playwright runs headless on Linux (as of 1.63)', () => {
    expect(processKind(['/ms-playwright/webkit-2359/minibrowser-wpe/bin/WPEWebProcess', '4', '14'])).toBe('webkit-web');
    expect(processKind(['/ms-playwright/webkit-2359/minibrowser-wpe/bin/WPENetworkProcess', '2'])).toBe('webkit-network');
    expect(processKind(['/ms-playwright/webkit-2359/minibrowser-wpe/bin/MiniBrowser', '--headless'])).toBe('browser');
  });

  it('calls anything else other', () => {
    expect(processKind(['node', 'script.mjs'])).toBe('other');
    expect(processKind([])).toBe('other');
    expect(processKind(['/pw/chrome', '--type=broker'])).toBe('other');
  });
});

describe('process tree', () => {
  it('finds every descendant of the root, not unrelated processes', () => {
    const parents = new Map([
      [10, 1],
      [11, 10],
      [12, 11],
      [13, 11],
      [20, 1],
      [21, 20],
    ]);
    expect(descendantPids(10, parents).sort()).toEqual([11, 12, 13]);
  });

  it('sums RSS per kind and in total, in MiB', () => {
    expect(
      summarizeProcessTree([
        { pid: 1, kind: 'renderer', rssBytes: 300 * MiB, privateBytes: null },
        { pid: 2, kind: 'renderer', rssBytes: 100 * MiB, privateBytes: null },
        { pid: 3, kind: 'gpu', rssBytes: 50 * MiB, privateBytes: null },
      ]),
    ).toEqual({ totalMiB: 450, byKind: { renderer: 400, gpu: 50 }, largestPrivateByKind: {}, processes: 3 });
  });

  // A WebKit run has more than one web process (a suspended about:blank one
  // holds ~250 MiB RSS, most of it shared libraries), so the sum of RSS per kind
  // is not "the web process". The largest single process's private memory is.
  it('keeps the largest single process private memory per kind, not the sum', () => {
    expect(
      summarizeProcessTree([
        { pid: 1, kind: 'webkit-web', rssBytes: 255 * MiB, privateBytes: 95 * MiB },
        { pid: 2, kind: 'webkit-web', rssBytes: 504 * MiB, privateBytes: 340 * MiB },
      ]).largestPrivateByKind,
    ).toEqual({ 'webkit-web': 340 });
  });

  it('reports the largest web process private peak next to the RSS sum', () => {
    const report = processTreeReport(
      { totalMiB: 900, byKind: { 'webkit-web': 759 }, largestPrivateByKind: { 'webkit-web': 340 }, processes: 3, samples: 4 },
      ['webkit-web'],
    );
    expect(report).toMatchObject({ 'webkit-webRssPeakMiB': 759, 'webkit-webPrivatePeakMiB': 340 });
  });

  describe('readProcessTree over a /proc fixture', () => {
    let root = '';
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    function proc(pid: number, ppid: number, argv: string[], rssKiB?: number, privateKiB?: number): void {
      mkdirSync(join(root, String(pid)));
      writeFileSync(join(root, String(pid), 'stat'), `${pid} (x) S ${ppid} 0 0`);
      writeFileSync(join(root, String(pid), 'cmdline'), `${argv.join('\0')}\0`);
      writeFileSync(join(root, String(pid), 'status'), rssKiB === undefined ? 'Name:\tx\n' : `VmRSS:\t${rssKiB} kB\n`);
      if (privateKiB !== undefined) {
        writeFileSync(join(root, String(pid), 'smaps_rollup'), `Private_Clean:\t0 kB\nPrivate_Dirty:\t${privateKiB} kB\n`);
      }
    }

    it('reads only our descendants and skips processes without RSS', () => {
      root = mkdtempSync(join(tmpdir(), 'proc-fixture-'));
      proc(100, 1, ['node', 'journey.mjs']);
      proc(101, 100, ['/pw/webkit/WebKitWebProcess'], 2048, 1024);
      proc(102, 100, ['/pw/webkit/WebKitNetworkProcess'], 1024);
      proc(103, 101, ['/pw/zombie']);
      proc(104, 100, ['/pw/exited'], 512);
      rmSync(join(root, '104', 'status')); // exited between listing and reading
      proc(200, 1, ['/someone-else/WebKitWebProcess'], 9999);
      mkdirSync(join(root, 'self'));

      expect(readProcessTree(100, root)).toEqual([
        { pid: 101, kind: 'webkit-web', rssBytes: 2 * MiB, privateBytes: 1 * MiB },
        { pid: 102, kind: 'webkit-network', rssBytes: 1 * MiB, privateBytes: null },
      ]);
    });

    it('keeps the peak of each kind across samples, not the last value', async () => {
      root = mkdtempSync(join(tmpdir(), 'proc-fixture-'));
      proc(100, 1, ['node']);
      proc(101, 100, ['/pw/chrome', '--type=renderer'], 300 * 1024, 200 * 1024);
      const sampler = sampleProcessTreePeak(60_000, 100, root);
      writeFileSync(join(root, '101', 'status'), `VmRSS:\t${100 * 1024} kB\n`);
      writeFileSync(join(root, '101', 'smaps_rollup'), `Private_Dirty:\t${50 * 1024} kB\n`);
      expect(await sampler.stop()).toEqual({
        totalMiB: 300,
        byKind: { renderer: 300 },
        largestPrivateByKind: { renderer: 200 },
        processes: 1,
        samples: 2,
      });
    });

    it('reports null when there is no /proc to read', async () => {
      root = mkdtempSync(join(tmpdir(), 'proc-fixture-'));
      expect(await sampleProcessTreePeak(60_000, 100, join(root, 'missing')).stop()).toBeNull();
    });
  });
});
