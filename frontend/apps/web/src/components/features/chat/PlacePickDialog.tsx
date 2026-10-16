/**
 * "Which Springfield?": the chat's place picker. It appears only when
 * read_period or travel found several places and is waiting (placePick.ts), shows the
 * same place box as the time-travel "Where?" (the candidates first, a new
 * search as the person types), and answers with the pick or, on Cancel or
 * Escape, with nothing. Offline only, like every chat place.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import type { PlaceLookup } from '../../../lib/geo/placeLookup';
import { mountPlacePicker, pendingPlacePick, subscribePlacePick, type PlacePickRequest } from '../../../lib/placePick';
import { PlaceCombobox } from './PlaceCombobox';
import { lookupPlaceLazily, usePlaceOptions } from './PlacePicker';
import { trapFocus } from './TimeTravelSheet';

interface PlacePickDialogProps {
  /** Test seam; the bundled list otherwise. */
  readonly lookup?: (query: string) => Promise<PlaceLookup>;
}

export function PlacePickDialog({ lookup = lookupPlaceLazily }: PlacePickDialogProps) {
  useEffect(() => mountPlacePicker(), []);
  const request = useSyncExternalStore(subscribePlacePick, pendingPlacePick, pendingPlacePick);
  // A new request is a new picker: its own text and candidates.
  return request ? <PlacePickSheet key={`${request.query}:${request.candidates.length}`} request={request} lookup={lookup} /> : null;
}

/** "Springfield" from "Springfield, IL". */
function placeName(query: string): string {
  return query.split(',')[0]?.trim() || query;
}

function PlacePickSheet({ request, lookup }: { readonly request: PlacePickRequest; readonly lookup: (query: string) => Promise<PlaceLookup> }) {
  const { t } = useTranslation('chat');
  const sheetRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState(request.query);
  // The typed text already has its answer (the candidates); search again only once it changes.
  const searched = usePlaceOptions(query, lookup, request.query);
  const options = query === request.query ? request.candidates : searched.options;
  const cancel = () => request.answer(undefined);

  return (
    <div ref={sheetRef} role="dialog" aria-modal="true" aria-labelledby="place-pick-title" data-testid="place-pick"
      className="absolute inset-x-0 bottom-0 z-30 rounded-t-2xl border border-ui-border bg-background-secondary p-4 shadow-xl"
      onKeyDown={(event) => {
        if (event.key === 'Escape') cancel();
        if (event.key === 'Tab') trapFocus(event, sheetRef.current);
      }}>
      <h4 id="place-pick-title" className="font-semibold text-text-primary">{t('place_pick.title', { place: placeName(request.query) })}</h4>
      <PlaceCombobox
        id="place-pick-input"
        testIdPrefix="place-pick"
        label={t('place_pick.label')}
        placeholder={t('time_travel.sheet.where_placeholder')}
        autoFocus
        query={query}
        onQueryChange={setQuery}
        options={options}
        onChoose={(place) => request.answer(place)}
        onDismiss={cancel}
      />
      {options?.length === 0 && <p className="mt-1 text-xs text-text-muted">{t('time_travel.sheet.where_none')}</p>}
      <div className="mt-3 flex justify-end">
        <button type="button" data-testid="place-pick-cancel" onClick={cancel}
          className="rounded-lg px-4 py-2 text-sm text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-gold/60">
          {t('time_travel.sheet.cancel')}
        </button>
      </div>
    </div>
  );
}
