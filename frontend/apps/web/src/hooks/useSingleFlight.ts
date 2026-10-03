/**
 * useSingleFlight — at most one in-flight paid run per key.
 *
 * A paid generation has a startup window (the data lifecycle settling) before
 * the store reports `generating`. Without a guard, a second click in that
 * window started a second provider run on the user's own key. `run` registers
 * the flight synchronously, so a repeat request for the same key attaches to
 * the running promise instead of buying another run, and `activeKey` lets the
 * UI show progress (and disable the button) from the very first click.
 *
 * The task calls `release` once its user-visible phase is over; later
 * background work (for example evidence annotations) then no longer blocks a
 * deliberate new request. Settling the task always releases.
 */
import { useCallback, useRef, useState } from 'react';

export type FlightTask = (release: () => void) => Promise<void>;

export interface SingleFlight {
  /** Start `task` for `key`, or return the run already in flight for it. */
  readonly run: (key: string, task: FlightTask, supersede: () => void) => Promise<void>;
  /** The key whose user-visible phase is in flight, if any. */
  readonly activeKey: string | null;
}

interface Flight {
  readonly key: string;
  readonly promise: Promise<void>;
}

export function useSingleFlight(): SingleFlight {
  const flightRef = useRef<Flight | null>(null);
  const [activeFlight, setActiveFlight] = useState<Flight | null>(null);

  const run = useCallback((key: string, task: FlightTask, supersede: () => void) => {
    const current = flightRef.current;
    if (current?.key === key) return current.promise;
    supersede();
    let flight: Flight | null = null;
    let released = false;
    const release = (): void => {
      released = true;
      if (flight !== null && flightRef.current === flight) flightRef.current = null;
      setActiveFlight((active) => (active !== null && active === flight ? null : active));
    };
    const promise = task(release).finally(release);
    flight = { key, promise };
    if (!released) {
      flightRef.current = flight;
      setActiveFlight(flight);
    }
    return promise;
  }, []);

  return { run, activeKey: activeFlight?.key ?? null };
}
