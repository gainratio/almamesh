/**
 * The embedding Web Worker: runs a Transformers.js feature-extraction pipeline
 * (`Xenova/all-MiniLM-L6-v2`) entirely in-browser, off the UI thread, and
 * returns L2-normalized sentence embeddings.
 *
 * ZERO-EGRESS / OFFLINE CONTRACT — read before changing the `env` config:
 *   The model weights MUST be self-hosted, same-origin, under the app's
 *   `public/models/` so the bytes never touch the HuggingFace CDN. A model CDN
 *   would break offline use and leak usage the same way a font CDN once did.
 *   - `env.allowRemoteModels = false`  -> never fetch from the HF Hub.
 *   - `env.allowLocalModels  = true`   -> load weights from the same origin.
 *     In `@huggingface/transformers` v3, setting `allowRemoteModels = false`
 *     WITHOUT also setting `allowLocalModels = true` leaves BOTH disabled and the
 *     runtime fails closed with "both local and remote models are disabled" —
 *     silently degrading RAG/search to a no-op. Both flags are required.
 *   - `env.localModelPath = "/models/"` -> load weights from the same origin,
 *     i.e. `public/models/Xenova/all-MiniLM-L6-v2/...`.
 *   - `env.backends.onnx.wasm.wasmPaths = "/models/ort/"` -> the onnxruntime-web
 *     wasm binaries are self-hosted too (no jsDelivr fallback).
 *   - `env.backends.onnx.wasm.numThreads = 1` -> deliberately cap embedding
 *     inference to one thread even though the app is cross-origin isolated.
 *     SQLite owns the SharedArrayBuffer requirement; keeping this small model
 *     single-threaded limits memory and worker overhead on mobile devices.
 *   The apps/web setup script (WS5) places these files; this worker only reads
 *   them. This module is exercised in live e2e, NOT in unit tests.
 *
 * The heavy `@huggingface/transformers` import is confined to this file so the
 * unit-tested modules (chunk/vectorStore/index) never load the runtime.
 */

import {
  env,
  pipeline,
  type FeatureExtractionPipeline,
} from "@huggingface/transformers";

import type { EmbedWorkerRequest, EmbedWorkerResponse } from "./embedder";

// Self-hosted, same-origin weights only — see the contract above.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = "/models/";
if (env.backends.onnx.wasm !== undefined) {
  env.backends.onnx.wasm.wasmPaths = "/models/ort/";
  // Intentionally single-threaded to bound memory/worker overhead on mobile;
  // cross-origin isolation is reserved for SQLite's SharedArrayBuffer OPFS VFS.
  env.backends.onnx.wasm.numThreads = 1;
}

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

let pipelinePromise: Promise<FeatureExtractionPipeline> | undefined;

/**
 * Build (once) the feature-extraction pipeline over the self-hosted model.
 *
 * `pipeline(...)` infers a union across every task; assigning that union to a
 * concrete pipeline type trips TS2590 ("union too complex"), so we narrow it to
 * the feature-extraction pipeline through `unknown`.
 */
function getPipeline(): Promise<FeatureExtractionPipeline> {
  if (pipelinePromise === undefined) {
    pipelinePromise = pipeline("feature-extraction", MODEL_ID, {
      // Quantized weights keep the on-device download/footprint small.
      dtype: "q8",
      // The build ships only ORT's wasm (CPU) backend (vite ortWasmOnlyPlugin).
      device: "wasm",
    }) as unknown as Promise<FeatureExtractionPipeline>;
  }
  return pipelinePromise;
}

/** Mean-pool + L2-normalize a batch into one Float32 vector per input string. */
async function embedTexts(texts: readonly string[]): Promise<number[][]> {
  const extractor = await getPipeline();
  const tensor = await extractor(texts as string[], {
    pooling: "mean",
    normalize: true,
  });
  const list = tensor.tolist() as number[][];
  return list;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.addEventListener("message", (event: MessageEvent<EmbedWorkerRequest>) => {
  const { id, texts } = event.data;
  void embedTexts(texts)
    .then((vectors) => {
      const response: EmbedWorkerResponse = { id, ok: true, vectors };
      scope.postMessage(response);
    })
    .catch((error: unknown) => {
      const response: EmbedWorkerResponse = {
        id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
      scope.postMessage(response);
    });
});
