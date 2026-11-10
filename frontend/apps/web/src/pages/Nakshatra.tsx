import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { LandingFooter, LandingNav } from '../components/features/landing';
import { FaqJsonLd } from '../components/seo/FaqJsonLd';
import { RelatedTools } from '../components/seo/RelatedTools';

/** Crawlable intent page; the app itself remains client-side. */
export default function Nakshatra(): ReactElement {
  return (
    <div className="min-h-screen bg-observatory font-sans text-text-primary antialiased">
      <LandingNav />
      <main className="mx-auto max-w-3xl px-5 py-24">
        <p className="text-sm uppercase tracking-widest text-text-muted">Vedic astrology · Janma Nakshatra · 100% Free</p>
        <h1 className="mt-3 text-4xl font-semibold sm:text-5xl">Free Nakshatra &amp; Pada Calculator</h1>
        <p className="mt-5 text-lg text-text-secondary">
          Find your 100% free Janma Nakshatra (birth star), Pada (1–4), and Chandra Rashi (Moon sign) from your birth date, time, and place.
          AlmaMesh computes the sidereal Moon longitude using the Lahiri ayanamsha directly on
          your own device. Free forever: no account, no upload, no server.
        </p>
        <h2 className="mt-10 text-2xl font-semibold">What the free Nakshatra report includes</h2>
        <ul className="mt-4 space-y-3 text-text-secondary">
          <li><strong>Janma Nakshatra &amp; Pada:</strong> your exact birth star across the 27 lunar mansions, with pada (1–4), ruling Graha, and deity.</li>
          <li><strong>Chandra Rashi &amp; Lagna:</strong> sidereal Moon sign and rising sign using the Chitrapaksha Lahiri ayanamsha.</li>
          <li><strong>Starting Vimshottari Dasha:</strong> your birth Mahadasha lord and full Antardasha timeline derived from Moon longitude.</li>
          <li><strong>Divisional charts:</strong> Rashi (D1) and Navamsa (D9) pada placement.</li>
          <li><strong>Plain-language reading:</strong> strengths and tensions, without fatalism or fear.</li>
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
          <a href="/hi/nakshatra/" lang="hi" className="text-accent-gold-bright underline">हिन्दी में पढ़ें</a>
          <a href="/es/nakshatra/" lang="es" className="text-accent-gold-bright underline">Leer en Español</a>
          <a href="/pt/nakshatra/" lang="pt" className="text-accent-gold-bright underline">Ler em Português</a>
        </p>
        <section className="mt-10"><h2 className="text-2xl font-semibold">Frequently asked questions</h2><dl className="mt-4 space-y-4 text-text-secondary"><div><dt className="font-medium text-text-primary">What is a nakshatra?</dt><dd>A nakshatra is one of the 27 lunar mansions in Vedic astrology. Your birth nakshatra is the mansion the Moon occupied at birth.</dd></div><div><dt className="font-medium text-text-primary">Can I find my pada?</dt><dd>Yes. The page reports the nakshatra and its pada, along with the ruling planet.</dd></div></dl></section>
        <FaqJsonLd items={[{question: 'What is a nakshatra?', answer: 'A nakshatra is one of the 27 lunar mansions in Vedic astrology. Your birth nakshatra is the mansion the Moon occupied at birth.'}, {question: 'Can I find my pada?', answer: 'Yes. The page reports the nakshatra and its pada, along with the ruling planet.'}]} />
        <RelatedTools />
      </main>
      <LandingFooter />
    </div>
  );
}
