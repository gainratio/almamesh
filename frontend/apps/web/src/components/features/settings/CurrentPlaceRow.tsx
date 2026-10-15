/**
 * "Where do you live now?" — one optional row in Profile settings. The same
 * place box as time travel (the bundled on-device city list, "novato, ca"
 * narrows to Novato, California). Picking a place saves it to the active
 * person at once; Clear removes it. Unset means the app keeps using only the
 * device's zone. Nothing here leaves the device.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useProfilesStore } from '@almamesh/store';

import type { PlaceLookup } from '../../../lib/geo/placeLookup';
import { useCurrentPlace } from '../../../hooks/useCurrentPlace';
import { waitForStoreSaved } from '../../../lib/storeSaved';
import { PlaceCombobox } from '../chat/PlaceCombobox';
import { lookupPlaceLazily, toPinPlace, usePlaceOptions } from '../chat/PlacePicker';

type SaveStatus = 'idle' | 'saved' | 'failed';

interface CurrentPlaceRowProps {
  /** The offline city lookup; tests inject one. */
  readonly lookup?: (query: string) => Promise<PlaceLookup>;
}

export function CurrentPlaceRow({ lookup = lookupPlaceLazily }: CurrentPlaceRowProps) {
  const { t } = useTranslation('settings');
  const activeId = useProfilesStore((s) => s.activeProfileId);
  const setCurrentPlace = useProfilesStore((s) => s.setCurrentPlace);
  const place = useCurrentPlace();
  const [query, setQuery] = useState(place?.label ?? '');
  const [status, setStatus] = useState<SaveStatus>('idle');
  const { options, close } = usePlaceOptions(query, lookup, place?.label);

  // Another tab or an import can change the place under the row: show it.
  useEffect(() => setQuery(place?.label ?? ''), [place?.label]);

  if (!activeId) return null;

  // "Saved" only once the SQLite write has committed; a failed write puts the previous place back.
  const save = async (next: Parameters<typeof setCurrentPlace>[1]) => {
    const previous = place;
    setStatus('idle');
    setQuery(next?.label ?? '');
    close();
    if (!setCurrentPlace(activeId, next).ok) return;
    try {
      await waitForStoreSaved('people');
      setStatus(next === undefined ? 'idle' : 'saved');
    } catch {
      // waitForStoreSaved already logged a fixed code.
      setCurrentPlace(activeId, previous);
      setQuery(previous?.label ?? '');
      setStatus('failed');
    }
  };

  return (
    <div data-testid="current-place" className="max-w-xl border-t border-ui-border pt-6">
      <label htmlFor="current-place-input" className="block text-sm font-medium text-text-primary">
        {t('profile.current_place_label')}
      </label>
      <div className="flex items-start gap-3">
        {/* The browser's own search "×" only empties the text; Clear is the one way to remove the place. */}
        <div className="min-w-0 flex-1 [&_input::-webkit-search-cancel-button]:hidden">
          <PlaceCombobox
            id="current-place-input"
            testIdPrefix="current-place"
            label={t('profile.current_place_label')}
            placeholder={t('profile.current_place_placeholder')}
            describedBy="current-place-hint"
            query={query}
            onQueryChange={(text) => {
              setQuery(text);
              setStatus('idle');
            }}
            options={options}
            onChoose={(option) => void save(toPinPlace(option))}
            onDismiss={close}
          />
        </div>
        {place && (
          <button type="button" data-testid="current-place-clear" onClick={() => void save(undefined)}
            className="mt-1 shrink-0 rounded-lg px-3 py-2 text-sm text-text-muted hover:text-accent-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-gold/60">
            {t('profile.current_place_clear')}
          </button>
        )}
      </div>
      <p id="current-place-hint" data-testid="current-place-hint" className="mt-2 text-xs text-text-muted">
        {t('profile.current_place_hint')}
      </p>
      <p role="status" data-testid="current-place-status" className={`mt-1 text-xs ${status === 'failed' ? 'text-status-error' : 'text-text-muted'}`}>
        {status === 'idle' ? '' : t(status === 'saved' ? 'profile.current_place_saved' : 'profile.current_place_failed')}
      </p>
    </div>
  );
}
