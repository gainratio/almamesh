/**
 * "Where?" for every trip (Day, Month, Year). Offline only (step C Ruling 16): the
 * bundled city list, loaded lazily the first time someone types, never the online
 * geocoder. The sheet may hand it a prefilled place (nearest pin, else the birth
 * place); never the device location or zone.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { safeWarn, type ChatThreadAsOf } from '@almamesh/shared-types';

import type { PlaceLookup, ResolvedPlace } from '../../../lib/geo/placeLookup';

type PinPlace = NonNullable<ChatThreadAsOf['place']>;

export async function lookupPlaceLazily(query: string): Promise<PlaceLookup> {
  return (await import('../../../lib/geo/placeLookup')).lookupPlaceOffline(query);
}

function candidatesOf(result: PlaceLookup): readonly ResolvedPlace[] {
  if (result.status === 'found') return [result.place];
  return result.status === 'ambiguous' ? result.candidates : [];
}

function toPinPlace(place: ResolvedPlace): PinPlace {
  return { label: place.summary.label, timezone: place.summary.timezone, latitude: place.latitude, longitude: place.longitude };
}

interface PlacePickerProps {
  readonly place: PinPlace | undefined;
  readonly lookup: (query: string) => Promise<PlaceLookup>;
  readonly onPick: (place: PinPlace | undefined) => void;
  /** The place came from the nearest pin or the birth place, not from the user. */
  readonly prefilled?: boolean;
  /** Month/Year say "at that time"; Day says "that day". */
  readonly forDay?: boolean;
}

const DEBOUNCE_MS = 200;

export function PlacePicker({ place, lookup, onPick, prefilled = false, forDay = true }: PlacePickerProps) {
  const { t } = useTranslation('chat');
  const [query, setQuery] = useState(place?.label ?? '');
  const [options, setOptions] = useState<readonly ResolvedPlace[] | null>(null);
  const [lookupFailed, setLookupFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const placeLabel = place?.label;

  // A prefilled place can change under the picker (the user moved the date): show it.
  useEffect(() => {
    if (placeLabel !== undefined) setQuery(placeLabel);
  }, [placeLabel]);

  useEffect(() => {
    const text = query.trim();
    setLookupFailed(false);
    setOptions(null);
    if (text.length < 2) {
      setOptions(null);
      return;
    }
    if (text === place?.label) return;
    let cancelled = false;
    const handle = setTimeout(() => {
      void lookup(text)
        .then((result) => {
          if (!cancelled) setOptions(candidatesOf(result));
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            safeWarn('geo.city_lookup_failed', error);
            setLookupFailed(true);
          }
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, lookup, place?.label, retry]);

  return (
    <div data-testid="time-travel-where" className="mt-3">
      <label className="text-sm font-medium text-text-primary" htmlFor="time-travel-where-input">{t('time_travel.sheet.where')}</label>
      <p id="time-travel-where-hint" className="text-xs text-text-muted">{t('time_travel.sheet.where_hint')}</p>
      <input
        id="time-travel-where-input"
        data-testid="time-travel-where-input"
        type="search"
        autoComplete="off"
        aria-describedby="time-travel-where-hint"
        aria-required="true"
        value={query}
        placeholder={t('time_travel.sheet.where_placeholder')}
        onChange={(event) => {
          setQuery(event.target.value);
          onPick(undefined);
        }}
        className="mt-1 w-full rounded-lg border border-ui-border bg-background-primary px-3 py-2 text-sm text-text-primary"
      />
      {!place && <p data-testid="time-travel-where-required" className="mt-1 text-xs text-text-muted">{t(forDay ? 'time_travel.sheet.where_required' : 'time_travel.sheet.where_required_period')}</p>}
      {place && prefilled && <p data-testid="time-travel-where-prefilled" className="mt-1 text-xs text-text-muted">{t('time_travel.sheet.where_prefilled')}</p>}
      {lookupFailed && <div data-testid="time-travel-where-failed" role="alert" className="mt-1 text-xs text-text-muted">
        <p>{t('time_travel.sheet.where_failed')}</p>
        <button type="button" data-testid="time-travel-where-retry" onClick={() => setRetry((value) => value + 1)} className="mt-1 underline">
          {t('time_travel.sheet.retry_lookup')}
        </button>
      </div>}
      {options?.length === 0 && <p data-testid="time-travel-where-none" className="mt-1 text-xs text-text-muted">{t('time_travel.sheet.where_none')}</p>}
      {!place && options && options.length > 0 && (
        <ul className="mt-1 flex flex-col gap-1">
          {options.map((option, index) => (
            <li key={option.summary.place_ref}>
              <button
                type="button"
                data-testid={`time-travel-where-option-${index}`}
                onClick={() => {
                  onPick(toPinPlace(option));
                  setQuery(option.summary.label);
                  setOptions(null);
                }}
                className="w-full rounded-lg border border-ui-border px-3 py-2 text-left text-sm hover:border-accent-gold"
              >
                {option.summary.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
