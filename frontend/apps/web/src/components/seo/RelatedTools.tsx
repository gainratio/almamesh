import { Link } from 'react-router-dom';
import type { ReactElement } from 'react';

const TOOLS = [
  { to: '/free-kundli', label: 'Free Kundli' },
  { to: '/birth-chart', label: 'Birth Chart' },
  { to: '/nakshatra', label: 'Nakshatra' },
  { to: '/dasha', label: 'Dasha' },
  { to: '/kundli-matching', label: 'Kundli Matching' },
  { to: '/muhurta', label: 'Muhurta' },
] as const;

export function RelatedTools(): ReactElement {
  return (
    <nav className="mt-10 border-t border-ui-border/60 pt-6" aria-label="Related astrology calculators">
      <h2 className="text-lg font-semibold">Related calculators</h2>
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-text-secondary">
        {TOOLS.map((tool) => (
          <li key={tool.to}>
            <Link className="underline decoration-ui-border underline-offset-4 hover:text-accent-gold-bright" to={tool.to}>
              {tool.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
