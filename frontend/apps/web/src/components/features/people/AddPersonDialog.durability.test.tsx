/**
 * AddPersonDialog must not report a person as added until they are on disk.
 *
 * Regression: the dialog closed and navigated to /onboarding the moment the
 * profiles store changed in memory, while the SQLite write was still queued.
 * A full page load straight after (typing /mesh, a refresh) lost the person.
 * The dialog now waits for the profiles commit before it closes or navigates.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLanguageStore, useProfilesStore } from '@almamesh/store';

const save = vi.hoisted(() => ({
  calls: 0,
  resolve: (): void => undefined,
  reject: (_error: Error): void => undefined,
}));
vi.mock('../../../lib/storeSaved', () => ({
  waitForStoreSaved: () => {
    save.calls += 1;
    return new Promise<void>((resolve, reject) => {
      save.resolve = resolve;
      save.reject = reject;
    });
  },
}));

import '../../../i18n/config';
import { AddPersonDialog } from './AddPersonDialog';

function renderDialog(): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={['/mesh']}>
        <Routes>
          <Route path="/mesh" element={<AddPersonDialog open onClose={() => undefined} />} />
          <Route path="/onboarding" element={<p>onboarding-page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function submit(name: string): void {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: name } });
  fireEvent.click(screen.getByRole('button', { name: 'Add & enter birth details' }));
}

function profileNames(): string[] {
  return Object.values(useProfilesStore.getState().profiles).map((p) => p.name);
}

beforeEach(() => {
  save.calls = 0;
  useLanguageStore.setState({ language: 'en' });
  useProfilesStore.setState({ profiles: {}, activeProfileId: null, hydrated: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AddPersonDialog — the person is saved before the dialog says so', () => {
  it('stays on the dialog until the profiles write commits, then moves on', async () => {
    renderDialog();
    submit('Second Friend');

    expect(save.calls).toBe(1);
    expect(screen.queryByText('onboarding-page')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add & enter birth details' })).toHaveProperty(
      'disabled',
      true,
    );

    await act(async () => save.resolve());
    expect(screen.getByText('onboarding-page')).toBeTruthy();
  });

  it('keeps the dialog open with a retryable notice when the write fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    renderDialog();
    submit('Second Friend');

    await act(async () => save.reject(new Error('disk full')));

    expect(screen.queryByText('onboarding-page')).toBeNull();
    expect(screen.getByTestId('add-person-error').textContent ?? '').toContain(
      'Something went wrong',
    );
  });

  it('a retry after a failed save does not add the person twice', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    renderDialog();
    submit('Second Friend');
    await act(async () => save.reject(new Error('disk full')));

    fireEvent.click(screen.getByRole('button', { name: 'Add & enter birth details' }));
    await act(async () => save.resolve());

    expect(profileNames()).toEqual(['Second Friend']);
    expect(screen.getByText('onboarding-page')).toBeTruthy();
  });
});
