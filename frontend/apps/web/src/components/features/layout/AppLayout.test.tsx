import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { EMPTY_PORTABLE_REPAIR_REPORT } from '@almamesh/store';

import '../../../i18n/config';
import { useDataRepairNotice } from '../../../lib/dataRepairNotice';
import { AppLayout } from './AppLayout';

afterEach(() => useDataRepairNotice.getState().dismiss());

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
});
