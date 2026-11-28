/**
 * Privacy disclosure invariant for cloud drive backup across all 4 shipped
 * locales (`en`, `hi`, `es`, `pt`): every string mentioning Google Drive or
 * cloud backup must state that backups are encrypted/locked, and no string may
 * claim cloud backups live on AlmaMesh's own servers.
 */
import { describe, expect, it } from 'vitest';
import enLegal from '../en/legal.json';
import enSettings from '../en/settings.json';
import esLegal from '../es/legal.json';
import esSettings from '../es/settings.json';
import hiLegal from '../hi/legal.json';
import hiSettings from '../hi/settings.json';
import ptLegal from '../pt/legal.json';
import ptSettings from '../pt/settings.json';

const LOCALES = {
  en: {
    settings: enSettings,
    legal: enLegal,
    encrypted: /encrypt|locked|passphrase-sealed/i,
    bannedServerClaim: /backups? (?:are |is )?(?:stored |kept )?on our servers/i,
  },
  es: {
    settings: esSettings,
    legal: esLegal,
    encrypted: /cifrad|bloquead/i,
    bannedServerClaim: /copias? .* en nuestros servidores/i,
  },
  pt: {
    settings: ptSettings,
    legal: ptLegal,
    encrypted: /criptografad|bloquead/i,
    bannedServerClaim: /backups? .* em nossos servidores/i,
  },
  hi: {
    settings: hiSettings,
    legal: hiLegal,
    encrypted: /एन्क्रिप्ट|लॉक/u,
    bannedServerClaim: /बैकअप .* हमारे सर्वर पर रखे/u,
  },
} as const;

describe('cloud drive privacy disclosures across en, hi, es, pt', () => {
  for (const [lang, { settings, legal, encrypted, bannedServerClaim }] of Object.entries(LOCALES)) {
    const mustSayEncrypted: Record<string, string> = {
      'settings.drive.disclosure': settings.drive.disclosure,
      'settings.drive.passphrase_body': settings.drive.passphrase_body,
      'settings.drive.safety_to_drive_note': settings.drive.safety_to_drive_note,
      'legal.privacy.s1_sub2_li3_text': legal.privacy.s1_sub2_li3_text,
      'legal.privacy.s2_li8': legal.privacy.s2_li8,
      'legal.privacy.s6_li3': legal.privacy.s6_li3,
      'legal.data_deletion.deleted_drive': legal.data_deletion.deleted_drive,
    };

    for (const [key, value] of Object.entries(mustSayEncrypted)) {
      it(`[${lang}] ${key} explicitly states cloud backups are encrypted`, () => {
        expect(value).toMatch(encrypted);
        expect(value).not.toMatch(bannedServerClaim);
      });
    }
  }
});
