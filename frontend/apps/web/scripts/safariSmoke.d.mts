export type SafariStorageMode = 'opfs' | 'memory';

export class SafariSmokeStageError extends Error {
  constructor(stage: string, message: string, snapshot: unknown);
  readonly stage: string;
  readonly snapshot: unknown;
}

export function runStage<T>(
  stage: string,
  timeoutMs: number,
  body: () => Promise<T>,
  snapshot: () => Promise<unknown>,
): Promise<T>;

export function formatStageFailure(error: SafariSmokeStageError): string;

export function storageModeFrom(evidence: { readonly inMemoryNotice: boolean }): SafariStorageMode;

export interface SafariSmokeOptions {
  readonly baseUrl: string | null;
  readonly route: string;
  readonly evidenceDir: string;
}

export function parseSmokeArgs(argv: readonly string[]): SafariSmokeOptions;

export function deepLinkFailure(navigation: { readonly requested: string; readonly landedPath: string }): string | null;
