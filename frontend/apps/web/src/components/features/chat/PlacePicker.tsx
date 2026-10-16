/**
 * "Where?" for every trip (Day, Month, Year). Offline only (step C Ruling 16): the
 * bundled city list, loaded lazily the first time someone types, never the online
 * geocoder. The sheet may hand it a prefilled place (nearest pin, else the birth
 * place); never the device location or zone. Suggestions read "City, State,
 * Country" and a trailing qualifier ("novato, ca") narrows them.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { safeWarn, type ChatThreadAsOf } from '@almamesh/shared-types';

import type { PlaceLookup, ResolvedPlace } from '../../../lib/geo/placeLookup';
import { PlaceCombobox } from './PlaceCombobox';

type PinPlace = NonNullable<ChatThreadAsOf['place']>;

/** Every match for a place box, so a dominant Paris never hides Paris, Texas. */
export async function lookupPlaceLazily(query: string): Promise<PlaceLookup> {
  const candidates = await (await import('../../../lib/geo/placeLookup')).listPlacesOffline(query);
  return candidates.length > 0 ? { status: 'ambiguous', candidates } : { status: 'not_found' };
}

function candidatesOf(result: PlaceLookup): readonly ResolvedPlace[] {
  if (result.status === 'found') return [result.place];
  return result.status === 'ambiguous' ? result.candidates : [];
}

export function toPinPlace(place: ResolvedPlace): PinPlace {
  return { label: place.summary.label, timezone: place.summary.timezone, latitude: place.latitude, longitude: place.longitude };
}

const DEBOUNCE_MS = 200;

interface PlaceOptions {
  readonly options: readonly ResolvedPlace[] | null;
  readonly failed: boolean;
  readonly retry: () => void;
  readonly close: () => void;
}

/** Debounced suggestions for `query`; `settled` (the text of a picked place) asks for none. */
export function usePlaceOptions(query: string, lookup: (query: string) => Promise<PlaceLookup>, settled?: string): PlaceOptions {
  const [options, setOptions] = useState<readonly ResolvedPlace[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const text = query.trim();
    setFailed(false);
    setOptions(null);
    if (text.length < 2 || text === settled) return;
    let cancelled = false;
    const handle = setTimeout(() => {
      void lookup(text)
        .then((result) => {
          if (!cancelled) setOptions(candidatesOf(result));
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            safeWarn('geo.city_lookup_failed', error);
            setFailed(true);
          }
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, lookup, settled, attempt]);

  return { options, failed, retry: () => setAttempt((value) => value + 1), close: () => setOptions(null) };
}

interface PlacePickerProps {
  readonly place: PinPlace | undefined;
  readonly lookup: (query: string) => Promise<PlaceLookup>;
  readonly onPick: (place: PinPlace | undefined) => void;
  /** The place came from the nearest earlier trip, not from the user. */
  readonly prefilled?: boolean;
  /** Month/Year say "at that time"; Day says "that day". */
  readonly forDay?: boolean;
  /** The birth place, offered (never assumed) when there is no earlier trip to prefill from. */
  readonly suggestion?: PinPlace;
  /** Where the person lives now (Settings), offered the same way, beside the birth place. */
  readonly home?: PinPlace;
}

interface SuggestionProps {
  readonly testId: string;
  readonly text: string;
  readonly onUse: () => void;
}

function Suggestion({ testId, text, onUse }: SuggestionProps) {
  return (
    <button type="button" data-testid={testId} onClick={onUse}
      className="mt-1 rounded-full border border-accent-gold/60 px-3 py-1 text-xs text-accent-gold hover:bg-accent-gold/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-gold/60">
      {text}
    </button>
  );
}

export function PlacePicker({ place, lookup, onPick, prefilled = false, forDay = true, suggestion, home }: PlacePickerProps) {
  const { t } = useTranslation('chat');
  const [query, setQuery] = useState(place?.label ?? '');
  const placeLabel = place?.label;
  const { options, failed, retry, close } = usePlaceOptions(query, lookup, placeLabel);
  // While suggestions are showing, they are the only thing under the box.
  const asking = !place && !(options && options.length > 0);
  // Home and birth place are the same city: offer it once.
  const birth = suggestion && suggestion.label !== home?.label ? suggestion : undefined;
  const use = (picked: PinPlace) => () => { onPick(picked); setQuery(picked.label); close(); };

  // A prefilled place can change under the picker (the user moved the date): show it.
  useEffect(() => {
    if (placeLabel !== undefined) setQuery(placeLabel);
  }, [placeLabel]);

  return (
    <div data-testid="time-travel-where" className="mt-3">
      <label className="text-sm font-medium text-text-primary" htmlFor="time-travel-where-input">{t('time_travel.sheet.where')}</label>
      <p id="time-travel-where-hint" className="text-xs text-text-muted">{t('time_travel.sheet.where_hint')}</p>
      <PlaceCombobox
        id="time-travel-where-input"
        testIdPrefix="time-travel-where"
        label={t('time_travel.sheet.where')}
        placeholder={t('time_travel.sheet.where_placeholder')}
        describedBy="time-travel-where-hint"
        required
        query={query}
        onQueryChange={(text) => {
          setQuery(text);
          onPick(undefined);
        }}
        options={place ? null : options}
        onChoose={(option) => {
          onPick(toPinPlace(option));
          setQuery(option.summary.label);
          close();
        }}
        onDismiss={close}
      />
      {asking && <p data-testid="time-travel-where-question" className="mt-1 text-sm text-text-primary">{t(forDay ? 'time_travel.sheet.where_question_day' : 'time_travel.sheet.where_question')}</p>}
      {asking && (home || birth) && (
        <div className="flex flex-wrap gap-2">
          {home && <Suggestion testId="time-travel-where-home" text={t('time_travel.sheet.where_home', { place: home.label })} onUse={use(home)} />}
          {birth && <Suggestion testId="time-travel-where-suggestion" text={t('time_travel.sheet.where_suggestion', { place: birth.label })} onUse={use(birth)} />}
        </div>
      )}
      {asking && <p data-testid="time-travel-where-required" className="mt-1 text-xs text-text-muted">{t(forDay ? 'time_travel.sheet.where_required' : 'time_travel.sheet.where_required_period')}</p>}
      {place && prefilled && <p data-testid="time-travel-where-prefilled" className="mt-1 text-xs text-text-muted">{t('time_travel.sheet.where_prefilled')}</p>}
      {failed && <div data-testid="time-travel-where-failed" role="alert" className="mt-1 text-xs text-text-muted">
        <p>{t('time_travel.sheet.where_failed')}</p>
        <button type="button" data-testid="time-travel-where-retry" onClick={retry} className="mt-1 underline">
          {t('time_travel.sheet.retry_lookup')}
        </button>
      </div>}
      {options?.length === 0 && <p data-testid="time-travel-where-none" className="mt-1 text-xs text-text-muted">{t('time_travel.sheet.where_none')}</p>}
    </div>
  );
}
