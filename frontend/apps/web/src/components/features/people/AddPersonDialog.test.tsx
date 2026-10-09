/**
 * AddPersonDialog — the shared "add a person" surface.
 *
 * Regression: typed name/relationship must NOT survive a Cancel. Reopening the
 * dialog after cancelling used to show the stale input; the form must reset on
 * every close (Cancel button, Escape, overlay) so reopening starts blank. The
 * submit flow (which already resets before navigating) is unchanged.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLanguageStore, useProfilesStore } from '@almamesh/store';

import '../../../i18n/config';
import { AddPersonDialog } from './AddPersonDialog';

/**
 * A tiny harness that owns the `open` prop, exactly like the real callers
 * (Settings → People, /mesh). It lets a test open → type → cancel → reopen and
 * observe what the reopened dialog shows.
 */
function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <button type="button" onClick={() => setOpen(true)}>
          open-dialog
        </button>
        <AddPersonDialog open={open} onClose={() => setOpen(false)} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function openDialog(): void {
  fireEvent.click(screen.getByRole('button', { name: 'open-dialog' }));
}

function nameField(): HTMLInputElement {
  return screen.getByLabelText('Name') as HTMLInputElement;
}

function relationshipField(): HTMLSelectElement {
  return screen.getByLabelText('Relationship to you') as HTMLSelectElement;
}

describe('AddPersonDialog — form reset on close', () => {
  beforeEach(() => {
    useLanguageStore.setState({ language: 'en' });
    useProfilesStore.setState({ profiles: {}, activeProfileId: null, hydrated: true });
  });

  it('clears the typed name and relationship after Cancel, so reopening is blank', () => {
    render(<Harness />);

    openDialog();
    fireEvent.change(nameField(), { target: { value: 'Ravi' } });
    fireEvent.change(relationshipField(), { target: { value: 'mother' } });
    expect(nameField().value).toBe('Ravi');
    expect(relationshipField().value).toBe('mother');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    openDialog();

    expect(nameField().value).toBe('');
    expect(relationshipField().value).toBe('');
  });

  it('clears the form when closed via Escape, too', () => {
    render(<Harness />);

    openDialog();
    fireEvent.change(nameField(), { target: { value: 'Meera' } });

    fireEvent.keyDown(document, { key: 'Escape' });
    openDialog();

    expect(nameField().value).toBe('');
  });
});

describe('AddPersonDialog — submit failure surfaces an inline error', () => {
  beforeEach(() => {
    useLanguageStore.setState({ language: 'en' });
    useProfilesStore.setState({ profiles: {}, activeProfileId: null, hydrated: true });
  });

  it('keeps the dialog open with a friendly notice when the store throws (no unhandled crash)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // A store failure (e.g. persistence quota) must not silently close the
    // dialog or escape the click handler as an uncaught exception.
    useProfilesStore.setState({
      createProfile: () => {
        throw new Error('persistence quota exceeded');
      },
    });
    render(<Harness />);

    openDialog();
    fireEvent.change(nameField(), { target: { value: 'Ravi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add & enter birth details' }));

    // Still open, with the typed name intact and a friendly inline error —
    // never the raw failure text.
    expect(nameField().value).toBe('Ravi');
    const notice = await screen.findByTestId('add-person-error');
    expect(notice.textContent ?? '').toContain('Something went wrong');
    expect(notice.textContent ?? '').not.toContain('quota');
  });

  it('a failure notice does not linger into the next open', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    useProfilesStore.setState({
      createProfile: () => {
        throw new Error('persistence quota exceeded');
      },
    });
    render(<Harness />);

    openDialog();
    fireEvent.change(nameField(), { target: { value: 'Ravi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add & enter birth details' }));
    expect(await screen.findByTestId('add-person-error')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    openDialog();
    expect(screen.queryByTestId('add-person-error')).toBeNull();
  });
});
