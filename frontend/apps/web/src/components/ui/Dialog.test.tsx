/**
 * Dialog — where in the DOM the modal actually lands.
 *
 * A `position: fixed` element resolves against the VIEWPORT only while no
 * ancestor establishes a containing block for it. Any ancestor with a
 * non-`none` `backdrop-filter` (or `filter` / `transform` / `perspective`)
 * does establish one — and the app shell's sticky header is exactly that
 * (`sticky top-0 … backdrop-blur-sm`, inner bar `h-14` = 56px).
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

describe('Dialog — keyboard focus', () => {
  beforeEach(() => {
    useLanguageStore.setState({ language: 'en' });
  });

  it('moves focus into the dialog on open and gives it back to the opener on close', async () => {
    function Harness({ open }: { open: boolean }) {
      return (
        <>
          <button type="button" data-testid="opener">open</button>
          <Dialog open={open} onClose={() => undefined} title="Connect AI">
            <p>body copy</p>
          </Dialog>
        </>
      );
    }
    const { rerender } = render(<Harness open={false} />);
    const opener = screen.getByTestId('opener');
    opener.focus();

    rerender(<Harness open />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);

    rerender(<Harness open={false} />);
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('leaves focus alone when a child already took it (an autofocused field)', () => {
    render(
      <Dialog open onClose={() => undefined} title="Search">
        <input data-testid="field" autoFocus />
      </Dialog>,
    );
    expect(document.activeElement).toBe(screen.getByTestId('field'));
  });
});

describe('Dialog — visible close button', () => {
  beforeEach(() => {
    useLanguageStore.setState({ language: 'en' });
  });

  it('shows one labelled, touch-sized close button inside the panel that closes it', () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Connect AI">
        <p>body copy</p>
      </Dialog>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Connect AI' });
    // Exactly one accessible "Close dialog" control: the overlay is a pointer
    // convenience, not a second button for screen readers.
    const closes = screen.getAllByRole('button', { name: 'Close dialog' });
    expect(closes).toHaveLength(1);
    const close = closes[0];
    expect(dialog.contains(close)).toBe(true);
    // 44px target (Tailwind h-11 / w-11).
    expect(close.className).toContain('h-11');
    expect(close.className).toContain('w-11');

    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the close button when the dialog has no title', () => {
    render(
      <Dialog open onClose={() => undefined}>
        <p>body copy</p>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(screen.getByRole('button', { name: 'Close dialog' }))).toBe(true);
  });
});
