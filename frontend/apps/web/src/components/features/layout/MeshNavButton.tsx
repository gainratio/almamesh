import type { KeyboardEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '../../ui/Tooltip';

const MESH_PATH = '/mesh';

/**
 * MeshGlyph — a small woven network: six charts on an uneven rim, each tied
 * to the others and to a brass node at the heart ("you"). Drawn in
 * `currentColor` so the parent's hover/focus colour carries through. The
 * weave swells slightly on hover/focus and stays still under
 * prefers-reduced-motion.
 */
function MeshGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-7 w-7"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <g className="origin-center transition-transform duration-300 ease-out [transform-box:view-box] group-hover:scale-110 group-focus-visible:scale-110 motion-reduce:transition-none motion-reduce:group-hover:scale-100 motion-reduce:group-focus-visible:scale-100">
        <polygon points="5,6.5 13,3.5 20,8 18.5,17 10.5,20.5 4,15" strokeWidth="1.1" opacity="0.6" />
        <g strokeWidth="1" opacity="0.85">
          <line x1="12" y1="11.5" x2="5" y2="6.5" />
          <line x1="12" y1="11.5" x2="13" y2="3.5" />
          <line x1="12" y1="11.5" x2="20" y2="8" />
          <line x1="12" y1="11.5" x2="18.5" y2="17" />
          <line x1="12" y1="11.5" x2="10.5" y2="20.5" />
          <line x1="12" y1="11.5" x2="4" y2="15" />
        </g>
        <g fill="currentColor" stroke="none">
          <circle cx="5" cy="6.5" r="1.6" />
          <circle cx="13" cy="3.5" r="1.6" />
          <circle cx="20" cy="8" r="1.6" />
          <circle cx="18.5" cy="17" r="1.6" />
          <circle cx="10.5" cy="20.5" r="1.6" />
          <circle cx="4" cy="15" r="1.6" />
        </g>
        <circle cx="12" cy="11.5" r="2.2" className="fill-accent-gold" stroke="none" />
      </g>
    </svg>
  );
}

/**
 * MeshNavButton — the header's entry to /mesh, drawn as a mesh glyph in a
 * round brass-edged control instead of the word "Mesh". It stays a link (it
 * navigates), keeps an accessible name, and also answers Space so it behaves
 * like the button it looks like.
 */
export function MeshNavButton() {
  const { t } = useTranslation('common');
  const navigate = useNavigate();
  const label = t('nav.mesh_open');

  const onKeyDown = (event: KeyboardEvent<HTMLAnchorElement>) => {
    if (event.key !== ' ') return;
    event.preventDefault();
    navigate(MESH_PATH);
  };

  return (
    <Tooltip content={label} side="bottom" className="whitespace-nowrap">
      <Link
        to={MESH_PATH}
        aria-label={label}
        data-testid="nav-mesh-link"
        onKeyDown={onKeyDown}
        className="group inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full border border-ui-border bg-background-elevated/60 text-text-secondary transition-[color,border-color,background-color,transform] duration-200 hover:border-accent-gold/60 hover:bg-accent-gold/10 hover:text-accent-gold-bright focus-visible:border-accent-gold/60 focus-visible:text-accent-gold-bright focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-gold/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background-primary active:scale-95 motion-reduce:transition-none motion-reduce:active:scale-100"
      >
        <MeshGlyph />
      </Link>
    </Tooltip>
  );
}
