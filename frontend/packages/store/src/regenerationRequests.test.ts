import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BirthInfoChanged } from './events';
import { registerRegenerationRunner, requestRegeneration } from './regenerationRequests';

const event: BirthInfoChanged = {
  birth: {
    name: 'Asha',
    date: '1990-01-15',
    time: '12:00',
    latitude: 18.52,
    longitude: 73.85,
    timezone: 'Asia/Kolkata',
    location_name: 'Pune, India',
  },
  profileId: 'p1',
};

let unregister: () => void = () => undefined;
afterEach(() => unregister());

describe('requestRegeneration — an awaitable chart regeneration', () => {
  it('resolves only when the registered runner has applied the event', async () => {
    let finish: () => void = () => undefined;
    const runner = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    unregister = registerRegenerationRunner(runner);

    let settled = false;
    const request = requestRegeneration(event).then(() => (settled = true));
    await Promise.resolve();

    expect(runner).toHaveBeenCalledWith(event);
    expect(settled).toBe(false);
    finish();
    await request;
    expect(settled).toBe(true);
  });

  it('rejects with the runner error so the caller can keep the user on a retry card', async () => {
    unregister = registerRegenerationRunner(() => Promise.reject(new Error('worker died')));
    await expect(requestRegeneration(event)).rejects.toThrow('worker died');
  });

  it('holds a request made before any runner exists and runs it on registration', async () => {
    const request = requestRegeneration(event);
    const runner = vi.fn(() => Promise.resolve());
    unregister = registerRegenerationRunner(runner);
    await request;
    expect(runner).toHaveBeenCalledWith(event);
  });

  it('stops routing to a runner once it unregisters', async () => {
    const first = vi.fn(() => Promise.resolve());
    registerRegenerationRunner(first)();
    const second = vi.fn(() => Promise.resolve());
    const request = requestRegeneration(event);
    unregister = registerRegenerationRunner(second);
    await request;
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });
});
