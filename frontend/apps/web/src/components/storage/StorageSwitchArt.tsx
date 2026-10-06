import type { SwitchArt } from './storageSteps';

interface StorageSwitchArtProps {
  readonly art: SwitchArt;
  /** The setting's name as the browser shows it, e.g. "Block all cookies". */
  readonly setting: string;
  /** Accessible description of the whole drawing. */
  readonly label: string;
}

/**
 * A drawn settings row showing the one switch the user has to change, in the
 * state it should end up in. Inline SVG, theme tokens only, no images.
 */
export function StorageSwitchArt({ art, setting, label }: StorageSwitchArtProps) {
  const on = art === 'toggle-on';
  return (
    <svg
      role="img"
      aria-label={label}
      data-switch={on ? 'on' : 'off'}
      viewBox="0 0 320 56"
      className="block h-auto w-full max-w-xs"
    >
      <rect
        x="0.5"
        y="0.5"
        width="319"
        height="55"
        rx="10"
        className="fill-background-tertiary stroke-ui-borderLight"
      />
      <text x="18" y="33" className="fill-text-primary font-sans" fontSize="15">
        {setting}
      </text>
      {art === 'checkbox-off' ? <Checkbox /> : <Toggle on={on} />}
    </svg>
  );
}

function Checkbox() {
  return (
    <rect
      x="284"
      y="18"
      width="20"
      height="20"
      rx="5"
      strokeWidth="1.5"
      className="fill-background-darkest stroke-text-muted"
    />
  );
}

interface ToggleProps {
  readonly on: boolean;
}

function Toggle({ on }: ToggleProps) {
  return (
    <g>
      <rect x="254" y="14" width="50" height="28" rx="14" className={on ? 'fill-accent-gold' : 'fill-ui-disabled'} />
      <circle cx={on ? 290 : 268} cy="28" r="11" className="fill-text-primary" />
    </g>
  );
}
