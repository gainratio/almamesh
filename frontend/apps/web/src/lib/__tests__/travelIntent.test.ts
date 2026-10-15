// dashboard.agentic.real 2026-10-15 (GPT Luna, the default model): in a September 2017 trip,
// "outlook today?" read today and then called travel back to today, ending the trip. A question
// about another time is answered in place; only an explicit request moves the conversation.
//
// Northstar on PR #366 (61-phrasing probe, 2026-10-15): es/pt imperative and let's-go forms were
// missed ("Llévame al 2019", "Lléveme a 2019", "viajemos a 2019"), questions about travel opened the
// gate ("Did I go to…", "Should I travel to…", "Vou viajar para…"), and a two-turn trip ("take me to
// May 2019" -> "where?" -> "Delhi") was refused on its second turn. Product call (2026-10-15):
// "leave this trip", "back to now", "get me out of here" are explicit requests too.
import type { ChatMessage, ChatMessagePart } from '@almamesh/shared-types';
import { describe, expect, it } from 'vitest';

import { asksToTravel, claimsMove, pendingTravelIn } from '../travelIntent';

/** Every request is checked as typed and with its accents dropped (phone keyboards often do). */
const stripped = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '');

describe('asksToTravel: an explicit request to move', () => {
  it.each([
    // en
    'Take me to September 2017 in Mumbai',
    'Take me to March 14, 2019 in Bogotá and show that day.',
    'take me back to May 2019',
    'take me to 2019',
    'Take me back to 2019',
    'go back to May 2019',
    'Go to 2019 in Pune',
    'go to 2019 in Delhi',
    'Travel to June 2030',
    'Time travel to 2015',
    "Let's go to 2019",
    'Let’s go back to May 2019',
    'Can you take me to May 2019?',
    'Please take me to May 2019',
    'Could we go back to 2019?',
    'I want to go back to 2019',
    "I'd like to travel to March 2019",
    'Move this conversation to May 2019',
    // en: back to today, leaving a trip
    'Back to today, please.',
    'Back to today. Call travel with to "today" and place null.',
    'back to today',
    'Can we go back to today?',
    'Return to today',
    'back to now',
    'leave this trip',
    'Exit this trip',
    'Exit the trip, please',
    'End this trip',
    "I'm done with September 2017",
    "I'm done with September 2017. Leave this trip and tell me my outlook today.",
    'get me out of here',
    'Get me out of this trip',
    // es
    'Llévame a mayo de 2019 en Pune',
    'llévame a 2019',
    'llévame a mayo de 2019',
    'Llévame al 2019',
    'llévame a marzo',
    'LLÉVAME A 2019',
    'Llévame a 2019 en Bogotá',
    'Llévanos a Madrid en 2019',
    'Lléveme a 2019',
    'Me lleva a 2019',
    '¿Me llevas a 2019?',
    'vamos a 2019',
    'Vamos a Madrid en 2019',
    'Viajemos a 2019',
    'regresemos a 2019',
    'volvamos a 2019',
    'regresa a 2019',
    'Regrese a 2019',
    'viaja a 2019 en Madrid',
    'Viaja al año 2019',
    'Quiero viajar a 2019',
    'Quiero volver a 2019',
    'Volver a hoy',
    'Vuelve a hoy',
    'Volver al presente',
    'Salgamos de este viaje',
    'Salir de este viaje',
    'Sal de este viaje',
    'Termina este viaje',
    'Sácame de aquí',
    'Ya terminé con septiembre de 2017',
    // pt
    'Me leve para maio de 2019',
    'me leva para 2019',
    'Me leva para 2019 em Lisboa',
    'Me leve para março de 2019',
    'me leve para março',
    'leve-me a 2019',
    'leva-me para 2019',
    'Leve-nos para 2019',
    'vamos para 2019',
    'Vamos para Lisboa em 2019',
    'Viajemos para 2019',
    'voltemos para 2019',
    'volta para 2019',
    'viaje para 2019 em Lisboa',
    'Quero viajar para 2019',
    'Voltar para hoje',
    'volta para hoje',
    'Volte para hoje',
    'Voltar para o presente',
    'Sair desta viagem',
    'Saia dessa viagem',
    'Encerre esta viagem',
    'Me tira daqui',
    'Tire-me daqui',
    'Já terminei com setembro de 2017',
  ])('%s', (question) => {
    expect(asksToTravel(question)).toBe(true);
    expect(asksToTravel(stripped(question))).toBe(true);
  });
});

describe('asksToTravel: a question about a time or about travel is answered in place', () => {
  it.each([
    'outlook today? Answer with kind "period".',
    'outlook today?',
    'What planetary influences matter most for me today?',
    'What did September 2019 look like for me?',
    'How do 2027 and the first half of 2028 look for me?',
    'How was 2019 for me?',
    'How was work?',
    'And next month?',
    'How did things go today?',
    'What happens when Saturn goes to Aries?',
    'what was happening when I lived in Delhi in 2019',
    'show me 2019',
    // narrative and questions about a trip in the user's life, not a move of this conversation
    'I travelled to Paris in 2019',
    'I traveled to Paris in 2019',
    'Did I go to Delhi in 2019?',
    'Did I travel back to India in 2019?',
    'I want to go to India in 2019 for work, was that good?',
    'Should I travel to Japan in May?',
    'When should I go back to Delhi in 2027?',
    'Will I return to Mumbai in 2027?',
    'Will I go to Japan in May?',
    'Can I travel to Japan in May 2027?',
    'Is it a good time to go to Delhi in 2027?',
    'My mom used to take me to school in 1995',
    'I return to work today',
    "I'm done with work today",
    'Should I leave my job in 2027?',
    'How do I get out of debt in 2027?',
    // es
    '¿Cómo me va hoy?',
    '¿cómo fue mi 2019?',
    'quiero ver 2019',
    'viajé a Madrid',
    'viajé a Madrid en 2019',
    '¿Viajé a Madrid en 2019?',
    'Vamos a ver mi carrera en 2019',
    'Vamos a hablar de 2019',
    '¿Debo ir a Madrid en mayo?',
    '¿Voy a viajar a Madrid en mayo?',
    // pt
    'Como foi setembro de 2019 para mim?',
    'quero ver 2019',
    'viajei para Lisboa',
    'viajei para Lisboa em 2019',
    'Voltei para Lisboa em 2019',
    'Vou viajar para Lisboa em maio, é bom?',
    'Quando vou para Lisboa em 2027?',
    'Vamos ver minha carreira em 2019',
    'Vamos falar de 2019',
  ])('%s', (question) => {
    expect(asksToTravel(question)).toBe(false);
    expect(asksToTravel(stripped(question))).toBe(false);
  });
});

let seq = 0;
function message(role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  seq += 1;
  return { id: `m${seq}`, thread_id: 't1', role, content, created_at: '2026-10-15T00:00:00Z', ...extra };
}

function travelPart(result: unknown): ChatMessagePart {
  return { type: 'tool-call', toolCallId: `c${seq}`, toolName: 'travel', args: { to: '2019-05', place: null }, status: 'complete', result };
}

const ASKED_WHERE = 'Where did you live in May 2019?';

describe('pendingTravelIn: a move the user asked for last turn that is still waiting on them', () => {
  it('the model asked where after a travel call that needed a place: the next turn may finish the move', () => {
    const messages = [
      message('user', 'take me to May 2019'),
      message('assistant', ASKED_WHERE, { parts: [travelPart({ status: 'needs_place', ask: 'Ask where the user lived (or will be) then.' }), { type: 'text', text: ASKED_WHERE }] }),
    ];
    expect(pendingTravelIn(messages)).toEqual({ kind: 'pending_travel', request: 'take me to May 2019' });
  });

  it('the model asked where without calling travel: still pending', () => {
    const messages = [message('user', 'Llévame a mayo de 2019'), message('assistant', '¿Dónde vivías entonces?')];
    expect(pendingTravelIn(messages)).toEqual({ kind: 'pending_travel', request: 'Llévame a mayo de 2019' });
  });

  it('a move with a place and no time yet ("take me to Delhi") is pending: the model asks when', () => {
    const messages = [message('user', 'Take me to Delhi'), message('assistant', 'Which year?')];
    expect(pendingTravelIn(messages)).toEqual({ kind: 'pending_travel', request: 'Take me to Delhi' });
  });

  it('a move that was queued is done: nothing pending', () => {
    const messages = [
      message('user', 'take me to May 2019 in Delhi'),
      message('assistant', 'Here is May 2019.', { parts: [travelPart({ status: 'queued', action: 'travel', period_label: 'May 2019' })] }),
    ];
    expect(pendingTravelIn(messages)).toBeUndefined();
  });

  it('expires after one user turn: the request two turns back opens nothing', () => {
    const messages = [
      message('user', 'take me to May 2019'),
      message('assistant', ASKED_WHERE),
      message('user', 'How was work?'),
      message('assistant', 'Work was fine.'),
    ];
    expect(pendingTravelIn(messages)).toBeUndefined();
  });

  it('a question (no move asked) leaves nothing pending', () => {
    expect(pendingTravelIn([message('user', 'outlook today?'), message('assistant', 'Calm.')])).toBeUndefined();
  });

  it('a failed answer is no question asked back: nothing pending', () => {
    const messages = [message('user', 'take me to May 2019'), message('assistant', 'The model could not answer.', { error: true })];
    expect(pendingTravelIn(messages)).toBeUndefined();
  });

  it('an empty thread, or one whose last message is the user\'s, has nothing pending', () => {
    expect(pendingTravelIn([])).toBeUndefined();
    expect(pendingTravelIn([message('user', 'take me to May 2019')])).toBeUndefined();
  });
});

describe('claimsMove: an answer that says the conversation moved', () => {
  // DeepSeek v4.1 flash, travel-guard-live 2026-10-15: 3 of 20 runs said this while the trip stayed put.
  it.each([
    "We've stepped out of September 2017 — here's today.",
    "You're off the September 2017 trip and back to today: Thursday, 15 October 2026.",
    'We have left the September 2017 trip.',
    "I've taken you back to today.",
    "You're back in the present.",
    'We are now back to today.',
    'The trip has ended; here is today.',
    'This conversation has moved to today.',
    'Welcome back to today!',
    'Hemos salido del viaje a septiembre de 2017.',
    'Ya estamos de vuelta en hoy.',
    'Saímos da viagem de setembro de 2017.',
    'Estamos de volta a hoje.',
  ])('%s', (answer) => {
    expect(claimsMove(answer)).toBe(true);
  });

  it.each([
    'Today sits inside your long Rahu chapter that September 2017 opened.',
    'This conversation stays in September 2017. To go back to today, use the Time travel control or say "back to today".',
    'If you want to leave this trip, say "back to today".',
    'Back in September 2017, Rahu was already running.',
    'You travelled to Paris back then.',
    'Para volver a hoy, di "volver a hoy".',
    'Para voltar para hoje, diga "voltar para hoje".',
  ])('not a claim: %s', (answer) => {
    expect(claimsMove(answer)).toBe(false);
  });
});
