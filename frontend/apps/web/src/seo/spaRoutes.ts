/**
 * The service worker's offline app-shell fallback: an offline navigation to
 * one of these paths serves the precached shell, then React Router takes over.
 * Anything else goes to the network and gets the host's real 404.
 *
 * Kept in step with the router and public/_redirects by spaRoutes.test.ts,
 * which derives the route list from App.tsx.
 */
import { LIFE_DOMAINS } from '../lib/lifeAtlas';

export const SPA_FALLBACK_ALLOWLIST: readonly RegExp[] = [
  /^\/(?:onboarding(?:\/ai)?|dashboard|predictive|report|edit-birth-details)\/?$/,
  new RegExp(`^/life/(?:${LIFE_DOMAINS.join('|')})/?$`),
  /^\/mesh(?:\/[^/]+)?\/?$/,
  /^\/rectify\/[^/]+\/?$/,
  /^\/settings(?:\/(?:profile|people|ai|preferences|data))?\/?$/,
];
