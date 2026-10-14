export function summarizeIps(text: string): string[];
export function isLaneCrashReport(path: string): boolean;
export function laneReportLabel(path: string): 'crash report' | 'resource report';
export function redactIps(text: string): string;

export interface CrashSignature {
  key: string;
  process: string;
  exception: string;
  frames: string[];
}

export function crashSignature(text: string): CrashSignature | null;
export function laneSignatures(directory: string, lane: string): Array<CrashSignature & { lane: string }>;
