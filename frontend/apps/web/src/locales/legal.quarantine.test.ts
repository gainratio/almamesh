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

// The quarantine keeps user data, so the storage inventory and the deletion
// page must disclose where it lives in every language. Since 2026-10-04 it is a
// table in the on-device SQLite database, not a localStorage key.
const LEGACY_KEY = 'almamesh-interpretations.quarantine';
const LEGAL = { en, es, pt } as const;
const COMMON = { en: enCommon, es: esCommon, pt: ptCommon } as const;
const SETTINGS = { en: enSettings, es: esSettings, pt: ptSettings } as const;

// Pinned literals for the storage inventory sentence about the quarantine.
const QUARANTINE_STORAGE = {
  en: 'If a saved interpretation cannot be read, it is set aside on this device in a quarantine table inside that same SQLite database for up to 30 days instead of being lost.',
  es: 'Si una interpretación guardada no se puede leer, se aparta en este dispositivo en una tabla de cuarentena dentro de esa misma base SQLite durante un máximo de 30 días en lugar de perderse.',
  pt: 'Se uma interpretação salva não puder ser lida, ela é separada neste dispositivo em uma tabela de quarentena dentro desse mesmo banco SQLite por até 30 dias em vez de ser perdida.',
} as const;

// Contract reversed (2026-10-04): profile delete used to leave the quarantine
// alone. It now removes every set-aside record holding that profile's readings;
// only a record matched to no profile waits for reset, site-data clear or expiry.
const QUARANTINE_DELETION = {
  en: 'Interpretations set aside as unreadable (the quarantine table in the on-device SQLite database) are removed when you delete the profile they belong to. A record too damaged to match to any profile is erased by Reset & reload, Settings → Preferences → Reset chart / start fresh, or clearing site data; otherwise it is deleted automatically after 30 days.',
  es: 'Las interpretaciones apartadas por ilegibles (la tabla de cuarentena de la base SQLite del dispositivo) se eliminan al borrar el perfil al que pertenecen. Un registro demasiado dañado para asociarlo a un perfil se borra con Restablecer y recargar, Ajustes → Preferencias → Restablecer carta / empezar de cero, o al borrar los datos del sitio; si no, se elimina automáticamente a los 30 días.',
  pt: 'As interpretações separadas por serem ilegíveis (a tabela de quarentena do banco SQLite do dispositivo) são removidas quando você exclui o perfil a que pertencem. Um registro danificado demais para ser associado a um perfil é apagado por Redefinir e recarregar, Configurações → Preferências → Redefinir mapa / começar do zero, ou ao limpar os dados do site; caso contrário, é excluído automaticamente após 30 dias.',
} as const;
const PEOPLE_SECTION = { en: 'People', es: 'Personas', pt: 'Pessoas' } as const;

describe.each(Object.keys(LEGAL) as (keyof typeof LEGAL)[])('[%s] quarantine disclosure', (lang) => {
  const privacyStorage = LEGAL[lang].privacy.s1_sub2_li1_text;

  it('says the quarantine is a SQLite table, kept 30 days, never a localStorage key', () => {
    expect(privacyStorage).toContain(QUARANTINE_STORAGE[lang]);
    expect(privacyStorage).not.toMatch(/localStorage[^.]*almamesh-interpretations\.quarantine[^.]*30/);
  });

  it('keeps the profile list item free of the legacy key', () => {
    expect(LEGAL[lang].data_deletion.deleted_li2).not.toContain(LEGACY_KEY);
    expect(LEGAL[lang].data_deletion.deleted_quarantine).not.toContain(LEGACY_KEY);
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
