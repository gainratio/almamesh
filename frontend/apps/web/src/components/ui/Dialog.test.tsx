/**
 * Dialog — where in the DOM the modal actually lands.
 *
 * A `position: fixed` element resolves against the VIEWPORT only while no
 * ancestor establishes a containing block for it. Any ancestor with a
 * non-`none` `backdrop-filter` (or `filter` / `transform` / `perspective`)
 * does establish one — and the app shell's sticky header is exactly that
 * (`sticky top-0 … backdrop-blur-xs`, inner bar `h-14` = 56px).
 *
 * The header renders `ProfileSwitcher`, which renders a `Dialog`. Without a
 * portal, `fixed inset-0` resolved against the header's 56px box and the
 * dialog was clipped above the fold — first row and Save button unreachable.
 *
 * The fix is structural, not positional: the dialog root belongs to
 * `document.body`, so NO ancestor's compositing can capture it. These tests
 * pin that relationship, not any coordinate.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useLanguageStore } from '@almamesh/store';

import '../../i18n/config';
import { Dialog } from './Dialog';

/**
 * A stand-in for the app shell's blurred sticky header: an ancestor that
 * establishes a containing block for `position: fixed` descendants.
 */
function BlurredAncestor({ children }: { children: React.ReactNode }) {
  return (
    <div data-testid="blurred-ancestor" style={{ backdropFilter: 'blur(4px)' }}>
      {children}
    </div>
  );
}

describe('Dialog — escapes its ancestors via a portal', () => {
  beforeEach(() => {
    useLanguageStore.setState({ language: 'en' });
  });

  it('mounts the dialog under <body>, not inside the blurred ancestor that declared it', () => {
    const { container } = render(
      <BlurredAncestor>
        <Dialog open onClose={() => undefined} title="Who's viewing?">
          <p>body copy</p>
        </Dialog>
      </BlurredAncestor>,
    );

    const dialog = screen.getByRole('dialog');
    const ancestor = screen.getByTestId('blurred-ancestor');

    // The property: no declaring ancestor may contain the dialog.
    expect(ancestor.contains(dialog)).toBe(false);
    expect(container.contains(dialog)).toBe(false);
    // …and it is still in the document, under <body>.
    expect(document.body.contains(dialog)).toBe(true);
  });

  it('still closes on Escape through the portal', () => {
    const onClose = vi.fn();
    render(
      <BlurredAncestor>
        <Dialog open onClose={onClose} title="Who's viewing?">
          <p>body copy</p>
        </Dialog>
      </BlurredAncestor>,
    );

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('unmounts cleanly when closed — no orphaned node left on <body>', async () => {
    const { rerender } = render(
      <BlurredAncestor>
        <Dialog open onClose={() => undefined} title="Who's viewing?">
          <p>body copy</p>
        </Dialog>
      </BlurredAncestor>,
    );
    expect(screen.getByRole('dialog')).toBeTruthy();

    rerender(
      <BlurredAncestor>
        <Dialog open={false} onClose={() => undefined} title="Who's viewing?">
          <p>body copy</p>
        </Dialog>
      </BlurredAncestor>,
    );

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });
});
