/**
 * The chat asks the person which place they meant. When read_period or travel finds
 * several places ("Springfield"), it hands the candidates here and waits; the
 * chat panel's picker shows them and answers with the pick, or with nothing
 * when the person cancels. The model never guesses between them.
 *
 * One request at a time: a new one closes the old (answered with nothing), the
 * chat stopping or the tool deadline closes it, and so does the picker going
 * away. With no picker on screen (no chat panel, a test, the trip harness) the
 * answer is NO_PLACE_PICKER at once and the tool falls back to listing the
 * candidates for the model to ask about in words.
 */
import type { ResolvedPlace } from './geo/placeLookup';

export const NO_PLACE_PICKER = 'no_place_picker' as const;

export interface PlacePickRequest {
  /** What the person (through the model) typed, e.g. "Springfield". */
  readonly query: string;
  readonly candidates: readonly ResolvedPlace[];
  /** The pick, or undefined when the person cancels. Only the first answer counts. */
  readonly answer: (place: ResolvedPlace | undefined) => void;
}

let pickers = 0;
let pending: PlacePickRequest | undefined;
const listeners = new Set<() => void>();

function show(next: PlacePickRequest | undefined): void {
  pending = next;
  for (const listener of listeners) listener();
}

/** The picker in the chat panel is on screen; call the result when it goes away. */
export function mountPlacePicker(): () => void {
  pickers += 1;
  let mounted = true;
  return () => {
    if (!mounted) return;
    mounted = false;
    pickers -= 1;
    if (pickers === 0) pending?.answer(undefined);
  };
}

export function pendingPlacePick(): PlacePickRequest | undefined {
  return pending;
}

export function subscribePlacePick(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Wait for the person to pick one of `candidates`; see the module comment for every way it ends. */
export function askToPickPlace(
  query: string,
  candidates: readonly ResolvedPlace[],
  signal: AbortSignal,
): Promise<ResolvedPlace | undefined | typeof NO_PLACE_PICKER> {
  if (pickers === 0) return Promise.resolve(NO_PLACE_PICKER);
  pending?.answer(undefined);
  return new Promise((resolve) => {
    let open = true;
    const finish = (place: ResolvedPlace | undefined) => {
      if (!open) return;
      open = false;
      signal.removeEventListener('abort', onAbort);
      if (pending === request) show(undefined);
      resolve(place);
    };
    const onAbort = () => finish(undefined);
    const request: PlacePickRequest = { query, candidates, answer: finish };
    if (signal.aborted) {
      resolve(undefined);
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    show(request);
  });
}
