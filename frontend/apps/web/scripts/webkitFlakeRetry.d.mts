export interface IpsSignature {
  process: string | null;
  thread: string | null;
  exceptionType: string | null;
  signal: string | null;
  capturedAtMs: number | null;
  jscFrame: string | null;
}
export interface FlakeRetry {
  testId: string;
  ips: string;
  signature: IpsSignature;
}
export interface FlakeRefusal {
  testId: string;
  reason: string;
}
export interface FlakeRetryPlan {
  verdict: 'clean' | 'retry' | 'red';
  retries: FlakeRetry[];
  refused: FlakeRefusal[];
}
export interface SuiteRetryPlan extends FlakeRetryPlan {
  suite: string;
}
export interface CrashReportFile {
  name: string;
  text: string;
}
export const KNOWN_FLAKE: Readonly<{ process: RegExp; thread: string; exceptions: string[]; jscFrame: RegExp }>;
export function readIpsSignature(text: string): IpsSignature | null;
export function matchesKnownWebKitFlake(signature: IpsSignature | null): boolean;
export function planRetries(report: unknown, crashReports: CrashReportFile[]): FlakeRetryPlan;
export function retryTestList(plan: FlakeRetryPlan): string;
export function verifyRetries(plan: FlakeRetryPlan, rerunReport: unknown): { ok: boolean; problems: string[] };
export function summarizeRetryPlans(plans: SuiteRetryPlan[]): string;
