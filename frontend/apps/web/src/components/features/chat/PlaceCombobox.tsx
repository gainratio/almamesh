/**
 * The one place box: a text input that owns a short list of places. Each row
 * reads "Springfield" plainly and ", Illinois, United States" muted, so the
 * whole row is the label the model and the trip header use. Keyboard first:
 * arrows move, Enter picks, Escape closes the list (and only the list).
 * Used by the time-travel "Where?" box and the chat's "Which place?" popup.
 */
import { useEffect, useState, type KeyboardEvent } from 'react';

import { PLACE_SUGGESTION_LIMIT } from '../../../lib/geo/cityMatch';
import type { ResolvedPlace } from '../../../lib/geo/placeLookup';

interface PlaceComboboxProps {
  readonly id: string;
  /** `${prefix}-input` and `${prefix}-option-${n}` for tests. */
  readonly testIdPrefix: string;
  readonly label: string;
  readonly placeholder: string;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  /** null: the list is closed. */
  readonly options: readonly ResolvedPlace[] | null;
  readonly onChoose: (place: ResolvedPlace) => void;
  /** Escape while the list is open. */
  readonly onDismiss: () => void;
  readonly describedBy?: string;
  readonly autoFocus?: boolean;
  readonly required?: boolean;
}

/** "Springfield" from "Springfield, Illinois, United States" and its region. */
export function placeCity(place: ResolvedPlace): string {
  const { label } = place.summary;
  const suffix = place.region ? `, ${place.region}` : '';
  return suffix && label.endsWith(suffix) ? label.slice(0, -suffix.length) : label;
}

function nextIndex(key: string, active: number, count: number): number | undefined {
  if (key === 'ArrowDown') return (active + 1) % count;
  if (key === 'ArrowUp') return (active - 1 + count) % count;
  return undefined;
}

export function PlaceCombobox(props: PlaceComboboxProps) {
  const { id, testIdPrefix, options, onChoose, onDismiss } = props;
  const shown = options?.slice(0, PLACE_SUGGESTION_LIMIT) ?? [];
  const open = shown.length > 0;
  const [active, setActive] = useState(0);
  const listId = `${id}-listbox`;
  const optionId = (index: number) => `${id}-option-${index}`;

  // A new list starts on its first (most populous) row.
  useEffect(() => setActive(0), [options]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!open) return;
    const moved = nextIndex(event.key, active, shown.length);
    if (moved !== undefined) {
      event.preventDefault();
      setActive(moved);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      onChoose(shown[active] ?? shown[0]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onDismiss();
    }
  };

  return (
    <>
      <input
        id={id}
        data-testid={`${testIdPrefix}-input`}
        type="search"
        role="combobox"
        autoComplete="off"
        aria-label={props.label}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? optionId(active) : undefined}
        aria-describedby={props.describedBy}
        aria-required={props.required}
        autoFocus={props.autoFocus}
        value={props.query}
        placeholder={props.placeholder}
        onChange={(event) => props.onQueryChange(event.target.value)}
        onKeyDown={onKeyDown}
        className="mt-1 w-full rounded-lg border border-ui-border bg-background-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus-visible:border-accent-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-gold/60"
      />
      {open && (
        <ul id={listId} role="listbox" aria-label={props.label}
          className="mt-1 overflow-hidden rounded-lg border border-ui-border bg-background-primary py-1">
          {shown.map((option, index) => (
            <li
              key={option.summary.place_ref}
              id={optionId(index)}
              role="option"
              aria-selected={index === active}
              data-testid={`${testIdPrefix}-option-${index}`}
              // Keep focus in the input so the arrows keep working after a hover.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => onChoose(option)}
              className={`cursor-pointer truncate border-l-2 px-3 py-2 text-sm ${index === active ? 'border-accent-gold bg-background-tertiary' : 'border-transparent'}`}
            >
              <span data-part="city" className="text-text-primary">{placeCity(option)}</span>
              {option.region && <span data-part="region" className="text-text-muted-alt">, {option.region}</span>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
