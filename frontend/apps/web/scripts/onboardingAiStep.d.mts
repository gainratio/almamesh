import type { Page } from '@playwright/test'

export declare const ONBOARDING_AI_PATH: '/onboarding/ai'

export function passOnboardingAiStep(page: Page, options: { timeout: number }): Promise<'ai-step' | 'dashboard'>
