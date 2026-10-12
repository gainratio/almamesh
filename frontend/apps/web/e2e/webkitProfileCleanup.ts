/** Attempt every cleanup; preserve the journey error, then the first cleanup error. */
export async function withWebKitProfileCleanup(
  work: () => Promise<void>,
  cleanup: readonly (() => Promise<unknown>)[],
): Promise<void> {
  let failed = false;
  let failure: unknown;
  try { await work(); }
  catch (error) { failed = true; failure = error; }
  for (const step of cleanup) {
    try { await step(); }
    catch (error) {
      if (!failed) { failed = true; failure = error; }
    }
  }
  if (failed) throw failure;
}
