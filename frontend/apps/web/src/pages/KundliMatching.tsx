import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { LandingFooter, LandingNav } from '../components/features/landing';
import { FaqJsonLd } from '../components/seo/FaqJsonLd';
import { RelatedTools } from '../components/seo/RelatedTools';

/** Crawlable intent page; the app itself remains client-side. */
export default function KundliMatching(): ReactElement {
  return (
    <div className="min-h-screen bg-observatory font-sans text-text-primary antialiased">
      <LandingNav />
      <main className="mx-auto max-w-3xl px-5 py-24">
        <p className="text-sm uppercase tracking-widest text-text-muted">Vedic astrology · Gun Milan · 100% Free</p>
        <h1 className="mt-3 text-4xl font-semibold sm:text-5xl">Free Kundli Matching (Ashtakoot 36 Gun Milan)</h1>
        <p className="mt-5 text-lg text-text-secondary">
          Compare two Vedic birth charts (Janam Kundali Milan) with 100% free Ashtakoot 36 Gun Milan compatibility.
          AlmaMesh computes Rashi, Nakshatra, Graha Maitri, Gana, Bhakoot, Nadi, and synastry directly on
          your own device. Free forever: no login, no phone number, no upload, no server.
        </p>
        <h2 className="mt-10 text-2xl font-semibold">What the free Kundli Matching report includes</h2>
        <ul className="mt-4 space-y-3 text-text-secondary">
          <li><strong>Ashtakoot 36 Gun Milan factors:</strong> Varna, Vashya, Tara, Yoni, Graha Maitri, Gana, Bhakoot, and Nadi kuta compatibility.</li>
          <li><strong>Chandra Rashi &amp; Janma Nakshatra:</strong> Moon sign and birth star comparison across all 27 lunar mansions with pada.</li>
          <li><strong>Vimshottari Dasha alignment:</strong> running Mahadasha and Antardasha periods for both charts.</li>
          <li><strong>Divisional charts:</strong> Rashi (D1) and Navamsa (D9) marriage and dharma comparison.</li>
          <li><strong>Plain-language reading:</strong> relationship strengths and areas of care, without fatalism or fear-mongering.</li>
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
          Generate my free birth chart
        </Link>
        <p className="mt-4 text-sm text-text-muted">
          Astrology is offered for reflection, not as medical, legal, or financial advice.
        </p>
        <p className="mt-4 flex flex-wrap gap-4 text-sm">
          <a href="/hi/kundli-matching/" lang="hi" className="text-accent-gold-bright underline">हिन्दी में पढ़ें</a>
          <a href="/es/kundli-matching/" lang="es" className="text-accent-gold-bright underline">Leer en Español</a>
          <a href="/pt/kundli-matching/" lang="pt" className="text-accent-gold-bright underline">Ler em Português</a>
        </p>
        <section className="mt-10"><h2 className="text-2xl font-semibold">Frequently asked questions</h2><dl className="mt-4 space-y-4 text-text-secondary"><div><dt className="font-medium text-text-primary">What is kundli matching?</dt><dd>Kundli matching compares two birth charts using traditional factors such as rashi, nakshatra, and graha maitri.</dd></div><div><dt className="font-medium text-text-primary">Is it a decision-maker?</dt><dd>No. It is a traditional compatibility framework for reflection, not a substitute for your judgment.</dd></div></dl></section>
        <FaqJsonLd items={[{question: 'What is kundli matching?', answer: 'Kundli matching compares two birth charts using traditional factors such as rashi, nakshatra, and graha maitri.'}, {question: 'Is it a decision-maker?', answer: 'No. It is a traditional compatibility framework for reflection, not a substitute for your judgment.'}]} />
        <RelatedTools />
      </main>
      <LandingFooter />
    </div>
  );
}
