// @vitest-environment node
//
// Builds the REAL installed @huggingface/transformers through Vite with the
// plugin, so a transformers / onnxruntime-web upgrade that changes how the ORT
// wasm is pulled in fails here instead of in the Cloudflare Pages upload.
import path from 'node:path';
import { build, type Plugin, type Rollup } from 'vite';
import { describe, expect, it } from 'vitest';

import { ORT_EXTERN_WASM_CONDITION, ortWasmOnlyPlugin } from './ortWasmOnly';

const WEB_ROOT = path.resolve(__dirname, '../..');

// A virtual entry that lives (in name only) inside apps/web, so its imports
// resolve through the app's real node_modules exactly like the embedder worker.
const ENTRY = path.join(WEB_ROOT, '__ort_probe_entry__.ts');
const ENTRY_SOURCE = "export { env, pipeline } from '@huggingface/transformers';\n";

const virtualEntry: Plugin = {
  name: 'ort-probe-entry',
  resolveId: (id) => (id === ENTRY ? ENTRY : null),
  load: (id) => (id === ENTRY ? ENTRY_SOURCE : null),
};

async function bundleTransformers(plugins: Plugin[]): Promise<Rollup.OutputBundle[string][]> {
  const result = await build({
    root: WEB_ROOT,
    configFile: false,
    logLevel: 'silent',
    plugins: [virtualEntry, ...plugins],
    // An app build, not lib mode: lib mode inlines every asset as base64, which
    // would hide the emitted .wasm this test exists to catch.
    build: {
      write: false,
      rollupOptions: { input: ENTRY, preserveEntrySignatures: 'strict' },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  return outputs.flatMap((out) => ('output' in out ? out.output : []));
}

function wasmAssets(files: Rollup.OutputBundle[string][]): string[] {
  return files.filter((f) => f.fileName.endsWith('.wasm')).map((f) => f.fileName);
}

function code(files: Rollup.OutputBundle[string][]): string {
  return files.map((f) => (f.type === 'chunk' ? f.code : '')).join('\n');
}

describe('ortWasmOnlyPlugin', () => {
  it('uses the documented onnxruntime-web external-wasm export condition', () => {
    expect(ORT_EXTERN_WASM_CONDITION).toBe('onnxruntime-web-use-extern-wasm');
  });

  it('without the plugin, transformers 4.x drags in the >25 MiB asyncify wasm', async () => {
    const files = await bundleTransformers([]);
    expect(wasmAssets(files).some((name) => name.includes('asyncify'))).toBe(true);
  }, 120_000);

  it('emits no wasm asset and loads only the plain CPU build by name', async () => {
    const files = await bundleTransformers([ortWasmOnlyPlugin()]);
    expect(wasmAssets(files)).toEqual([]);
    const js = code(files);
    expect(js).toContain('ort-wasm-simd-threaded.mjs');
    expect(js).not.toMatch(/ort-wasm-simd-threaded\.(asyncify|jsep|jspi)/);
  }, 120_000);
});
