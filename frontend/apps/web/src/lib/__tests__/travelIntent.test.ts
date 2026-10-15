// dashboard.agentic.real 2026-10-15 (GPT Luna, the default model): in a September 2017 trip,
// "outlook today?" read today and then called travel back to today, ending the trip. A question
// about another time is answered in place; only an explicit request moves the conversation.
import { describe, expect, it } from 'vitest';

import { asksToTravel } from '../travelIntent';

describe('asksToTravel', () => {
  it.each([
    'Take me to September 2017 in Mumbai',
    'Take me to March 14, 2019 in Bogotá and show that day.',
    'take me back to May 2019',
    'Back to today, please.',
    'Back to today. Call travel with to "today" and place null.',
    'Can we go back to today?',
    'Go to 2019 in Pune',
    'Travel to June 2030',
    'Time travel to 2015',
    'Return to today',
    'Move this conversation to May 2019',
    'Llévame a mayo de 2019 en Pune',
    'Volver a hoy',
    'Me leve para maio de 2019',
    'Voltar para hoje',
  ])('an explicit request to move: %s', (question) => {
    expect(asksToTravel(question)).toBe(true);
  });

  it.each([
    'outlook today? Answer with kind "period".',
    'What planetary influences matter most for me today?',
    'What did September 2019 look like for me?',
    'How do 2027 and the first half of 2028 look for me?',
    'How was work?',
    'And next month?',
    'How did things go today?',
    'What happens when Saturn goes to Aries?',
    '¿Cómo me va hoy?',
    'Como foi setembro de 2019 para mim?',
  ])('a question about a time, answered in place: %s', (question) => {
    expect(asksToTravel(question)).toBe(false);
  });
});
