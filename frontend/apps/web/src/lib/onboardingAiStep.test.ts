import { describe, expect, it } from 'vitest';
import {
  AI_SETUP_REQUIRED_IN_ONBOARDING,
  ONBOARDING_AI_PATH,
  nextAfterRectify,
  routeAfterChart,
} from './onboardingAiStep';

describe('onboarding AI step routing', () => {
  it('ships skippable: the "AI is mandatory" flag defaults to off', () => {
    // Pinned to the literal the product promise makes today ("Not now" is shown).
    expect(AI_SETUP_REQUIRED_IN_ONBOARDING).toBe(false);
  });

  it('lives at /onboarding/ai', () => {
    expect(ONBOARDING_AI_PATH).toBe('/onboarding/ai');
  });

  it('sends a fresh chart with no AI to the AI step', () => {
    expect(routeAfterChart(false)).toBe('/onboarding/ai');
  });

  it('skips the AI step when AI is already set up', () => {
    expect(routeAfterChart(true)).toBe('/dashboard');
  });

  it('rectify follows the onboarding hint when it came from onboarding', () => {
    expect(nextAfterRectify({ next: '/onboarding/ai' })).toBe('/onboarding/ai');
  });

  it('rectify goes to the dashboard without a hint, or with a hint it does not trust', () => {
    expect(nextAfterRectify(null)).toBe('/dashboard');
    expect(nextAfterRectify(undefined)).toBe('/dashboard');
    expect(nextAfterRectify({})).toBe('/dashboard');
    expect(nextAfterRectify({ next: 'https://evil.example/' })).toBe('/dashboard');
    expect(nextAfterRectify({ next: '/settings/data' })).toBe('/dashboard');
    expect(nextAfterRectify('nope')).toBe('/dashboard');
  });
});
