// Memoize identical engine calls for the life of one booted engine.
//
// WHY: the engine is deterministic — the same engine bytes + the same input give
// the same output — and the heaviest call (the predictive superset, seconds on a
// desktop and far longer on a phone) is re-requested with an identical input
// whenever the user switches back to a profile they already looked at that day:
// the predictive store keeps ONE slot, so A -> B -> A recomputed A from scratch.
//
// THE CONTRACT: a hit returns exactly what a fresh compute returns. The key is
// the engine identity (the signed bundle's content-addressed manifest hash, so
// new engine bytes never serve old results) + the call kind + the canonical
// JSON of the full input (every field, including the reference instant). Values
// are deep-copied on the way out so no caller can mutate the cached result.
//
// Deliberately IN-MEMORY and per boot: predictive results carry strength
// receipts signed with a per-Worker-boot device key, and those must never be
// made durable (see the predictive store's `withoutBootProof`).

import type { SiderealChart } from "./chart";
import type { PredictiveContexts } from "./predictive";
import type { BirthInput, PredictiveInput } from "./protocol";
import type { ChartEngine } from "./runtime";

/** Entries kept per engine; a chart is ~30 KB and a predictive payload ~60 KB. */
const DEFAULT_MEMO_CAPACITY = 32;

type MemoKind = "generateChart" | "computePredictive";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonical(record[key])]),
    );
  }
  return value;
}

/** The cache key: engine identity + call kind + canonical (key-sorted) JSON input. */
export function memoKey(identity: string, kind: MemoKind, input: unknown): string {
  return JSON.stringify([identity, kind, canonical(input)]);
}

/** A bounded LRU of settled-or-in-flight engine results. Failures are never kept. */
export class EngineMemo {
  readonly #entries = new Map<string, Promise<unknown>>();
  readonly #capacity: number;

  public constructor(capacity: number = DEFAULT_MEMO_CAPACITY) {
    this.#capacity = capacity;
  }

  public async run<T>(key: string, compute: () => Promise<T>): Promise<T> {
    const value = (await this.#entry(key, compute)) as T;
    return structuredClone(value);
  }

  #entry(key: string, compute: () => Promise<unknown>): Promise<unknown> {
    const existing = this.#entries.get(key);
    if (existing !== undefined) {
      this.#entries.delete(key); // re-insert: most recently used last
      this.#entries.set(key, existing);
      return existing;
    }
    const pending = compute();
    this.#entries.set(key, pending);
    pending.catch(() => {
      if (this.#entries.get(key) === pending) this.#entries.delete(key);
    });
    this.#evict();
    return pending;
  }

  #evict(): void {
    while (this.#entries.size > this.#capacity) {
      const oldest = this.#entries.keys().next().value as string;
      this.#entries.delete(oldest);
    }
  }
}

/** Wrap `engine` so identical chart/predictive inputs are computed once. */
export function memoizeChartEngine(
  engine: ChartEngine,
  identity: string,
  memo: EngineMemo = new EngineMemo(),
): ChartEngine {
  return {
    generateChart: (birth: BirthInput): Promise<SiderealChart> =>
      memo.run(memoKey(identity, "generateChart", birth), () => engine.generateChart(birth)),
    computePredictive: (input: PredictiveInput): Promise<PredictiveContexts> =>
      memo.run(memoKey(identity, "computePredictive", input), () =>
        engine.computePredictive(input),
      ),
    computeMeshEdge: (input) => engine.computeMeshEdge(input),
    computeRectification: (input) => engine.computeRectification(input),
    meta: () => engine.meta(),
  };
}
