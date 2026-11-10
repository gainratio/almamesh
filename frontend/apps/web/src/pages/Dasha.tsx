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
        <p className="text-sm uppercase tracking-widest text-text-muted">Vedic astrology · Vimshottari Dasha · 100% Free</p>
        <h1 className="mt-3 text-4xl font-semibold sm:text-5xl">Free Vimshottari Dasha Calculator (Mahadasha &amp; Antardasha)</h1>
        <p className="mt-5 text-lg text-text-secondary">
          Calculate your 100% free 120-year Vimshottari Dasha timeline — Mahadasha and Antardasha (Bhukti) planetary periods — from your birth date, time, and place.
          AlmaMesh computes your exact sidereal Moon Nakshatra balance on
          your own device. Free forever: no account, no upload, no server.
        </p>
        <h2 className="mt-10 text-2xl font-semibold">What the free Vimshottari Dasha report includes</h2>
        <ul className="mt-4 space-y-3 text-text-secondary">
          <li><strong>Complete 120-year Vimshottari timeline:</strong> Mahadasha and Antardasha (Bhukti) periods with exact start and end dates.</li>
          <li><strong>Janma Nakshatra balance:</strong> initial Dasha balance computed from your sidereal Moon degree (Lahiri ayanamsha).</li>
          <li><strong>Current running Dasha:</strong> active Mahadasha and Antardasha lord with house lordship in your Janam Kundali.</li>
          <li><strong>Divisional charts:</strong> Rashi (D1) and Navamsa (D9) placements of each Dasha lord.</li>
          <li><strong>Plain-language reading:</strong> themes of each planetary period, without fatalism or fear.</li>
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
          <a href="/hi/dasha/" lang="hi" className="text-accent-gold-bright underline">हिन्दी में पढ़ें</a>
          <a href="/es/dasha/" lang="es" className="text-accent-gold-bright underline">Leer en Español</a>
          <a href="/pt/dasha/" lang="pt" className="text-accent-gold-bright underline">Ler em Português</a>
        </p>
        <section className="mt-10"><h2 className="text-2xl font-semibold">Frequently asked questions</h2><dl className="mt-4 space-y-4 text-text-secondary"><div><dt className="font-medium text-text-primary">What is Vimshottari dasha?</dt><dd>It is the 120-year planetary period system used in Vedic astrology, divided into mahadasha and antardasha periods.</dd></div><div><dt className="font-medium text-text-primary">Can I use it offline?</dt><dd>Yes. After the first load, the calculation runs in your browser and works offline.</dd></div></dl></section>
        <FaqJsonLd items={[{question: 'What is Vimshottari dasha?', answer: 'It is the 120-year planetary period system used in Vedic astrology, divided into mahadasha and antardasha periods.'}, {question: 'Can I use it offline?', answer: 'Yes. After the first load, the calculation runs in your browser and works offline.'}]} />
        <RelatedTools />
      </main>
      <LandingFooter />
    </div>
  );
}
