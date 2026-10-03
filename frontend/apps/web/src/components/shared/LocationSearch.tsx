import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { safeError } from '@almamesh/shared-types';
import { searchCities, timezoneForCoordinates, type CityMatch } from '../../lib/geo/cityLookup';

export interface LocationResult {
    displayName: string;
    city: string;
    state: string;
    country: string;
    lat: number;
    lon: number;
    timezone?: string;
}

interface LocationSearchProps {
    value: LocationResult | null;
    onChange: (location: LocationResult | null) => void;
    placeholder?: string;
    className?: string;
}

// Debounce hook
function useDebounce<T>(value: T, delay: number): T {
    const [debouncedValue, setDebouncedValue] = useState<T>(value);

    useEffect(() => {
        const timer = setTimeout(() => setDebouncedValue(value), delay);
        return () => clearTimeout(timer);
    }, [value, delay]);

    return debouncedValue;
}

/** Map a city match onto the LocationResult contract callers expect. */
function toLocationResult(match: CityMatch): LocationResult {
    return {
        displayName: match.displayName,
        city: match.city,
        // The online geocoder supplies a real state/province (admin1); the
        // offline fallback list has none, so it stays empty there. State is
        // cosmetic for the engine (only lat/lon/timezone matter).
        state: match.state ?? '',
        country: match.country,
        lat: match.latitude,
        lon: match.longitude,
        timezone: match.timezone,
    };
}

/**
 * Birth-location typeahead.
 *
 * Search is ONLINE-PRIMARY via the Open-Meteo geocoder (one of the two
 * owner-approved network egresses — the typed city string and ordinary HTTPS
 * request metadata leave the device), with a transparent OFFLINE FALLBACK to the bundled city list so it
 * keeps working with no network. A manual lat/long entry remains as a last
 * resort. The external contract (props + `LocationResult`) is unchanged; every
 * emitted result carries a valid IANA `timezone`, which the engine path requires.
 */
export function LocationSearch({
    value,
    onChange,
    placeholder,
    className = '',
}: LocationSearchProps) {
    const { t, i18n } = useTranslation();
    // The placeholder prop is an optional override; default to the translated
    // value resolved at render (a prop default can't call a hook).
    const resolvedPlaceholder = placeholder ?? t('location.search_placeholder');
    const [query, setQuery] = useState(value?.displayName || '');
    const [results, setResults] = useState<CityMatch[]>([]);
    const [isOpen, setIsOpen] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [selectedIndex, setSelectedIndex] = useState(-1);
    const [isSearching, setIsSearching] = useState(false);
    // Coordinate fallback: some birthplaces (small towns/villages under the
    // dataset's population cutoff) are genuinely absent from the offline city
    // list. This secondary affordance lets the user enter lat/long directly and
    // still emit the exact same LocationResult the picker does — with a valid
    // IANA timezone resolved on-device.
    const [showCoords, setShowCoords] = useState(false);
    const [latInput, setLatInput] = useState('');
    const [lonInput, setLonInput] = useState('');
    const [labelInput, setLabelInput] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);

    const debouncedQuery = useDebounce(query, 250);

    // Run the online-primary city search (offline fallback) when the debounced
    // query changes. The UI language localizes the geocoder's place names; we
    // pass the base tag (e.g. "en" from "en-US") since Open-Meteo wants a plain
    // 2-letter code.
    const runSearch = useCallback(
        async (searchQuery: string, signal?: AbortSignal) => {
            if (searchQuery.trim().length < 2) {
                setResults([]);
                setIsOpen(false);
                return;
            }

            setIsLoading(true);
            try {
                const language = i18n.language.split('-')[0];
                const matches = await searchCities(searchQuery, 8, { language, signal });
                // A newer keystroke superseded this query — drop its (stale) results
                // so a slow earlier response can't overwrite newer ones.
                if (signal?.aborted) return;
                setResults(matches);
                setIsOpen(matches.length > 0);
                setSelectedIndex(-1);
            } catch (error) {
                if (signal?.aborted) return; // an aborted search is expected, not a failure
                safeError('geo.city_lookup_failed', error);
                setResults([]);
            } finally {
                if (!signal?.aborted) setIsLoading(false);
            }
        },
        [i18n],
    );

    useEffect(() => {
        if (debouncedQuery && isSearching) {
            // Cancel the previous in-flight geocode on each new query / unmount so
            // results always reflect the latest keystroke (no stale-response race).
            const controller = new AbortController();
            runSearch(debouncedQuery, controller.signal);
            return () => controller.abort();
        }
    }, [debouncedQuery, isSearching, runSearch]);

    // Handle selection
    const handleSelect = (match: CityMatch) => {
        const location = toLocationResult(match);
        setIsSearching(false);
        setIsOpen(false);
        setQuery(location.displayName);
        onChange(location);
        setResults([]);
    };

    // Handle input change
    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newQuery = e.target.value;
        setQuery(newQuery);
        setIsSearching(true);
        if (value) {
            onChange(null);
        }
        if (newQuery.length < 2) {
            setResults([]);
            setIsOpen(false);
        }
    };

    // Handle keyboard navigation
    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (!isOpen || results.length === 0) return;

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                setSelectedIndex((prev) => (prev < results.length - 1 ? prev + 1 : prev));
                break;
            case 'ArrowUp':
                e.preventDefault();
                setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev));
                break;
            case 'Enter':
                e.preventDefault();
                if (selectedIndex >= 0 && selectedIndex < results.length) {
                    handleSelect(results[selectedIndex]);
                }
                break;
            case 'Escape':
                setIsOpen(false);
                break;
        }
    };

    // Close dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (
                dropdownRef.current &&
                !dropdownRef.current.contains(event.target as Node) &&
                inputRef.current &&
                !inputRef.current.contains(event.target as Node)
            ) {
                setIsOpen(false);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // Format coordinates for display
    const formatCoords = (lat: number, lon: number) => {
        const latDir = lat >= 0 ? 'N' : 'S';
        const lonDir = lon >= 0 ? 'E' : 'W';
        return `${Math.abs(lat).toFixed(2)}${latDir}, ${Math.abs(lon).toFixed(2)}${lonDir}`;
    };

    // --- Coordinate fallback: validation + commit ---
    const latNum = Number(latInput);
    const lonNum = Number(lonInput);
    const latFilled = latInput.trim() !== '';
    const lonFilled = lonInput.trim() !== '';
    const latValid = latFilled && Number.isFinite(latNum) && latNum >= -90 && latNum <= 90;
    const lonValid = lonFilled && Number.isFinite(lonNum) && lonNum >= -180 && lonNum <= 180;
    const coordsValid = latValid && lonValid;
    // Only surface the range error once the user has actually typed an
    // out-of-range value — an empty field is "incomplete", not "wrong".
    const coordsOutOfRange = (latFilled && !latValid) || (lonFilled && !lonValid);

    const handleCoordinateSubmit = () => {
        if (!coordsValid) return;
        const trimmedLabel = labelInput.trim();
        // name = the optional label, else a formatted "lat, lon".
        const displayName = trimmedLabel || formatCoords(latNum, lonNum);
        const location: LocationResult = {
            displayName,
            city: displayName,
            // No dataset row backs a hand-entered coordinate, so state/country
            // are unknown — the engine only needs lat/lon + timezone.
            state: '',
            country: '',
            lat: latNum,
            lon: lonNum,
            // Resolved on-device, identical to the city path — toBirthInput
            // fails closed without a valid IANA timezone.
            timezone: timezoneForCoordinates(latNum, lonNum),
        };
        setIsSearching(false);
        setIsOpen(false);
        setResults([]);
        setQuery(displayName);
        setShowCoords(false);
        onChange(location);
    };

    return (
        <div className={`relative ${className}`}>
            {/* Search Input */}
            <div className="relative">
                <input
                    ref={inputRef}
                    type="text"
                    value={query}
                    onChange={handleInputChange}
                    onKeyDown={handleKeyDown}
                    onFocus={() => results.length > 0 && setIsOpen(true)}
                    placeholder={resolvedPlaceholder}
                    className="w-full px-4 py-4 pl-12 bg-background-tertiary border border-ui-border rounded-lg text-text-primary text-lg placeholder-text-muted focus:outline-hidden focus:ring-2 focus:ring-accent-gold/50"
                    autoComplete="off"
                    role="combobox"
                    aria-expanded={isOpen}
                    aria-autocomplete="list"
                    aria-label={t('location.search_aria')}
                    data-testid="location-search-input"
                />
                {/* Search Icon */}
                <div className="absolute left-4 top-1/2 -translate-y-1/2 text-text-muted">
                    {isLoading ? (
                        <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24" aria-hidden="true">
                            <circle
                                className="opacity-25"
                                cx="12"
                                cy="12"
                                r="10"
                                stroke="currentColor"
                                strokeWidth="4"
                                fill="none"
                            />
                            <path
                                className="opacity-75"
                                fill="currentColor"
                                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                            />
                        </svg>
                    ) : (
                        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                            />
                        </svg>
                    )}
                </div>
                {/* Clear Button */}
                {query && (
                    <button
                        type="button"
                        aria-label={t('location.clear_aria')}
                        onClick={() => {
                            setQuery('');
                            setIsSearching(false);
                            onChange(null);
                            setResults([]);
                            inputRef.current?.focus();
                        }}
                        className="absolute right-4 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary"
                    >
                        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M6 18L18 6M6 6l12 12"
                            />
                        </svg>
                    </button>
                )}
            </div>

            {/* Selected Location Info */}
            {value && (
                <div className="mt-3 p-3 bg-accent-gold/10 border border-accent-gold/30 rounded-lg">
                    <div className="flex items-center justify-between">
                        <div>
                            <p className="text-text-primary font-medium">{value.displayName}</p>
                            {value.lat !== 0 && value.lon !== 0 && (
                                <p className="text-text-muted text-sm mt-1">
                                    <span className="inline-flex items-center gap-1">
                                        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                                            <path
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                strokeWidth={2}
                                                d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
                                            />
                                            <path
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                strokeWidth={2}
                                                d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
                                            />
                                        </svg>
                                        {formatCoords(value.lat, value.lon)}
                                        {value.timezone && (
                                            <span className="ml-2">· {value.timezone}</span>
                                        )}
                                    </span>
                                </p>
                            )}
                        </div>
                        <svg className="h-5 w-5 text-accent-gold" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                    </div>
                </div>
            )}

            {/* Dropdown Results */}
            {isOpen && results.length > 0 && (
                <div
                    ref={dropdownRef}
                    role="listbox"
                    className="absolute z-50 w-full mt-2 bg-background-secondary border border-ui-border rounded-lg shadow-lg overflow-hidden"
                >
                    {results.map((match, index) => (
                        <button
                            key={`${match.city}-${match.countryCode}-${match.latitude}-${match.longitude}`}
                            type="button"
                            role="option"
                            aria-selected={index === selectedIndex}
                            onClick={() => handleSelect(match)}
                            className={`w-full px-4 py-3 text-left transition-colors ${index === selectedIndex
                                ? 'bg-accent-gold/20'
                                : 'hover:bg-background-tertiary'
                                }`}
                        >
                            <div className="flex items-start justify-between gap-4">
                                <div className="flex-1 min-w-0">
                                    <p className="text-text-primary font-medium truncate">
                                        {match.city}
                                    </p>
                                    <p className="text-text-muted text-sm truncate">
                                        {match.country}
                                    </p>
                                </div>
                                <div className="text-right shrink-0">
                                    <p className="text-text-muted text-xs font-mono">
                                        {formatCoords(match.latitude, match.longitude)}
                                    </p>
                                </div>
                            </div>
                        </button>
                    ))}
                    <div className="px-4 py-2 bg-background-tertiary border-t border-ui-border">
                        <p className="text-text-muted text-xs text-center">
                            {t('location.offline_hint')}
                        </p>
                    </div>
                </div>
            )}

            {/* No Results */}
            {isOpen && results.length === 0 && query.length >= 2 && !isLoading && (
                <div
                    ref={dropdownRef}
                    className="absolute z-50 w-full mt-2 bg-background-secondary border border-ui-border rounded-lg shadow-lg p-4"
                >
                    <p className="text-text-muted text-center text-sm">{t('location.no_results')}</p>
                </div>
            )}

            {/* Coordinate fallback — a secondary affordance for birthplaces
                missing from the offline city list (small towns/villages under
                the population cutoff). City search stays the primary path. */}
            <div className="mt-3">
                <button
                    type="button"
                    onClick={() => setShowCoords((prev) => !prev)}
                    aria-expanded={showCoords}
                    className="text-sm text-text-muted hover:text-accent-gold underline decoration-dotted underline-offset-2 transition-colors"
                    data-testid="coordinate-fallback-toggle"
                >
                    {showCoords ? t('location.coordinates.hide') : t('location.coordinates.toggle')}
                </button>

                {showCoords && (
                    <div className="mt-3 p-4 bg-background-tertiary border border-ui-border rounded-lg space-y-3">
                        <p className="text-text-secondary text-sm">{t('location.coordinates.hint')}</p>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div>
                                <label
                                    htmlFor="coordinate-lat"
                                    className="block text-text-primary text-sm font-medium mb-1"
                                >
                                    {t('location.coordinates.latitude_label')}
                                </label>
                                <input
                                    id="coordinate-lat"
                                    type="number"
                                    inputMode="decimal"
                                    step="any"
                                    min={-90}
                                    max={90}
                                    value={latInput}
                                    onChange={(e) => setLatInput(e.target.value)}
                                    placeholder={t('location.coordinates.latitude_placeholder')}
                                    className="w-full px-3 py-2 bg-background-secondary border border-ui-border rounded-lg text-text-primary placeholder-text-muted focus:outline-hidden focus:ring-2 focus:ring-accent-gold/50"
                                    data-testid="coordinate-lat-input"
                                />
                            </div>
                            <div>
                                <label
                                    htmlFor="coordinate-lon"
                                    className="block text-text-primary text-sm font-medium mb-1"
                                >
                                    {t('location.coordinates.longitude_label')}
                                </label>
                                <input
                                    id="coordinate-lon"
                                    type="number"
                                    inputMode="decimal"
                                    step="any"
                                    min={-180}
                                    max={180}
                                    value={lonInput}
                                    onChange={(e) => setLonInput(e.target.value)}
                                    placeholder={t('location.coordinates.longitude_placeholder')}
                                    className="w-full px-3 py-2 bg-background-secondary border border-ui-border rounded-lg text-text-primary placeholder-text-muted focus:outline-hidden focus:ring-2 focus:ring-accent-gold/50"
                                    data-testid="coordinate-lon-input"
                                />
                            </div>
                        </div>
                        <div>
                            <label
                                htmlFor="coordinate-label"
                                className="block text-text-primary text-sm font-medium mb-1"
                            >
                                {t('location.coordinates.place_label')}
                            </label>
                            <input
                                id="coordinate-label"
                                type="text"
                                value={labelInput}
                                onChange={(e) => setLabelInput(e.target.value)}
                                placeholder={t('location.coordinates.place_placeholder')}
                                className="w-full px-3 py-2 bg-background-secondary border border-ui-border rounded-lg text-text-primary placeholder-text-muted focus:outline-hidden focus:ring-2 focus:ring-accent-gold/50"
                                data-testid="coordinate-label-input"
                            />
                        </div>
                        {coordsOutOfRange && (
                            <p
                                role="alert"
                                className="text-status-warning text-sm"
                                data-testid="coordinate-error"
                            >
                                {t('location.coordinates.range_error')}
                            </p>
                        )}
                        <button
                            type="button"
                            onClick={handleCoordinateSubmit}
                            disabled={!coordsValid}
                            className="w-full px-4 py-2 bg-accent-gold/20 border border-accent-gold/40 rounded-lg text-text-primary font-medium hover:bg-accent-gold/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                            data-testid="coordinate-submit"
                        >
                            {t('location.coordinates.submit')}
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
