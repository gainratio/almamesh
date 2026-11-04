import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { LandingFooter, LandingNav } from '../components/features/landing';
import { FaqJsonLd } from '../components/seo/FaqJsonLd';
import { RelatedTools } from '../components/seo/RelatedTools';

/** Crawlable intent page; the app itself remains client-side. */
export default function Dasha(): ReactElement {
  return (
    <div className="min-h-screen bg-observatory font-sans text-text-primary antialiased">
      <LandingNav />
      <main className="mx-auto max-w-3xl px-5 py-24">
        <p className="text-sm uppercase tracking-widest text-text-muted">Vedic astrology</p>
        <h1 className="mt-3 text-4xl font-semibold sm:text-5xl">Free Dasha Calculator</h1>
        <p className="mt-5 text-lg text-text-secondary">
          Generate a free Vedic kundli (birth chart) from your birth date, time, and place.
          AlmaMesh computes the sidereal chart — planets, rashis, nakshatras, and dashas — on
          your own device. No account, no upload, no server.
        </p>
        <h2 className="mt-10 text-2xl font-semibold">What the dasha report includes</h2>
        <ul className="mt-4 space-y-3 text-text-secondary">
          <li><strong>Your Vimshottari timeline:</strong> mahadasha and antardasha periods, with start and end dates.</li>
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
          Generate my free birth chart
        </Link>
        <p className="mt-4 text-sm text-text-muted">
          Astrology is offered for reflection, not as medical, legal, or financial advice.
        </p>
        <p className="mt-4"><a href="/hi/dasha/" className="text-accent-gold-bright underline">हिन्दी में पढ़ें</a></p>
        <section className="mt-10"><h2 className="text-2xl font-semibold">Frequently asked questions</h2><dl className="mt-4 space-y-4 text-text-secondary"><div><dt className="font-medium text-text-primary">What is Vimshottari dasha?</dt><dd>It is the 120-year planetary period system used in Vedic astrology, divided into mahadasha and antardasha periods.</dd></div><div><dt className="font-medium text-text-primary">Can I use it offline?</dt><dd>Yes. After the first load, the calculation runs in your browser and works offline.</dd></div></dl></section>
        <FaqJsonLd items={[{question: 'What is Vimshottari dasha?', answer: 'It is the 120-year planetary period system used in Vedic astrology, divided into mahadasha and antardasha periods.'}, {question: 'Can I use it offline?', answer: 'Yes. After the first load, the calculation runs in your browser and works offline.'}]} />
        <RelatedTools />
      </main>
      <LandingFooter />
    </div>
  );
}
