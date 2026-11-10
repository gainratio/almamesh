import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { LandingFooter, LandingNav } from '../components/features/landing';
import { FaqJsonLd } from '../components/seo/FaqJsonLd';
import { RelatedTools } from '../components/seo/RelatedTools';

/** Crawlable intent page; the app itself remains client-side. */
export default function Muhurta(): ReactElement {
  return (
    <div className="min-h-screen bg-observatory font-sans text-text-primary antialiased">
      <LandingNav />
      <main className="mx-auto max-w-3xl px-5 py-24">
        <p className="text-sm uppercase tracking-widest text-text-muted">Vedic astrology · Shubh Muhurta &amp; Panchang · 100% Free</p>
        <h1 className="mt-3 text-4xl font-semibold sm:text-5xl">Free Shubh Muhurta &amp; Vedic Panchang Calculator</h1>
        <p className="mt-5 text-lg text-text-secondary">
          Find a 100% free auspicious Shubh Muhurta for Vivah (marriage), Griha Pravesh, business launch, or travel using Vedic Panchang and your Janam Kundali.
          AlmaMesh computes Nakshatra, Tithi, Vara, and transit alignment on
          your own device. Free forever: no account, no upload, no server.
        </p>
        <h2 className="mt-10 text-2xl font-semibold">What the free Shubh Muhurta report includes</h2>
        <ul className="mt-4 space-y-3 text-text-secondary">
          <li><strong>Panchang &amp; auspicious windows:</strong> Nakshatra, Tithi (lunar day), and Vara (weekday) suitability with planetary periods.</li>
          <li><strong>Tara Bala &amp; Chandra Bala:</strong> alignment between transit Moon/Nakshatra and your birth Janma Nakshatra and Rashi.</li>
          <li><strong>Vimshottari Dasha context:</strong> how daily windows align with your running Mahadasha and Antardasha.</li>
          <li><strong>Divisional charts:</strong> D1 and standard varga charts supported by the open-source engine.</li>
          <li><strong>Plain-language reading:</strong> practical timing guidance without fatalism or fear.</li>
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
          <a href="/hi/muhurta/" lang="hi" className="text-accent-gold-bright underline">हिन्दी में पढ़ें</a>
          <a href="/es/muhurta/" lang="es" className="text-accent-gold-bright underline">Leer en Español</a>
          <a href="/pt/muhurta/" lang="pt" className="text-accent-gold-bright underline">Ler em Português</a>
        </p>
        <section className="mt-10"><h2 className="text-2xl font-semibold">Frequently asked questions</h2><dl className="mt-4 space-y-4 text-text-secondary"><div><dt className="font-medium text-text-primary">What is muhurta?</dt><dd>Muhurta is the Vedic practice of choosing an auspicious time for an important activity.</dd></div><div><dt className="font-medium text-text-primary">Which factors are used?</dt><dd>The page uses nakshatra, tithi, and weekday suitability with the relevant planetary periods.</dd></div></dl></section>
        <FaqJsonLd items={[{question: 'What is muhurta?', answer: 'Muhurta is the Vedic practice of choosing an auspicious time for an important activity.'}, {question: 'Which factors are used?', answer: 'The page uses nakshatra, tithi, and weekday suitability with the relevant planetary periods.'}]} />
        <RelatedTools />
      </main>
      <LandingFooter />
    </div>
  );
}
