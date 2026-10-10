export type WebKitRole = 'web' | 'network' | 'gpu' | 'ui';

export interface WebKitProcess {
  pid: number;
  role: WebKitRole;
  rssBytes: number;
}

export interface WebKitRssSample {
  atMs: number;
  processes: WebKitProcess[];
}

export interface WebKitRssSummary {
  samples: number;
  peakTotalMiB: number | null;
  peakByRoleMiB: Partial<Record<WebKitRole, number>>;
  peakSingleWebMiB: number | null;
}

export const PS_ARGS: string[];
export function webkitRole(command: string): WebKitRole;
export function parseWebKitPs(output: string): WebKitProcess[];
export function summarizeWebKitRss(samples: WebKitRssSample[]): WebKitRssSummary;
export function formatWebKitRssCsv(samples: WebKitRssSample[]): string;
