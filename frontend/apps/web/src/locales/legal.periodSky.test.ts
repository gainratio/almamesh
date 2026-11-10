import { describe, expect, it } from 'vitest';
import en from './en/legal.json';
import es from './es/legal.json';
import pt from './pt/legal.json';
import hi from './hi/legal.json';

const DISCLOSURE = {
  en: 'Calculated skies for dates you time travel to are cached in a separate on-device SQLite database. They can be recalculated, are never exported, and are deleted with the profile.',
  es: 'Los cielos calculados para las fechas a las que viajas en el tiempo se guardan en una base SQLite separada en tu dispositivo. Se pueden recalcular, nunca se exportan y se borran con el perfil.',
  pt: 'Os céus calculados para as datas para onde você viaja no tempo ficam em um banco SQLite separado no seu aparelho. Podem ser recalculados, nunca são exportados e são apagados com o perfil.',
  hi: 'जिन तिथियों के लिए आप समय-यात्रा करते हैं उनके गणना किए गए आकाश एक अलग ऑन-डिवाइस SQLite डेटाबेस में कैश किए जाते हैं। उन्हें फिर से गणना किया जा सकता है, कभी एक्सपोर्ट नहीं किया जाता और प्रोफ़ाइल के साथ हटा दिया जाता है।',
};

describe('time travel sky storage disclosure', () => {
  it.each([['en', en], ['es', es], ['pt', pt], ['hi', hi]] as const)('%s names the separate cache, export exclusion and profile deletion', (language, catalog) => {
    expect(catalog.privacy.s1_sub2_li1_text).toContain(DISCLOSURE[language]);
  });
});
