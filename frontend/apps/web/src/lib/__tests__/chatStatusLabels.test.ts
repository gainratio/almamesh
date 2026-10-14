/** The chat status lines in each shipped language: the span a call reads, where a trip goes. */
import { describe, expect, it } from 'vitest';

import i18n from '../../i18n/config';
import { chatStatusLabels } from '../chatStatusLabels';

describe('chatStatusLabels', () => {
  it.each([
    ['en', 'Reading May 2019…', 'Moving to May 2019…', 'Back to today…'],
    ['es', 'Leyendo May 2019…', 'Viajando a May 2019…', 'Volviendo a hoy…'],
    ['pt', 'Lendo May 2019…', 'Indo para May 2019…', 'Voltando para hoje…'],
  ])('%s names the span and the trip', (language, reading, moving, returning) => {
    const labels = chatStatusLabels(i18n.getFixedT(language));
    expect(labels.reading?.('May 2019')).toBe(reading);
    expect(labels.moving?.('May 2019')).toBe(moving);
    expect(labels.returning).toBe(returning);
    expect(labels.deciding).not.toContain('agent.');
  });
});
