import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import i18n from '../../../../i18n/config';
import { TravelOffer } from '../TravelOffer';

const MAY_2019 = { kind: 'travel', asOf: { start: '2019-05-01', end: '2019-05-31', granularity: 'month' } } as const;
const BACK = { kind: 'back_to_today' } as const;

async function inLanguage(language: string) {
  await i18n.changeLanguage(language);
}

describe('TravelOffer: the quiet "Move to…?" button under an answer', () => {
  it.each([
    ['en', MAY_2019, 'Move to May 2019?'],
    ['es', MAY_2019, '¿Ir a mayo de 2019?'],
    ['pt', MAY_2019, 'Ir para maio de 2019?'],
    ['en', BACK, 'Back to today?'],
    ['es', BACK, '¿Volver a hoy?'],
    ['pt', BACK, 'Voltar para hoje?'],
  ] as const)('%s says %s', async (language, action, label) => {
    await inLanguage(language);
    render(<TravelOffer action={action} language={language} onConfirm={async () => {}} />);
    expect(screen.getByRole('button', { name: label })).toBeTruthy();
  });

  it('is one real button with a 44 px target and a visible keyboard focus ring', async () => {
    await inLanguage('en');
    render(<TravelOffer action={MAY_2019} language="en" onConfirm={async () => {}} />);
    const classes = screen.getByTestId('travel-offer-button').className.split(/\s+/);
    expect(screen.getByTestId('travel-offer-button').tagName).toBe('BUTTON');
    expect(classes).toContain('min-h-11');
    expect(classes.some((c) => c.startsWith('focus-visible:'))).toBe(true);
  });

  it('a tap confirms once, and the button waits while it saves', async () => {
    await inLanguage('en');
    let finish!: () => void;
    const onConfirm = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<TravelOffer action={MAY_2019} language="en" onConfirm={onConfirm} />);
    const button = screen.getByTestId('travel-offer-button');
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    finish();
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  });

  it('says so when the move could not be saved, and the button stays', async () => {
    await inLanguage('en');
    render(<TravelOffer action={MAY_2019} language="en" onConfirm={async () => { throw new Error('disk full'); }} />);
    fireEvent.click(screen.getByTestId('travel-offer-button'));
    expect((await screen.findByRole('alert')).textContent).toBe("Couldn't save this on your device. Try again.");
    expect(screen.getByTestId('travel-offer-button')).toBeTruthy();
  });
});
