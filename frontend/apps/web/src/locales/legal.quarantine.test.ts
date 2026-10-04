import { describe, expect, it } from 'vitest';
import en from './en/legal.json';
import es from './es/legal.json';
import pt from './pt/legal.json';
import enCommon from './en/common.json';
import esCommon from './es/common.json';
import ptCommon from './pt/common.json';
import enSettings from './en/settings.json';
import esSettings from './es/settings.json';
import ptSettings from './pt/settings.json';

// The quarantine keeps user data in a new place, so the storage inventory and
// the deletion page must disclose it in every language.
const KEY = 'almamesh-interpretations.quarantine';
const LEGAL = { en, es, pt } as const;
const COMMON = { en: enCommon, es: esCommon, pt: ptCommon } as const;
const SETTINGS = { en: enSettings, es: esSettings, pt: ptSettings } as const;

// Pinned literals: deleting a profile does NOT clear the quarantine (an
// unreadable row cannot be matched to a profile); only Reset & reload, Start
// fresh, clearing site data, or the 30-day expiry do.
const QUARANTINE_DELETION = {
  en: 'Interpretations set aside as unreadable (the almamesh-interpretations.quarantine key) are not removed when you delete a profile, because an unreadable record cannot be matched to a profile. Reset & reload, Settings → Preferences → Reset chart / start fresh, or clearing site data erases them; otherwise they are deleted automatically after 30 days.',
  es: 'Las interpretaciones apartadas por ilegibles (la clave almamesh-interpretations.quarantine) no se eliminan al borrar un perfil, porque un registro ilegible no se puede asociar a un perfil. Restablecer y recargar, Ajustes → Preferencias → Restablecer carta / empezar de cero, o borrar los datos del sitio las elimina; si no, se eliminan automáticamente a los 30 días.',
  pt: 'As interpretações separadas por serem ilegíveis (a chave almamesh-interpretations.quarantine) não são removidas quando você exclui um perfil, porque um registro ilegível não pode ser associado a um perfil. Redefinir e recarregar, Configurações → Preferências → Redefinir mapa / começar do zero, ou limpar os dados do site as apaga; caso contrário, são excluídas automaticamente após 30 dias.',
} as const;
const PEOPLE_SECTION = { en: 'People', es: 'Personas', pt: 'Pessoas' } as const;

describe.each(Object.keys(LEGAL) as (keyof typeof LEGAL)[])('[%s] quarantine disclosure', (lang) => {
  const privacyStorage = LEGAL[lang].privacy.s1_sub2_li1_text;

  it('names the storage key, its 30-day lifetime and that backups exclude it', () => {
    expect(privacyStorage).toContain(KEY);
    expect(privacyStorage).toContain('30');
  });

  // Contract reversed (2026-10-04): the list item claimed in-app (profile)
  // deletion removed the quarantine. It does not; the page now says so.
  it('does not claim that deleting a profile removes set-aside interpretations', () => {
    expect(LEGAL[lang].data_deletion.deleted_li2).not.toContain(KEY);
  });

  it('says exactly which actions erase set-aside interpretations', () => {
    expect(LEGAL[lang].data_deletion.deleted_quarantine).toBe(QUARANTINE_DELETION[lang]);
  });

  it('points profile deletion at the Settings section that exists (People)', () => {
    expect(LEGAL[lang].data_deletion.opt1_li3_strong).toBe(PEOPLE_SECTION[lang]);
    expect(SETTINGS[lang].nav.people).toBe(PEOPLE_SECTION[lang]);
  });

  it('tells the user in the boot notice how to clear set-aside data now', () => {
    expect(COMMON[lang].storage.interpretations_set_aside).toContain('30');
  });
});
