import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { LandingFooter, LandingNav } from '../components/features/landing';
import { FaqJsonLd } from '../components/seo/FaqJsonLd';

/** Crawlable intent page; the app itself remains client-side. */
export default function FreeKundli(): ReactElement {
  return (
    <div className="min-h-screen bg-observatory font-sans text-text-primary antialiased">
      <LandingNav />
      <main className="mx-auto max-w-3xl px-5 py-24">
        <p className="text-sm uppercase tracking-widest text-text-muted">Vedic astrology</p>
        <h1 className="mt-3 text-4xl font-semibold sm:text-5xl">Free Kundli Calculator</h1>
        <p className="mt-5 text-lg text-text-secondary">
          Generate a free Vedic kundli (birth chart) from your birth date, time, and place.
          AlmaMesh computes the sidereal chart — planets, rashis, nakshatras, and dashas — on
          your own device. No account, no upload, no server.
        </p>
        <section lang="hi" className="mt-10 rounded-2xl border border-ui-border/60 p-6">
          <h2 className="text-2xl font-semibold">मुफ़्त कुंडली और जन्म कुंडली</h2>
          <p className="mt-3 text-text-secondary">
            अपनी जन्म तिथि, समय और स्थान से मुफ़्त वैदिक कुंडली बनाएं। ग्रह, राशि, नक्षत्र और
            दशाएं आपके ही ब्राउज़र में निकाली जाती हैं — कोई अकाउंट नहीं, कोई अपलोड नहीं।
          </p>
          <p className="mt-2 text-text-secondary">
            कुंडली गणना ओपन-सोर्स इंजन से होती है और पहली बार लोड के बाद ऑफ़लाइन भी काम करती है।
          </p>
        </section>

        <h2 className="mt-10 text-2xl font-semibold">What the kundli includes</h2>
        <ul className="mt-4 space-y-3 text-text-secondary">
          <li><strong>Lagna and planets:</strong> sidereal positions using the Lahiri ayanamsha.</li>
          <li><strong>Nakshatras:</strong> the 27 lunar mansions, with pada.</li>
          <li><strong>Dashas:</strong> Vimshottari mahadasha and antardasha periods.</li>
          <li><strong>Divisional charts:</strong> D1 and the standard varga charts supported by the engine.</li>
          <li><strong>Plain-language reading:</strong> strengths and tensions, without fatalism or fear.</li>
        </ul>
        <h2 className="mt-10 text-2xl font-semibold">Why compute it in the browser?</h2>
        <p className="mt-4 text-text-secondary">
          Birth details are sensitive. AlmaMesh does not send them to a server, does not require
          an account, and keeps working offline after the first load. The engine is open source,
          so the calculation can be inspected rather than trusted on faith.
        </p>
        <Link
          className="mt-10 inline-flex rounded-full bg-accent px-6 py-3 font-medium text-white"
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
      </main>
      <LandingFooter />
    </div>
  );
}
