import { beforeEach, describe, expect, it } from 'vitest';
import { getProfileMemoryFacts, useProfilesStore } from '@almamesh/store';

import { createRememberFactTool } from '../memoryTool';

const CTX = { now: new Date('2026-11-11T18:00:00Z'), signal: new AbortController().signal };

beforeEach(() => {
  useProfilesStore.setState({ profiles: {}, activeProfileId: null });
});

describe('remember_fact tool', () => {
  it('saves a sanitized durable context note to the active profile memory store', async () => {
    const profileId = useProfilesStore.getState().createProfile('Asha');
    const tool = createRememberFactTool({ profileId });

    const result = await tool.execute(
      {
        fact: 'Building an AI fintech startup; contact me@example.com or 38.1074, -122.5697',
        category: 'career',
      },
      CTX,
    );

    expect(result).toMatchObject({
      status: 'remembered',
      category: 'career',
    });
    const text = (result as { fact: string }).fact;
    expect(text).toContain('Building an AI fintech startup');
    expect(text).not.toContain('me@example.com');
    expect(text).not.toContain('38.1074');

    const stored = getProfileMemoryFacts(useProfilesStore.getState().profiles[profileId]);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.text).toBe(text);
  });

  it('returns ignored when input consists solely of stripped PII', async () => {
    const profileId = useProfilesStore.getState().createProfile('Asha');
    const tool = createRememberFactTool({ profileId });

    const result = await tool.execute(
      { fact: 'me@example.com 38.1074, -122.5697', category: 'life' },
      CTX,
    );

    expect(result).toEqual({ status: 'ignored', reason: 'empty_after_sanitization' });
    expect(getProfileMemoryFacts(useProfilesStore.getState().profiles[profileId])).toEqual([]);
  });

  it('returns ignored when no profile exists in store', async () => {
    const tool = createRememberFactTool({ profileId: undefined });
    const result = await tool.execute({ fact: 'Studying Jyotish classics', category: 'preference' }, CTX);
    expect(result).toEqual({ status: 'ignored', reason: 'no_active_profile' });
  });
});
