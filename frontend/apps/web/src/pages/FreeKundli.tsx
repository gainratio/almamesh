import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { LandingFooter, LandingNav } from '../components/features/landing';
import { FaqJsonLd } from '../components/seo/FaqJsonLd';
import { RelatedTools } from '../components/seo/RelatedTools';

/** Crawlable intent page; the app itself remains client-side. */
export default function FreeKundli(): ReactElement {
  return (
    <div className="min-h-screen bg-observatory font-sans text-text-primary antialiased">
      <LandingNav />
      <main className="mx-auto max-w-3xl px-5 py-24">
        <p className="text-sm uppercase tracking-widest text-text-muted">Vedic astrology · Jyotish · 100% Free</p>
        <h1 className="mt-3 text-4xl font-semibold sm:text-5xl">Free Kundli &amp; Janam Kundali Calculator</h1>
        <p className="mt-5 text-lg text-text-secondary">
          Generate a 100% free Vedic kundli (Janam Kundali / Janma Kundli) from your birth date, time, and place.
          AlmaMesh computes the authentic sidereal chart — Lagna, Chandra Rashi, Grahas, 27 Nakshatras, Vimshottari Dasha, and Navamsa (D9) — directly on
          your own device. Free forever: no login, no phone number, no upload, no server.
        </p>
        <p className="mt-4 flex flex-wrap gap-4 text-sm">
          <a href="/hi/free-kundli/" lang="hi" className="text-accent-gold-bright underline">हिन्दी में पढ़ें (मुफ़्त जन्म कुंडली)</a>
          <a href="/es/free-kundli/" lang="es" className="text-accent-gold-bright underline">Leer en Español (Kundli Gratis)</a>
          <a href="/pt/free-kundli/" lang="pt" className="text-accent-gold-bright underline">Ler em Português (Kundli Grátis)</a>
        </p>
        <section lang="hi" className="mt-10 rounded-2xl border border-ui-border/60 p-6">
          <h2 className="text-2xl font-semibold">मुफ़्त कुंडली और जन्म कुंडली (100% Free Janam Kundali)</h2>
          <p className="mt-3 text-text-secondary">
            अपनी जन्म तिथि, समय और स्थान से मुफ़्त वैदिक जन्म कुंडली बनाएं। लग्न, चंद्र राशि, नवग्रह, 27 नक्षत्र, विंशोत्तरी महादशा और नवांश (D9) आपके ही ब्राउज़र में निकाले जाते हैं — कोई अकाउंट नहीं, कोई फ़ोन नंबर नहीं, कोई शुल्क नहीं।
          </p>
          <p className="mt-2 text-text-secondary">
            कुंडली गणना लाहिरी (चित्रपक्ष) अयनांश और ओपन-सोर्स इंजन से होती है तथा पहली बार लोड के बाद ऑफ़लाइन भी काम करती है।
          </p>
        </section>

        <h2 className="mt-10 text-2xl font-semibold">What the free Janam Kundali includes</h2>
        <ul className="mt-4 space-y-3 text-text-secondary">
          <li><strong>Lagna (Ascendant) &amp; Chandra Rashi:</strong> exact sidereal degrees using the Chitrapaksha Lahiri ayanamsha.</li>
          <li><strong>Janma Nakshatra &amp; Pada:</strong> your birth star among the 27 lunar mansions, with pada (1–4) and ruling Graha.</li>
          <li><strong>Vimshottari Dasha:</strong> 120-year Mahadasha and Antardasha (Bhukti) planetary timeline.</li>
          <li><strong>Divisional (Varga) charts:</strong> Rashi (D1), Navamsa (D9), Dashamsha (D10), and standard Parashari varga charts.</li>
          <li><strong>Plain-language Jyotish reading:</strong> strengths, yogas, and tensions explained clearly, without fatalism or paid-remedy upsells.</li>
        </ul>
        <h2 className="mt-10 text-2xl font-semibold">Why compute it in the browser?</h2>
        <p className="mt-4 text-text-secondary">
          Birth details are sensitive. AlmaMesh does not send them to a server, does not require
          an account, and keeps working offline after the first load. The engine is open source,
          so the calculation can be inspected rather than trusted on faith.
        </p>
        <Link
          className="mt-10 inline-flex rounded-full bg-accent-gold px-6 py-3 font-semibold text-background-primary transition-colors hover:bg-accent-gold-bright"
          to="/onboarding"
        >
          Generate my free kundli
        </Link>
        <p className="mt-4 text-sm text-text-muted">
          Astrology is offered for reflection, not as medical, legal, or financial advice.
        </p>
        <section className="mt-10">
          <h2 className="text-2xl font-semibold">Frequently asked questions</h2>
          <dl className="mt-4 space-y-4 text-text-secondary">
            <div><dt className="font-medium text-text-primary">Is the kundli calculator free?</dt><dd>Yes. AlmaMesh is free and open source, with no account and no payment. The chart is computed in your browser.</dd></div>
            <div><dt className="font-medium text-text-primary">Do you store my birth details?</dt><dd>No. Birth date, time, and place are used locally to compute the chart. They are not uploaded to a server.</dd></div>
            <div><dt className="font-medium text-text-primary">Can I use it offline?</dt><dd>Yes. After the first load, the app and engine can work offline. The optional AI interpretation is the only network feature.</dd></div>
          </dl>
        </section>

        <FaqJsonLd
          items={[
            {
              question: 'Is the kundli calculator free?',
              answer:
                'Yes. AlmaMesh is free and open source, with no account and no payment. The chart is computed in your browser.',
            },
            {
              question: 'Do you store my birth details?',
              answer:
                'No. Birth date, time, and place are used locally to compute the chart. They are not uploaded to a server.',
            },
            {
              question: 'Can I use it offline?',
              answer:
                'Yes. After the first load, the app and engine can work offline. The optional AI interpretation is the only network feature.',
            },
          ]}
        />
        <RelatedTools />
      </main>
      <LandingFooter />
    </div>
  );
}
