// Build-time seam for onnxruntime-web (vite.config.ts).
//
// @huggingface/transformers 4.x imports `onnxruntime-web/webgpu`, whose default
// bundle embeds `new URL('ort-wasm-simd-threaded.asyncify.wasm', import.meta.url)`.
// Vite then emits that 26.86 MB file, over Cloudflare Pages' 25 MiB per-file
// upload limit. AlmaMesh only runs the embedder on the wasm (CPU) device, so we
// point the import at ORT's wasm-only export and select ORT's documented
// `onnxruntime-web-use-extern-wasm` condition, which leaves the binary out of
// the bundle entirely. The worker then loads the plain 14 MB
// `ort-wasm-simd-threaded.{mjs,wasm}` same-origin from /models/ort/ (wasmPaths
// in packages/memory/src/embedder.worker.ts; copied by setup-dev-assets.sh).
import { defaultClientConditions, type Plugin } from 'vite';

/** onnxruntime-web's package-exports condition for "do not embed the wasm". */
export const ORT_EXTERN_WASM_CONDITION = 'onnxruntime-web-use-extern-wasm';

export function ortWasmOnlyPlugin(): Plugin {
  return {
    name: 'ort-wasm-only',
    config() {
      return {
        resolve: {
          alias: [{ find: /^onnxruntime-web\/webgpu$/, replacement: 'onnxruntime-web/wasm' }],
          conditions: [...defaultClientConditions, ORT_EXTERN_WASM_CONDITION],
        },
      };
    },
  };
}
