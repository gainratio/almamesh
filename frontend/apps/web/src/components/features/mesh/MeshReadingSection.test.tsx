import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type { MeshReading } from '@almamesh/llm';
import type { MeshEdgeCtx } from '@almamesh/shared-types';

import '../../../i18n/config';

const mocks = vi.hoisted(() => ({
  aiConfigured: false,
  generate: vi.fn(),
}));

const READING: MeshReading = {
  connection: { title: 'Saved connection', layman: 'Warm.', technical: 'Exact facts.' },
  timing_together: { title: 'Saved timing', layman: 'Steady.', technical: 'Exact windows.' },
  care: { title: 'Saved care', layman: 'Listen.', technical: 'Exact contacts.' },
};

vi.mock('@almamesh/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@almamesh/llm')>();
  return {
    ...actual,
    describeLlmStatus: () => ({ configured: mocks.aiConfigured }),
  };
});

vi.mock('../../../hooks/useMeshReading', () => ({
  useMeshReading: () => ({
    status: 'complete',
    reading: READING,
    completed: new Set(),
    generate: mocks.generate,
  }),
}));

import { MeshReadingSection } from './MeshReadingSection';

describe('MeshReadingSection durable reading', () => {
  it('shows a restored completed reading even when no AI provider is currently configured', () => {
    render(
      <MemoryRouter>
        <MeshReadingSection
          edge={{} as MeshEdgeCtx}
          readingContext={{
            pairKey: 'anchor|member',
            profileIds: ['anchor', 'member'],
            edgeRequestKey: 'edge-v1',
          }}
          onDiscuss={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('Saved connection')).toBeTruthy();
    expect(screen.getByText('Saved timing')).toBeTruthy();
    expect(screen.getByText('Saved care')).toBeTruthy();
    expect(screen.queryByTestId('mesh-reading-cta')).toBeNull();
    expect(screen.queryByTestId('mesh-reading-regenerate')).toBeNull();
  });
});
