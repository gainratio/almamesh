/**
 * The onboarding AI step: where a fresh chart goes next.
 *
 * After the chart is saved, a person with no AI set up lands on
 * `/onboarding/ai` ("Connect AI", with a "Not now" link). A person who already
 * has AI goes straight to the dashboard. The unknown-birth-time path goes
 * through Rectify first; Onboarding hands Rectify the next stop as React Router
 * navigation state (a navigation hint, not data), and Rectify honours it.
 */

/**
 * Make AI setup a required onboarding step. `false` (shipped): the step shows
 * "Not now" and the person can skip it. `true`: the link is gone, so the only
 * way forward is connecting an AI model.
 */
export const AI_SETUP_REQUIRED_IN_ONBOARDING = false;

export const ONBOARDING_AI_PATH = '/onboarding/ai';

const DASHBOARD_PATH = '/dashboard';

/** Navigation state Onboarding passes to Rectify. */
export interface AfterRectifyState {
  next?: string;
}

/** Where a freshly saved onboarding chart goes next. */
export function routeAfterChart(aiConfigured: boolean): string {
  return aiConfigured ? DASHBOARD_PATH : ONBOARDING_AI_PATH;
}

/**
 * Where Rectify goes when it finishes. Only the AI step is accepted as a hint;
 * anything else (no state, or a value this module did not produce) falls back to
 * the dashboard, as Rectify always did.
 */
export function nextAfterRectify(state: unknown): string {
  if (typeof state !== 'object' || state === null) return DASHBOARD_PATH;
  const next = (state as AfterRectifyState).next;
  return next === ONBOARDING_AI_PATH ? next : DASHBOARD_PATH;
}
