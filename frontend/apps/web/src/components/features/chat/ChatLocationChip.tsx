/**
 * Compact location chip + inline popover for the Chat Context Bar.
 *
 * Shows the active profile's saved current city (`📍 Novato, California`) or
 * `📍 Set location` when unset. Clicking opens an inline popover with
 * `PlaceCombobox` + Clear button, restoring focus to the trigger button
 * whenever closed from inside (`declarative-dialog-popover-control`).
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getCurrentPlace, useProfilesStore } from '@almamesh/store';

import type { PlaceLookup } from '../../../lib/geo/placeLookup';
import { waitForStoreSaved } from '../../../lib/storeSaved';
import { PlaceCombobox } from './PlaceCombobox';
import { lookupPlaceLazily, toPinPlace, usePlaceOptions } from './PlacePicker';

interface ChatLocationChipProps {
  readonly profileId: string | null;
  readonly lookup?: (query: string) => Promise<PlaceLookup>;
}

/** Shorten "Novato, California, United States" to "Novato, California" on narrow bars. */
function shortPlaceLabel(label: string): string {
  const parts = label.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length > 2 ? `${parts[0]}, ${parts[1]}` : label;
}

export function ChatLocationChip({ profileId, lookup = lookupPlaceLazily }: ChatLocationChipProps) {
  const { t } = useTranslation('chat');
  const activeProfileId = useProfilesStore((s) => s.activeProfileId);
  const targetId = profileId && useProfilesStore.getState().profiles[profileId] ? profileId : activeProfileId;
  const place = useProfilesStore((s) => (targetId ? getCurrentPlace(s.profiles[targetId]) : undefined));
  const setCurrentPlace = useProfilesStore((s) => s.setCurrentPlace);

  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState(place?.label ?? '');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { options, close: closeOptions } = usePlaceOptions(query, lookup, place?.label);

  useEffect(() => {
    setQuery(place?.label ?? '');
  }, [place?.label]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const closeAndRestoreFocus = () => {
    closeOptions();
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const persistPlace = async (next: Parameters<typeof setCurrentPlace>[1]) => {
    if (!targetId) return;
    const prev = place;
    setQuery(next?.label ?? '');
    closeAndRestoreFocus();
    setSaving(true);
    if (!setCurrentPlace(targetId, next).ok) { setSaving(false); return; }
    try {
      await waitForStoreSaved('people');
    } catch {
      setCurrentPlace(targetId, prev);
      setQuery(prev?.label ?? '');
    } finally {
      setSaving(false);
    }
  };

  const canEdit = Boolean(targetId);
  const label = place ? shortPlaceLabel(place.label) : t('context.set_location');

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        disabled={!canEdit}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={place ? place.label : t('context.location_unset_hint')}
        data-testid="chat-location-chip"
        data-saving={saving ? 'true' : 'false'}
        onClick={() => setOpen((prev) => !prev)}
        className={`inline-flex min-h-7 items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-gold/60 disabled:opacity-60 ${
          place
            ? 'border-accent-gold/40 bg-accent-gold/10 text-text-primary hover:border-accent-gold'
            : 'border-ui-border bg-background-tertiary text-text-secondary hover:border-accent-gold/60 hover:text-text-primary'
        }`}
      >
        <span aria-hidden="true">📍</span>
        <span className="max-w-[120px] truncate sm:max-w-[148px]">{label}</span>
      </button>

      {open && canEdit && (
        <div
          role="dialog"
          aria-label={t('context.location_popover_title')}
          data-testid="chat-location-popover"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              closeAndRestoreFocus();
            }
          }}
          className="absolute left-0 top-full z-30 mt-1.5 w-72 max-w-[calc(100dvw-2rem)] rounded-xl border border-ui-border bg-background-secondary p-3 shadow-xl"
        >
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-text-primary">{t('context.location_popover_title')}</span>
            <button
              type="button"
              onClick={closeAndRestoreFocus}
              data-testid="chat-location-close"
              className="min-h-6 min-w-6 rounded px-1.5 text-xs text-text-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-gold/60"
            >
              {t('context.close')}
            </button>
          </div>
          <p id="chat-location-hint" className="mb-1 text-[11px] text-text-muted">
            {t('context.location_privacy_hint')}
          </p>
          <div className="[&_input::-webkit-search-cancel-button]:hidden">
            <PlaceCombobox
              id="chat-context-place-input"
              testIdPrefix="chat-context-place"
              label={t('context.location_popover_title')}
              placeholder={t('time_travel.sheet.where_placeholder')}
              describedBy="chat-location-hint"
              autoFocus
              query={query}
              onQueryChange={setQuery}
              options={options}
              onChoose={(picked) => void persistPlace(toPinPlace(picked))}
              onSubmitQuery={(text) => {
                void lookup(text).then((res) => {
                  const first = res.status === 'found' ? res.place : res.status === 'ambiguous' ? res.candidates[0] : undefined;
                  if (first) void persistPlace(toPinPlace(first));
                });
              }}
              onDismiss={closeOptions}
            />
          </div>
          {place && (
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                data-testid="chat-location-clear"
                onClick={() => void persistPlace(undefined)}
                className="min-h-6 rounded px-2 py-0.5 text-xs text-text-muted underline hover:text-accent-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-gold/60"
              >
                {t('context.clear_location')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
