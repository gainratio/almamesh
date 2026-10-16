import { describe, expect, it } from 'vitest';

import { LIFE_DOMAINS } from '../lifeAtlas';
// @ts-expect-error -- a plain .mjs helper for the node verify scripts; no types.
import { LIFE_DOMAINS as SCRIPT_LIFE_DOMAINS } from '../../../scripts/lifeDomains.mjs';

describe('scripts/lifeDomains.mjs', () => {
  it('reads exactly the LIFE_DOMAINS the app renders (obstacles included)', () => {
    expect(SCRIPT_LIFE_DOMAINS).toEqual([...LIFE_DOMAINS]);
    expect(SCRIPT_LIFE_DOMAINS).toContain('obstacles');
  });
});
