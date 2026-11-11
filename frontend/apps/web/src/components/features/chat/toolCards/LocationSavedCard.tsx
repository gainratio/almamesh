/**
 * Inline confirmation + 1-click Undo pill for `set_current_location` (`saved`)
 * and `remember_fact` (`remembered`).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useProfilesStore } from '@almamesh/store';

interface LocationSavedPayload {
  readonly status: 'saved';
  readonly place: { readonly label: string; readonly timezone: string };
}

interface FactRememberedPayload {
  readonly status: 'remembered';
  readonly fact: { readonly id: string; readonly category: string; readonly text: string };
}

function isLocationSaved(value: unknown): value is LocationSavedPayload {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return r.status === 'saved' && Boolean(r.place && typeof (r.place as Record<string, unknown>).label === 'string');
}

function isFactRemembered(value: unknown): value is FactRememberedPayload {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return r.status === 'remembered' && Boolean(r.fact && typeof (r.fact as Record<string, unknown>).id === 'string');
}

export function LocationSavedCard({ toolName, result }: { readonly toolName: string; readonly result: unknown }) {
  const { t } = useTranslation('chat');
  const activeProfileId = useProfilesStore((s) => s.activeProfileId);
  const setCurrentPlace = useProfilesStore((s) => s.setCurrentPlace);
  const removeFact = useProfilesStore((s) => s.removeProfileMemoryFact);
  const [undone, setUndone] = useState(false);

  if (toolName === 'set_current_location' && isLocationSaved(result)) {
    return (
      <div
        data-testid="tool-card-location-saved"
        className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-accent-gold/40 bg-accent-gold/10 px-3 py-2 text-xs text-text-primary"
      >
        <span>
          <span aria-hidden="true">📍 </span>
          {undone
            ? t('cards.saved.location_undone')
            : t('cards.saved.location_saved', { place: result.place.label })}
        </span>
        {activeProfileId && !undone && (
          <button
            type="button"
            data-testid="tool-card-location-undo"
            onClick={() => {
              setCurrentPlace(activeProfileId, undefined);
              setUndone(true);
            }}
            className="min-h-6 rounded px-2 py-0.5 text-xs font-medium text-accent-gold underline hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-gold/60"
          >
            {t('cards.saved.undo')}
          </button>
        )}
      </div>
    );
  }

  if (toolName === 'remember_fact' && isFactRemembered(result)) {
    return (
      <div
        data-testid="tool-card-fact-remembered"
        className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-accent-purple/40 bg-accent-purple/10 px-3 py-2 text-xs text-text-primary"
      >
        <span className="min-w-0 flex-1 truncate">
          <span aria-hidden="true">🧠 </span>
          {undone
            ? t('cards.saved.memory_undone')
            : t('cards.saved.memory_saved', { text: result.fact.text })}
        </span>
        {activeProfileId && !undone && (
          <button
            type="button"
            data-testid="tool-card-fact-undo"
            onClick={() => {
              removeFact(activeProfileId, result.fact.id);
              setUndone(true);
            }}
            className="min-h-6 shrink-0 rounded px-2 py-0.5 text-xs font-medium text-accent-purple underline hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-gold/60"
          >
            {t('cards.saved.undo')}
          </button>
        )}
      </div>
    );
  }

  return null;
}
