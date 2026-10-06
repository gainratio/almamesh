import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import {
  EMPTY_PORTABLE_REPAIR_REPORT,
  reportDroppedWrite,
  resetDroppedWritesForTests,
} from '@almamesh/store';

import '../../../i18n/config';
import { useDataRepairNotice } from '../../../lib/dataRepairNotice';
import { AppLayout } from './AppLayout';

afterEach(() => {
  useDataRepairNotice.getState().dismiss();
  act(() => resetDroppedWritesForTests());
});

function renderLayout(): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <AppLayout>
          <p>page body</p>
        </AppLayout>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AppLayout', () => {
  it('shows the boot data-repair notice above every page body', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <AppLayout>
            <p>page body</p>
          </AppLayout>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    act(() =>
      useDataRepairNotice.getState().show({ ...EMPTY_PORTABLE_REPAIR_REPORT, droppedReadingChartIds: ['c1'] }),
    );

    expect(screen.getByTestId('data-repair-notice').textContent).toContain('1 AI reading belonged to a chart');
    expect(screen.getByText('page body')).toBeTruthy();
  });

  it('warns on every page when a change was not saved', () => {
    renderLayout();
    expect(screen.queryByTestId('dropped-writes-notice')).toBeNull();

    act(() => reportDroppedWrite('almamesh-chat-history', 'stale-generation'));

    expect(screen.getByTestId('dropped-writes-notice').textContent).toContain('Reload');
    expect(screen.getByText('page body')).toBeTruthy();
  });
});
