import type { Page } from '@playwright/test';

import { E2E_REAL_MODEL, PRODUCT_CHAT_DEFAULT_MODEL } from './realModel';

/**
 * Chat reads its model's context window from OpenRouter's public catalog (spec
 * 2026-10-13, "Context budget"; a keyless GET of /api/v1/models). Stubbed journeys
 * fulfil it here so nothing reaches the network. Both the configured model and
 * the chat default (what chat actually sends) get a 128k window, large enough
 * that no stubbed round is budget-closed; a model missing from the catalog would
 * fall back to the 8k assumption and close the turn after one tool round.
 */
export const STUB_CONTEXT_TOKENS = 131_072;

const CATALOG = {
  data: [...new Set([E2E_REAL_MODEL, PRODUCT_CHAT_DEFAULT_MODEL])].map((id) => ({ id, name: id, context_length: STUB_CONTEXT_TOKENS })),
};

/** Route the catalog read; `fulfilled` (when given) records each URL answered locally. */
export function stubModelCatalog(page: Page, fulfilled?: Set<string>): Promise<void> {
  return page.route('**/api/v1/models**', (route) => {
    fulfilled?.add(route.request().url());
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CATALOG) });
  });
}
