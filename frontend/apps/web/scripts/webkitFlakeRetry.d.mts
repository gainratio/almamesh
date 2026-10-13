export interface IpsSignature {
  process: string | null;
  thread: string | null;
  exceptionType: string | null;
  signal: string | null;
  capturedAtMs: number | null;
  jscFrame: string | null;
  topFrame: string | null;
}
export type KnownFlakeFamily = 'jsc-execution-tier' | 'wasm-gc-visit';
export interface FlakeRetry {
  testId: string;
  ips: string;
  signature: IpsSignature & { family: KnownFlakeFamily };
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
export interface KnownFlakeFamilyRule {
  readonly name: KnownFlakeFamily;
  readonly exceptions: readonly string[];
  readonly field: 'jscFrame' | 'topFrame';
  readonly frame?: RegExp;
}
export const KNOWN_FLAKE: Readonly<{ process: RegExp; thread: string; jscFrame: RegExp; families: readonly KnownFlakeFamilyRule[] }>;
export function knownFlakeFamily(signature: IpsSignature | null): KnownFlakeFamily | null;
export function readIpsSignature(text: string): IpsSignature | null;
export function matchesKnownWebKitFlake(signature: IpsSignature | null): boolean;
export function planRetries(report: unknown, crashReports: CrashReportFile[]): FlakeRetryPlan;
export function retryTestList(plan: FlakeRetryPlan): string;
export function verifyRetries(plan: FlakeRetryPlan, rerunReport: unknown): { ok: boolean; problems: string[] };
export function summarizeRetryPlans(plans: SuiteRetryPlan[]): string;
