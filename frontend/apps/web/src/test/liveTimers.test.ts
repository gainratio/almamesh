/**
 * The suite-wide teardown guard (test/setup.ts) is only as good as this
 * tracker: if it misses a timer, a leak goes back to failing CI at random.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { liveTimers, teardownHazards } from './liveTimers';

const pending: Array<() => void> = [];

afterEach(() => {
  pending.splice(0).forEach((cancel) => cancel());
});

function armInterval(): ReturnType<typeof setInterval> {
  const id = setInterval(() => undefined, 60_000);
  pending.push(() => clearInterval(id));
  return id;
}

describe('live timer tracking', () => {
  it('reports an interval until it is cleared, with the line that armed it', () => {
    const id = armInterval();

    const [hazard] = teardownHazards();
    expect(hazard?.kind).toBe('interval');
    expect(hazard?.createdAt).toContain('liveTimers.test.ts');

    clearInterval(id);
    expect(teardownHazards()).toEqual([]);
  });

  it('reports a timeout from our code until it fires', async () => {
    let fired!: () => void;
    const done = new Promise<void>((resolve) => {
      fired = resolve;
    });
    setTimeout(() => fired(), 0);
    expect(teardownHazards().map((t) => t.kind)).toEqual(['timeout']);

    await done;

    expect(teardownHazards()).toEqual([]);
  });

  it('forgets a timeout once it is cleared', () => {
    const id = setTimeout(() => undefined, 60_000);
    clearTimeout(id);

    expect(liveTimers(['timeout'])).toEqual([]);
  });

  it('tracks animation-frame callbacks but does not count them as hazards', () => {
    const id = requestAnimationFrame(() => undefined);
    pending.push(() => cancelAnimationFrame(id));

    expect(liveTimers(['animationFrame'])).toHaveLength(1);
    expect(teardownHazards()).toEqual([]);

    cancelAnimationFrame(id);
    expect(liveTimers(['animationFrame'])).toEqual([]);
  });

  it('does not count a timeout scheduled from inside node_modules', () => {
    // Simulate a library frame: the caller line is what classifies a timer.
    const libraryScheduler = new Function(
      'setTimeout',
      'return setTimeout(() => undefined, 60_000);\n//# sourceURL=/x/node_modules/lib/index.js',
    ) as (schedule: typeof setTimeout) => ReturnType<typeof setTimeout>;
    const id = libraryScheduler(setTimeout);
    pending.push(() => clearTimeout(id));

    expect(liveTimers(['timeout'])).toHaveLength(1);
    expect(teardownHazards()).toEqual([]);
  });
});
