import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import '../../../../i18n/config';
import type { PlaceLookup, ResolvedPlace } from '../../../../lib/geo/placeLookup';
import { askToPickPlace, pendingPlacePick } from '../../../../lib/placePick';
import { PlacePickDialog } from '../PlacePickDialog';

function place(ref: number, state: string, timezone: string): ResolvedPlace {
  return {
    summary: { place_ref: `city:${ref}`, label: `Springfield, ${state}, United States`, timezone },
    latitude: ref, longitude: -ref, region: `${state}, United States`,
  };
}
const MISSOURI = place(2602, 'Missouri', 'America/Chicago');
const MASSACHUSETTS = place(2823, 'Massachusetts', 'America/New_York');
const ILLINOIS = place(3823, 'Illinois', 'America/Chicago');

function renderDialog(lookup = vi.fn(async (): Promise<PlaceLookup> => ({ status: 'not_found' }))) {
  render(<PlacePickDialog lookup={lookup} />);
  let answer!: Promise<unknown>;
  act(() => { answer = askToPickPlace('Springfield', [MISSOURI, MASSACHUSETTS, ILLINOIS], new AbortController().signal); });
  return { answer, lookup };
}

describe('PlacePickDialog', () => {
  it('shows nothing until the chat asks', () => {
    render(<PlacePickDialog />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks "Which Springfield?" with the candidates, the box focused, and one Cancel', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByRole('heading').textContent).toBe('Which Springfield?');
    expect(document.activeElement).toBe(screen.getByRole('combobox'));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Springfield, Missouri, United States', 'Springfield, Massachusetts, United States', 'Springfield, Illinois, United States',
    ]);
    expect(dialog.querySelectorAll('button')).toHaveLength(1);
  });

  it('the picked place is the answer, with its zone', async () => {
    const { answer } = renderDialog();
    const box = screen.getByRole('combobox');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await answer).toBe(ILLINOIS);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Cancel answers with no place', async () => {
    const { answer } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await answer).toBeUndefined();
    expect(pendingPlacePick()).toBeUndefined();
  });

  it('Escape answers with no place', async () => {
    const { answer } = renderDialog();
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(await answer).toBeUndefined();
  });

  it('typing searches the bundled list again, qualifier and all', async () => {
    const lookup = vi.fn(async (): Promise<PlaceLookup> => ({ status: 'ambiguous', candidates: [ILLINOIS] }));
    const { answer } = renderDialog(lookup);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Springfield, IL' } });
    await waitFor(() => expect(lookup).toHaveBeenCalledWith('Springfield, IL'));
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
    fireEvent.click(screen.getByTestId('place-pick-option-0'));
    expect(await answer).toBe(ILLINOIS);
  });

  it('closing it by unmounting answers with no place', async () => {
    const view = render(<PlacePickDialog />);
    let answer!: Promise<unknown>;
    act(() => { answer = askToPickPlace('Springfield', [ILLINOIS], new AbortController().signal); });
    view.unmount();
    expect(await answer).toBeUndefined();
  });
});
