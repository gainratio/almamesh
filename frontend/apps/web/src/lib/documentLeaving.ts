/**
 * Has this page started navigating away?
 *
 * WebKit (Safari and every iOS browser) cancels the outgoing page's in-flight
 * loads the moment a navigation starts, right after `beforeunload`, and keeps
 * running that page's scripts until the new page commits. The cancelled loads
 * surface as chunk-import failures ("Importing a module script failed.") and
 * engine boot failures, which look exactly like a stale service-worker shell.
 * A self-heal that answers them with `location.reload()` starts a navigation of
 * its own, and that one REPLACES the visitor's: on real Safari 26.6.1 a direct
 * visit to /onboarding landed back on `/` with navigation type "reload".
 *
 * Automatic recovery asks this first and stands down; explicit user actions
 * (a Reload button) never do. If the navigation never commits (a download, a
 * 204), the flag lapses after {@link LEAVING_WINDOW_MS} so later failures can
 * still heal.
 */

/** How long a started navigation keeps automatic recovery standing down. */
export const LEAVING_WINDOW_MS = 10_000;

const leavingSince = new WeakMap<EventTarget, number>();
const watched = new WeakSet<EventTarget>();

function watch(target: EventTarget): void {
  if (watched.has(target)) return;
  watched.add(target);
  target.addEventListener('beforeunload', () => {
    leavingSince.set(target, Date.now());
  });
  // Shown again (back/forward cache): this page is not leaving any more.
  target.addEventListener('pageshow', () => {
    leavingSince.delete(target);
  });
}

/** True from `beforeunload` until the page is shown again or the window lapses. */
export function isDocumentLeaving(target: EventTarget = window): boolean {
  watch(target);
  const since = leavingSince.get(target);
  return since !== undefined && Date.now() - since < LEAVING_WINDOW_MS;
}

// Watch from the first module evaluation: the navigation that matters can
// start before any recovery path has asked.
if (typeof window !== 'undefined') watch(window);
