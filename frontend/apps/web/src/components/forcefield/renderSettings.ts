/**
 * Force-field render settings from the one device tier (`devicePolicy` in
 * `@almamesh/browser`). On a phone the post-processing pass (bloom render
 * targets) and a 2-3x canvas are the force field's largest GPU allocations, so
 * the minimal tier draws without them.
 */
import type { DevicePolicy } from '@almamesh/browser';

export interface ForceFieldRenderSettings {
  readonly effects: DevicePolicy['forceFieldEffects'];
  /** R3F `dpr` range: [min, max]. */
  readonly dpr: readonly [number, number];
}

export function forceFieldRenderSettings(policy: DevicePolicy): ForceFieldRenderSettings {
  return { effects: policy.forceFieldEffects, dpr: [1, policy.forceFieldMaxDpr] };
}
