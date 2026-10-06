/**
 * Rules for a password the user CREATES to seal a backup (export, or the safety
 * backup taken during a restore). Nothing can recover it, so a typo would make
 * the file permanently unopenable: the user types it twice and both must match.
 */

/** True when the confirmation is exactly the password the user chose. */
export function passwordsMatch(password: string, confirmation: string): boolean {
  return password === confirmation;
}
