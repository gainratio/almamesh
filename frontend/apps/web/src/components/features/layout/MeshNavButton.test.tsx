/**
 * MeshNavButton — the header's icon entry to /mesh.
 *
 * It replaced a plain "Mesh" text link. The visible text is gone, so these
 * tests pin what must survive: an accessible name, the same destination, and
 * activation from the keyboard (Enter like any link, plus Space so it behaves
 * like the button it looks like).
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import '../../../i18n/config';
import { MeshNavButton } from './MeshNavButton';

function renderInRouter() {
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <MeshNavButton />
      <Routes>
        <Route path="/dashboard" element={<p>dashboard page</p>} />
        <Route path="/mesh" element={<p>mesh page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('MeshNavButton', () => {
  it('is a link named "Open your Mesh" pointing at /mesh, with no visible text', () => {
    renderInRouter();
    const link = screen.getByRole('link', { name: 'Open your Mesh' });
    expect(link.getAttribute('href')).toBe('/mesh');
    expect(link.getAttribute('data-testid')).toBe('nav-mesh-link');
    // Icon only: the old "Mesh" word must not render as visible text.
    expect(link.textContent).toBe('');
    expect(link.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows a tooltip naming the action on hover', async () => {
    const user = userEvent.setup();
    renderInRouter();
    expect(screen.queryByRole('tooltip')).toBeNull();
    await user.hover(screen.getByRole('link', { name: 'Open your Mesh' }));
    expect(screen.getByRole('tooltip').textContent).toBe('Open your Mesh');
  });

  it('navigates to /mesh on Enter', async () => {
    const user = userEvent.setup();
    renderInRouter();
    expect(screen.getByText('dashboard page')).toBeTruthy();
    screen.getByRole('link', { name: 'Open your Mesh' }).focus();
    await user.keyboard('{Enter}');
    expect(screen.getByText('mesh page')).toBeTruthy();
  });

  it('navigates to /mesh on Space', async () => {
    const user = userEvent.setup();
    renderInRouter();
    screen.getByRole('link', { name: 'Open your Mesh' }).focus();
    await user.keyboard(' ');
    expect(screen.getByText('mesh page')).toBeTruthy();
  });

  it('navigates to /mesh on click', async () => {
    const user = userEvent.setup();
    renderInRouter();
    await user.click(screen.getByRole('link', { name: 'Open your Mesh' }));
    expect(screen.getByText('mesh page')).toBeTruthy();
  });
});
