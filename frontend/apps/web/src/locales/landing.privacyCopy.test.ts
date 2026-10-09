import { describe, it, expect } from 'vitest';
import en from './en/landing.json';
import es from './es/landing.json';
import pt from './pt/landing.json';
import enMesh from './en/mesh.json';
import esMesh from './es/mesh.json';
import ptMesh from './pt/mesh.json';
import enLegal from './en/legal.json';
import esLegal from './es/legal.json';
import ptLegal from './pt/legal.json';
import enSettings from './en/settings.json';
import esSettings from './es/settings.json';
import ptSettings from './pt/settings.json';
import enDashboard from './en/dashboard.json';
import esDashboard from './es/dashboard.json';
import ptDashboard from './pt/dashboard.json';

/**
 * Privacy-honesty invariant: the landing hero + footer must NOT claim an
 * unqualified absolute like "Nothing leaves your browser" / "your data never
 * leaves your browser". Two features reach the network on the user's behalf:
 * the opt-in AI chat sends the user's typed questions to the configured
 * endpoint, and birthplace search sends the typed CITY NAME plus ordinary
 * HTTPS/request metadata to a maps geocoder (Open-Meteo). So we may NOT claim
 * "birth data" as a whole stays local — the
 * birthplace name is part of it. The only zero-egress guarantee we state is
 * scoped precisely to the BIRTH DATE, TIME, AND CHART (the chart engine makes no
 * network calls; the date/time and the computed chart never leave the device,
 * and the chart is PII-redacted before any AI call). The scoped phrasing is used
 * consistently in the hero, footer, and `why.rows` across all three locales.
 */
type LocaleCopy = {
  hero: { subhead: string };
  footer: { tagline: string };
};

const LOCALES: Record<string, { copy: LocaleCopy; scoped: string; bannedAbsolutes: string[] }> = {
  en: {
    copy: en as LocaleCopy,
    scoped: 'your birth date, time, and chart stay in your browser unless you turn on the optional ai',
    bannedAbsolutes: [
      // REVERSED CONTRACT: this was the required wording until the AI egress
      // audit. With AI on, the chart (planet longitudes, lagna) leaves, and it
      // can reveal the birth date, so the unqualified sentence is untrue.
      'your birth date, time, and chart never leave your browser',
      'nothing leaves your browser',
      'your data never leaves your browser',
      'your birth data never leaves your browser',
    ],
  },
  es: {
    copy: es as LocaleCopy,
    scoped: 'tu fecha, hora y carta de nacimiento se quedan en tu navegador salvo que actives la ia opcional',
    bannedAbsolutes: [
      'tu fecha, hora y carta de nacimiento nunca salen de tu navegador',
      'nada sale de tu navegador',
      'tus datos nunca salen de tu navegador',
      'tus datos de nacimiento nunca salen de tu navegador',
    ],
  },
  pt: {
    copy: pt as LocaleCopy,
    scoped: 'sua data, hora e mapa de nascimento ficam no seu navegador, a menos que você ative a ia opcional',
    bannedAbsolutes: [
      'sua data, hora e mapa de nascimento nunca saem do seu navegador',
      'nada sai do seu navegador',
      'seus dados nunca saem do seu navegador',
      'seus dados de nascimento nunca saem do seu navegador',
    ],
  },
};

describe('landing privacy copy is scoped to birth data (anti-overclaim)', () => {
  for (const [lang, { copy, scoped, bannedAbsolutes }] of Object.entries(LOCALES)) {
    const subhead = copy.hero.subhead.toLowerCase();
    const tagline = copy.footer.tagline.toLowerCase();

    it(`[${lang}] hero.subhead uses the scoped "birth data" phrasing`, () => {
      expect(subhead).toContain(scoped);
    });

    it(`[${lang}] footer.tagline uses the scoped "birth data" phrasing`, () => {
      expect(tagline).toContain(scoped);
    });

    it(`[${lang}] hero.subhead + footer.tagline contain no unqualified absolute`, () => {
      for (const banned of bannedAbsolutes) {
        expect(subhead).not.toContain(banned);
        expect(tagline).not.toContain(banned);
      }
    });
  }
});

/**
 * The same anti-overclaim invariant on the two ENGINE-SURFACE strings that
 * carried an unqualified absolute:
 *  - mesh `page.computed_note` — the Mesh has reachable AI narration
 *    (`streamMeshReading`) that sends role-anonymized, PII-redacted facts, so a
 *    blanket "nothing leaves it" was an overclaim. Scoped to birth data (the
 *    pair sanitizer strips names + PII before any AI call).
 *  - legal `privacy.s5_p1` — the "Your Rights" premise. The optional AI prompt
 *    egress is disclosed elsewhere (s2/s3), but this sentence itself was an
 *    unqualified "your data never leaves your device"; scoped for legal precision.
 * NOTE: predictive `gate.body` is deliberately NOT covered — its "Nothing leaves
 * this browser" describes the engine-only timing-layer compute (no AI on that
 * path), which is genuinely zero-egress and therefore accurate.
 */
type MeshCopy = { page: { computed_note: string } };
type LegalCopy = { privacy: { s5_p1: string } };

const ENGINE_SURFACES: Record<
  string,
  {
    meshNote: string;
    legalRights: string;
    scoped: string;
    bannedMeshAbsolute: string;
    bannedLegalAbsolute: string;
  }
> = {
  en: {
    meshNote: (enMesh as MeshCopy).page.computed_note,
    legalRights: (enLegal as LegalCopy).privacy.s5_p1,
    scoped: 'unless you',
    bannedMeshAbsolute: 'never leave',
    bannedLegalAbsolute: 'never leave',
  },
  es: {
    meshNote: (esMesh as MeshCopy).page.computed_note,
    legalRights: (esLegal as LegalCopy).privacy.s5_p1,
    scoped: 'salvo que',
    bannedMeshAbsolute: 'nunca salen',
    bannedLegalAbsolute: 'nunca salen',
  },
  pt: {
    meshNote: (ptMesh as MeshCopy).page.computed_note,
    legalRights: (ptLegal as LegalCopy).privacy.s5_p1,
    scoped: 'a menos que',
    bannedMeshAbsolute: 'nunca saem',
    bannedLegalAbsolute: 'nunca saem',
  },
};

describe('engine-surface privacy copy is scoped to birth data (anti-overclaim)', () => {
  for (const [lang, surface] of Object.entries(ENGINE_SURFACES)) {
    const meshNote = surface.meshNote.toLowerCase();
    const legalRights = surface.legalRights.toLowerCase();

    it(`[${lang}] mesh.page.computed_note uses the scoped "birth data" phrasing`, () => {
      expect(meshNote).toContain(surface.scoped);
      expect(meshNote).not.toContain(surface.bannedMeshAbsolute);
    });

    it(`[${lang}] legal.privacy.s5_p1 uses the scoped "birth data" phrasing`, () => {
      expect(legalRights).toContain(surface.scoped);
      expect(legalRights).not.toContain(surface.bannedLegalAbsolute);
    });
  }
});

/**
 * AI egress honesty. With AI on, `sanitizeChartForLlm` (packages/llm/src/sanitize.ts)
 * sends planet longitudes, the lagna, the ayanamsa value and month-precision
 * dasha windows. The birth DATE field itself is not sent, but those positions
 * are enough to work out the birth date and approximate time. So no AI
 * disclosure may say the AI gets "no birth date" without saying the chart data
 * can reveal it, and no copy may say the birth date/time "never" leaves.
 */
type AiEgressCopy = {
  landing: { how: { zeroEgress: string } };
  dashboard: { grounding: { point_privacy: string } };
  settings: { ai: { info_description: string } };
  legal: { privacy: { s2_li2: string } };
};

const AI_EGRESS: Record<string, { copy: AiEgressCopy; reveal: string; banned: string[] }> = {
  en: {
    copy: { landing: en, dashboard: enDashboard, settings: enSettings, legal: enLegal } as AiEgressCopy,
    reveal: 'can reveal',
    banned: [
      'birth date and time never leave',
      'no name or birth date',
      'no name, no birth date',
      'nothing about it leaves your device;',
    ],
  },
  es: {
    copy: { landing: es, dashboard: esDashboard, settings: esSettings, legal: esLegal } as AiEgressCopy,
    reveal: 'pueden revelar',
    banned: [
      'fecha y hora de nacimiento nunca salen',
      'sin nombre ni fecha de nacimiento',
      'no incluyen nombre ni fecha de nacimiento',
      'nada de ella sale de tu dispositivo;',
    ],
  },
  pt: {
    copy: { landing: pt, dashboard: ptDashboard, settings: ptSettings, legal: ptLegal } as AiEgressCopy,
    reveal: 'podem revelar',
    banned: [
      'data e hora de nascimento nunca saem',
      'sem nome nem data de nascimento',
      'sem nome e sem data de nascimento',
      'não incluem nome nem data de nascimento',
      'nada dele sai do seu dispositivo;',
    ],
  },
};

describe('AI disclosures say chart data can reveal the birth date', () => {
  for (const [lang, { copy, reveal, banned }] of Object.entries(AI_EGRESS)) {
    const surfaces: Record<string, string> = {
      'landing.how.zeroEgress': copy.landing.how.zeroEgress,
      'dashboard.grounding.point_privacy': copy.dashboard.grounding.point_privacy,
      'settings.ai.info_description': copy.settings.ai.info_description,
      'legal.privacy.s2_li2': copy.legal.privacy.s2_li2,
    };
    for (const [key, text] of Object.entries(surfaces)) {
      it(`[${lang}] ${key} says the chart data can reveal the birth date`, () => {
        const lower = text.toLowerCase();
        expect(lower).toContain(reveal);
        for (const phrase of banned) expect(lower).not.toContain(phrase);
      });
    }
  }
});

type SettingsCopy = { tiers: { cloud_body: string } };

const AI_SETTINGS_DISCLOSURE: Record<string, { body: string; narrative: string; birth: string }> = {
  en: {
    body: (enSettings as SettingsCopy).tiers.cloud_body,
    narrative: 'narrative',
    birth: 'birth details',
  },
  es: {
    body: (esSettings as SettingsCopy).tiers.cloud_body,
    narrative: 'relato',
    birth: 'datos de nacimiento',
  },
  pt: {
    body: (ptSettings as SettingsCopy).tiers.cloud_body,
    narrative: 'narrativa',
    birth: 'dados de nascimento',
  },
};

describe('AI settings disclose free-form life-event egress', () => {
  for (const [lang, disclosure] of Object.entries(AI_SETTINGS_DISCLOSURE)) {
    it(`[${lang}] distinguishes narrative text from redacted chart prompts`, () => {
      const body = disclosure.body.toLowerCase();
      expect(body).toContain(disclosure.narrative);
      expect(body).toContain(disclosure.birth);
    });
  }
});

type FeedbackLegalCopy = {
  privacy: { s2_li4: string };
  data_deletion: { retention_li1: string };
};

describe('legal copy discloses feedback storage separately from browser data', () => {
  for (const [lang, legal] of Object.entries({ en: enLegal, es: esLegal, pt: ptLegal })) {
    it(`[${lang}] names Turnstile and D1 retention`, () => {
      const copy = legal as FeedbackLegalCopy;
      expect(copy.privacy.s2_li4).toContain('Turnstile');
      expect(copy.privacy.s2_li4).toContain('D1');
      expect(copy.data_deletion.retention_li1).toContain('D1');
    });
  }
});

/**
 * Data-portability promise (the flip side of no-centralization): because there
 * is NO server copy of your data, the "How it works" section states that YOU can
 * export everything to a single file and restore it in another browser/device
 * yourself — reinforcing the no-server promise rather than contradicting it (it
 * mirrors the shipped Settings → Data → Backup & Restore feature). Each locale's
 * `how.portability` must name the data export AND the other-device restore, so
 * the promise can't silently regress to a vague "your data is safe".
 */
type HowPortabilityCopy = { how: { portability: string } };

const PORTABILITY: Record<string, { note: string; mustMention: string[] }> = {
  en: { note: (en as HowPortabilityCopy).how.portability, mustMention: ['export', 'device'] },
  es: { note: (es as HowPortabilityCopy).how.portability, mustMention: ['export', 'dispositivo'] },
  pt: { note: (pt as HowPortabilityCopy).how.portability, mustMention: ['export', 'dispositivo'] },
};

describe('landing how.portability states the export/restore promise', () => {
  for (const [lang, { note, mustMention }] of Object.entries(PORTABILITY)) {
    it(`[${lang}] names data export + another device`, () => {
      expect(typeof note).toBe('string');
      const lower = (note ?? '').toLowerCase();
      for (const term of mustMention) expect(lower).toContain(term);
    });
  }
});
