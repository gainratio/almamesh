import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { promisify } from 'node:util';

import type { BrowserContext, Logger, Page, TestInfo } from '@playwright/test';

import {
  PS_ARGS,
  formatWebKitRssCsv,
  parseWebKitPs,
  summarizeWebKitRss,
  type WebKitRssSample,
} from '../scripts/webkitProcessMemory.mjs';

const run = promisify(execFile);
const SAMPLE_INTERVAL_MS = 2_000;

/**
 * What a WebKit test leaves behind so a lost page can be diagnosed: the
 * browser's own stderr/stdout (Playwright's `browser` log), every page crash
 * and context close with a timestamp, and the WebKit processes' RSS every two
 * seconds. Written into the test's output directory, which the macOS lane
 * uploads (scripts/webkit-macos-lane.sh).
 */
export interface WebKitDiagnostics {
  logger: Logger;
  watch(context: BrowserContext): void;
  finish(): Promise<void>;
}

function stamp(): string {
  return new Date().toISOString();
}

async function sampleWebKit(): Promise<WebKitRssSample['processes']> {
  try {
    const { stdout } = await run('ps', PS_ARGS, { maxBuffer: 16 * 1024 * 1024 });
    return parseWebKitPs(stdout);
  } catch {
    return [];
  }
}

/** `name` tells two browsers in one test apart (e.g. the export and import browsers). */
export function startWebKitDiagnostics(testInfo: TestInfo, name = 'webkit'): WebKitDiagnostics {
  const lines: string[] = [`${stamp()} start ${testInfo.titlePath.join(' > ')} free=${Math.round(freemem() / 2 ** 20)}MiB of ${Math.round(totalmem() / 2 ** 20)}MiB`];
  const note = (line: string): void => {
    lines.push(`${stamp()} ${line}`);
  };
  const shout = (line: string): void => {
    note(line);
    console.error(`[webkit-diagnostics] ${line} (${testInfo.title})`);
  };
  const started = Date.now();
  const samples: WebKitRssSample[] = [];
  const timer = setInterval(() => {
    void sampleWebKit().then((processes) => samples.push({ atMs: Date.now() - started, processes }));
  }, SAMPLE_INTERVAL_MS);

  return {
    logger: {
      isEnabled: (name) => name === 'browser',
      log: (name, severity, message) => note(`[${name}:${severity}] ${String(message)}`),
    },
    watch(context) {
      const watchPage = (page: Page): void => {
        page.on('crash', () => shout(`page crashed: ${page.url()}`));
        page.on('close', () => note(`page closed: ${page.url()}`));
      };
      context.pages().forEach(watchPage);
      context.on('page', watchPage);
      context.on('close', () => note('context closed'));
    },
    async finish() {
      clearInterval(timer);
      samples.push({ atMs: Date.now() - started, processes: await sampleWebKit() });
      const summary = summarizeWebKitRss(samples);
      note(`end status=${testInfo.status ?? 'unknown'} free=${Math.round(freemem() / 2 ** 20)}MiB rss=${JSON.stringify(summary)}`);
      writeFileSync(testInfo.outputPath(`${name}-rss.csv`), formatWebKitRssCsv(samples));
      writeFileSync(testInfo.outputPath(`${name}-browser.log`), `${lines.join('\n')}\n`);
      console.log(`webkit-rss ${testInfo.project.name} ${name} ${JSON.stringify(testInfo.title)} ${JSON.stringify(summary)}`);
    },
  };
}
