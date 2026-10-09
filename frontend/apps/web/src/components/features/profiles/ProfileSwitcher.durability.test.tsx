/**
 * The header ProfileSwitcher's "Add" has the same contract as AddPersonDialog:
 * it must not move on to /onboarding until the new person is on disk, or a
 * full page load in that window loses them.
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
vi.mock('../../../lib/profilesSaved', () => ({
  waitForProfilesSaved: () => {
    save.calls += 1;
    return new Promise<void>((resolve, reject) => {
      save.resolve = resolve;
      save.reject = reject;
    });
  },
}));

import '../../../i18n/config';
import { ProfileSwitcher } from './ProfileSwitcher';

function renderSwitcher(): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={['/people']}>
        <Routes>
          <Route path="/people" element={<ProfileSwitcher />} />
          <Route path="/onboarding" element={<p>onboarding-page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function addPerson(name: string): void {
  fireEvent.click(screen.getByRole('button', { name: 'Add a person' }));
  fireEvent.change(screen.getByLabelText('New person name'), { target: { value: name } });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
}

beforeEach(() => {
  save.calls = 0;
  useLanguageStore.setState({ language: 'en' });
  useProfilesStore.setState({ profiles: {}, activeProfileId: null, hydrated: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ProfileSwitcher — a new person is saved before it moves on', () => {
  it('waits for the profiles write to commit before navigating', async () => {
    renderSwitcher();
    addPerson('Ravi');

    expect(save.calls).toBe(1);
    expect(screen.queryByText('onboarding-page')).toBeNull();

    await act(async () => save.resolve());
    expect(screen.getByText('onboarding-page')).toBeTruthy();
  });

  it('stays put with a notice when the write fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    renderSwitcher();
    addPerson('Ravi');

    await act(async () => save.reject(new Error('disk full')));

    expect(screen.queryByText('onboarding-page')).toBeNull();
    expect(screen.getByRole('alert').textContent ?? '').toContain("Couldn't save");
  });
});
