import { describe, expect, it } from 'vitest';
import { DEVICE_POLICIES } from '@almamesh/browser';

import { forceFieldRenderSettings } from './renderSettings';

describe('forceFieldRenderSettings (the force field follows the one device tier)', () => {
  it('minimal (3 GB iPhone): no post-processing pass and a 1x canvas', () => {
    expect(forceFieldRenderSettings(DEVICE_POLICIES.minimal)).toEqual({ effects: 'none', dpr: [1, 1] });
  });

  it('lite: one soft bloom, canvas capped at 1.5x', () => {
    expect(forceFieldRenderSettings(DEVICE_POLICIES.lite)).toEqual({ effects: 'lite', dpr: [1, 1.5] });
  });

  it('full: bloom + vignette, canvas up to 2x', () => {
    expect(forceFieldRenderSettings(DEVICE_POLICIES.full)).toEqual({ effects: 'full', dpr: [1, 2] });
  });
});
