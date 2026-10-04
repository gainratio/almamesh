import { describe, expect, it } from 'vitest';
import en from './en/legal.json';
import es from './es/legal.json';
import pt from './pt/legal.json';
import enCommon from './en/common.json';
import esCommon from './es/common.json';
import ptCommon from './pt/common.json';

// The quarantine keeps user data in a new place, so the storage inventory and
// the deletion page must disclose it in every language.
const KEY = 'almamesh-interpretations.quarantine';
const LEGAL = { en, es, pt } as const;
const COMMON = { en: enCommon, es: esCommon, pt: ptCommon } as const;

describe.each(Object.keys(LEGAL) as (keyof typeof LEGAL)[])('[%s] quarantine disclosure', (lang) => {
  const privacyStorage = LEGAL[lang].privacy.s1_sub2_li1_text;

  it('names the storage key, its 30-day lifetime and that backups exclude it', () => {
    expect(privacyStorage).toContain(KEY);
    expect(privacyStorage).toContain('30');
  });

  it('tells the deletion page reader that set-aside interpretations are deleted too', () => {
    expect(LEGAL[lang].data_deletion.deleted_li2).toContain(KEY);
  });

  it('tells the user in the boot notice how to clear set-aside data now', () => {
    expect(COMMON[lang].storage.interpretations_set_aside).toContain('30');
  });
});
