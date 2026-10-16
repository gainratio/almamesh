import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ResolvedPlace } from '../../../../lib/geo/placeLookup';
import { PlaceCombobox } from '../PlaceCombobox';

function place(ref: number, city: string, region: string, timezone: string): ResolvedPlace {
  return { summary: { place_ref: `city:${ref}`, label: `${city}, ${region}`, timezone }, latitude: ref, longitude: -ref, region };
}

const SPRINGFIELDS = [
  place(2602, 'Springfield', 'Missouri, United States', 'America/Chicago'),
  place(2823, 'Springfield', 'Massachusetts, United States', 'America/New_York'),
  place(3823, 'Springfield', 'Illinois, United States', 'America/Chicago'),
];

function Harness({ onChoose, onDismiss }: { onChoose: (place: ResolvedPlace) => void; onDismiss: () => void }) {
  const [query, setQuery] = useState('Springfield');
  return (
    <PlaceCombobox id="where" testIdPrefix="where" label="Where?" placeholder="Search for a city" query={query} onQueryChange={setQuery}
      options={SPRINGFIELDS} onChoose={onChoose} onDismiss={onDismiss} />
  );
}

function renderBox() {
  const onChoose = vi.fn();
  const onDismiss = vi.fn();
  render(<Harness onChoose={onChoose} onDismiss={onDismiss} />);
  return { onChoose, onDismiss, input: screen.getByRole('combobox') };
}

describe('PlaceCombobox', () => {
  it('is a combobox that owns a listbox of options', () => {
    const { input } = renderBox();
    expect(input.getAttribute('aria-expanded')).toBe('true');
    const listbox = screen.getByRole('listbox');
    expect(input.getAttribute('aria-controls')).toBe(listbox.id);
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('shows the city plainly and "State, Country" muted on the same row, nothing else', () => {
    renderBox();
    const row = screen.getByTestId('where-option-2');
    expect(row.textContent).toBe('Springfield, Illinois, United States');
    expect(row.querySelector('[data-part="city"]')?.textContent).toBe('Springfield');
    expect(row.querySelector('[data-part="region"]')?.textContent).toBe(', Illinois, United States');
    expect(row.textContent).not.toContain('America/');
    expect(row.textContent).not.toMatch(/\d/);
  });

  it('moves with the arrow keys and picks with Enter', () => {
    const { input, onChoose } = renderBox();
    expect(input.getAttribute('aria-activedescendant')).toBe(screen.getByTestId('where-option-0').id);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByTestId('where-option-2').getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChoose).toHaveBeenCalledWith(SPRINGFIELDS[2]);
  });

  it('wraps from the top with ArrowUp', () => {
    const { input } = renderBox();
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.getByTestId('where-option-2').getAttribute('aria-selected')).toBe('true');
  });

  it('closes the list with Escape without picking, and keeps the Escape from closing the sheet', () => {
    const outer = vi.fn();
    const onDismiss = vi.fn();
    const onChoose = vi.fn();
    render(<div onKeyDown={outer}><Harness onChoose={onChoose} onDismiss={onDismiss} /></div>);
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onChoose).not.toHaveBeenCalled();
    expect(outer).not.toHaveBeenCalled();
  });

  it('picks with a click', () => {
    const { onChoose } = renderBox();
    fireEvent.click(screen.getByTestId('where-option-1'));
    expect(onChoose).toHaveBeenCalledWith(SPRINGFIELDS[1]);
  });

  it('shows at most six suggestions', () => {
    const many = Array.from({ length: 9 }, (_, i) => place(i + 1, `Town ${String.fromCharCode(65 + i)}`, 'Somewhere', 'UTC'));
    render(<PlaceCombobox id="w" testIdPrefix="w" label="Where?" placeholder="" query="Town" onQueryChange={vi.fn()} options={many}
      onChoose={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getAllByRole('option')).toHaveLength(6);
  });

  it('is collapsed with no list when there are no options', () => {
    render(<PlaceCombobox id="w" testIdPrefix="w" label="Where?" placeholder="" query="" onQueryChange={vi.fn()} options={null}
      onChoose={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByRole('combobox').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
