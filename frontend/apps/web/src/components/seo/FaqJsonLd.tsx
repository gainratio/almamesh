import type { ReactElement } from 'react';

export interface FaqItem {
  readonly question: string;
  readonly answer: string;
}

/** Emit FAQPage JSON-LD for FAQ content rendered on the page. */
export function FaqJsonLd({ items }: { readonly items: readonly FaqItem[] }): ReactElement {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer },
    })),
  };
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}
