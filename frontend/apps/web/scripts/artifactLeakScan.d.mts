export interface LeakNeedle {
  label: string;
  /** Every written form of the value, lowercased. */
  values: string[];
}
export const MIN_SECRET_LENGTH: number;
export const PUBLIC_ENV_NAMES: readonly string[];
export function envNeedles(env: Readonly<Record<string, string | undefined>>): LeakNeedle[];
export function gitconfigNeedles(text: string): LeakNeedle[];
export function netrcNeedles(text: string): LeakNeedle[];
export function scanDirectory(dir: string, needles: readonly LeakNeedle[]): string[];
