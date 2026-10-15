// The default model changed 2026-10-15 (deepseek-v4.1-flash -> ~openai/gpt-luna-latest). The copy that
// names the default, and the measured times and cost it quotes, must name the new model in every
// language, never the old one.
import { describe, expect, it } from 'vitest';

import enDashboard from './en/dashboard.json';
import enSettings from './en/settings.json';
import esDashboard from './es/dashboard.json';
import esSettings from './es/settings.json';
import ptDashboard from './pt/dashboard.json';
import ptSettings from './pt/settings.json';

const LOCALES = [
  ['en', enSettings, enDashboard],
  ['es', esSettings, esDashboard],
  ['pt', ptSettings, ptDashboard],
] as const;

describe.each(LOCALES)('%s copy for the default model', (_lang, settings, dashboard) => {
  const texts = [
    settings.aiModels.interpretation_advice,
    settings.aiModels.switch_title,
    settings.aiModels.switch_body,
    settings.aiModels.switch_accept,
    dashboard.actions.switch_recommended,
  ];

  it('names GPT Luna wherever it names the default', () => {
    for (const text of texts) expect(text).toContain('GPT Luna');
  });

  it('no longer names DeepSeek or its measured 50 s and 2 cents', () => {
    for (const text of texts) expect(text).not.toMatch(/DeepSeek|50 s|50 seg|2 cent/);
  });

  it('quotes the measured Luna timeline: 39 to 49 s, under 1 cent', () => {
    expect(settings.aiModels.interpretation_advice).toMatch(/45/);
    expect(settings.aiModels.interpretation_advice).toMatch(/1 cent/);
    expect(settings.aiModels.switch_body).toMatch(/39.49 s/);
  });
});
