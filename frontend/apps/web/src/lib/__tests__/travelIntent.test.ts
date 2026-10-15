// dashboard.agentic.real 2026-10-15 (GPT Luna, the default model): in a September 2017 trip,
// "outlook today?" read today and then called travel back to today, ending the trip. A question
// about another time is answered in place; only an explicit request moves the conversation.
//
// Northstar on PR #366 (61-phrasing probe, 2026-10-15): es/pt imperative and let's-go forms were
// missed ("Llévame al 2019", "Lléveme a 2019", "viajemos a 2019"), questions about travel opened the
// gate ("Did I go to…", "Should I travel to…", "Vou viajar para…"), and a two-turn trip ("take me to
// May 2019" -> "where?" -> "Delhi") was refused on its second turn. Product call (2026-10-15):
// "leave this trip", "back to now", "get me out of here" are explicit requests too.
import type { ChatMessage, ChatMessagePart, ChatToolCallStatus } from '@almamesh/shared-types';
import { describe, expect, it } from 'vitest';

import { asksToTravel, claimsMove, isPlaceReply, MAX_INTENT_CHARS, pendingTravelIn, travelGrant } from '../travelIntent';
import { TRAVEL_NEEDS_PLACE, TRAVEL_TOOL_NAME } from '../travelTool';

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
    // Re-grade of PR #366 (2026-10-15): "take me home" leaves a trip like "back to today".
    'take me home',
    'Take me home, please.',
    'Ok, bring me back home',
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
    // Re-grade of PR #366 (2026-10-15): a relocation, a quoted instruction, or a trip in the user's
    // life opened the gate. A bare "go / move / travel to" needs the time right after it.
    'Two options: move to Lisbon in 2027, or stay. Which is better?',
    'I am torn: move to Lisbon in 2027 or stay?',
    'move to Lisbon in 2027, or stay?',
    'My boss said, go to Singapore in 2019. Was that a good call?',
    'and then travel to work got hard in 2019 — why?',
    // "take me to" a part of the reading, not a time
    'Take me to the part about marriage',
    'Can you take me to my career reading?',
    'Bring me to the 10th house details',
    'Llévame a la sección de carrera',
    'Me leva para a parte do casamento',
    // "home" as a word, not a request
    'home',
    'I went home in 2019',
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

function travelPart(result: unknown, args: Record<string, unknown> = { to: '2019-05', place: null }, status: ChatToolCallStatus = 'complete'): ChatMessagePart {
  return { type: 'tool-call', toolCallId: `c${seq}`, toolName: TRAVEL_TOOL_NAME, args, status, result };
}

const ASKED_WHERE = 'Where did you live in May 2019?';
/** The thread as saved after "take me to May 2019": travel needed a place and the model asked where. */
const askedWhere = (request = 'take me to May 2019', args: Record<string, unknown> = { to: '2019-05', place: null }) => [
  message('user', request),
  message('assistant', ASKED_WHERE, { parts: [travelPart(TRAVEL_NEEDS_PLACE, args), { type: 'text', text: ASKED_WHERE }] }),
];

// Re-grade of PR #366 (2026-10-15): pending was read from the user's text by regex, so "Take me to
// the part about marriage" or a relocation question opened the gate for the next turn, and the
// grant carried no `to`. Contract reversed: pending exists only when the last answer's travel call
// returned needs_place, and it carries that call's `to`, the only move the next turn may finish.
describe('pendingTravelIn: the travel call the last answer left waiting on a place', () => {
  it.each([
    ['take me to May 2019', { to: '2019-05', place: null }, '2019-05'],
    ['Llévame a mayo de 2019', { to: '2019-05', place: null }, '2019-05'],
    ['Me leve para março de 2019', { to: '2019-03', place: null }, '2019-03'],
    ['take me to 14 March 2019', { to: '2019-03-14', place: null }, '2019-03-14'],
  ])('%s -> needs_place: pending on exactly to %j', (request, args, to) => {
    expect(pendingTravelIn(askedWhere(request, args))).toEqual({ kind: 'pending_travel', to });
  });

  // Contract reversed 2026-10-15: these two were pending from the user's text alone.
  it('the model asked where without calling travel: nothing pending (no tool result, no grant)', () => {
    const messages = [message('user', 'Llévame a mayo de 2019'), message('assistant', '¿Dónde vivías entonces?')];
    expect(pendingTravelIn(messages)).toBeUndefined();
  });

  it('a move with a place and no time ("take me to Delhi") is no longer pending: no travel call returned needs_place', () => {
    expect(pendingTravelIn([message('user', 'Take me to Delhi'), message('assistant', 'Which year?')])).toBeUndefined();
  });

  it.each([
    'Take me to the part about marriage',
    'Can you take me to my career reading?',
    'Bring me to the 10th house details',
    'Llévame a la sección de carrera',
    'Me leva para a parte do casamento',
    'Two options: move to Lisbon in 2027, or stay. Which is better?',
    'My boss said, go to Singapore in 2019. Was that a good call?',
    'take me to May 2019',
  ])('user text alone never makes a move pending: %s', (request) => {
    expect(pendingTravelIn([message('user', request), message('assistant', 'Where would you like to go?')])).toBeUndefined();
  });

  it.each([
    ['queued', { status: 'queued', action: 'travel', period_label: 'May 2019' }],
    ['refused', { status: 'refused', reason: 'not_asked', note: 'n' }],
    ['place_not_found', { status: 'place_not_found', ask: 'a' }],
    ['outside_range', { status: 'outside_range', ask: 'a' }],
  ])('a travel call that ended %s leaves nothing pending', (_status, result) => {
    expect(pendingTravelIn([message('user', 'take me to May 2019'), message('assistant', 'ok', { parts: [travelPart(result)] })])).toBeUndefined();
  });

  it('needs_place followed by a queued move in the same answer is done: nothing pending', () => {
    const messages = [message('user', 'take me to May 2019'), message('assistant', 'Here is May 2019.', {
      parts: [travelPart(TRAVEL_NEEDS_PLACE), travelPart({ status: 'queued', action: 'travel' }, { to: '2019-05', place: 'Delhi' })],
    })];
    expect(pendingTravelIn(messages)).toBeUndefined();
  });

  it('a needs_place row whose call failed, or another tool\'s needs_place, grants nothing', () => {
    const failed = [message('user', 'take me to May 2019'), message('assistant', 'x', { parts: [travelPart(TRAVEL_NEEDS_PLACE, { to: '2019-05', place: null }, 'error')] })];
    const readPeriod: ChatMessagePart = { type: 'tool-call', toolCallId: 'r1', toolName: 'read_period', args: { to: '2019-05' }, status: 'complete', result: TRAVEL_NEEDS_PLACE };
    expect(pendingTravelIn(failed)).toBeUndefined();
    expect(pendingTravelIn([message('user', 'how was May 2019?'), message('assistant', 'x', { parts: [readPeriod] })])).toBeUndefined();
  });

  it('a needs_place row without a string `to` grants nothing', () => {
    expect(pendingTravelIn(askedWhere('take me to May 2019', { place: null }))).toBeUndefined();
  });

  it('expires after exactly one user turn', () => {
    const messages = [...askedWhere(), message('user', 'How was work?'), message('assistant', 'Work was fine.')];
    expect(pendingTravelIn(messages)).toBeUndefined();
  });

  it('a failed answer, an empty thread, or a thread ending on the user grants nothing', () => {
    const [request] = askedWhere();
    const failed = message('assistant', 'The model could not answer.', { error: true, parts: [travelPart(TRAVEL_NEEDS_PLACE)] });
    expect(pendingTravelIn([request!, failed])).toBeUndefined();
    expect(pendingTravelIn([])).toBeUndefined();
    expect(pendingTravelIn([...askedWhere(), message('user', 'Delhi')])).toBeUndefined();
  });
});

describe('isPlaceReply: the reply that finishes a pending move answers where, it does not ask something else', () => {
  it.each([
    ['Delhi', 'Delhi'],
    ['Delhi.', 'Delhi'],
    ['In Delhi, I think', 'Delhi'],
    ['Delhi?', 'Delhi'],
    ['Bogotá', 'Bogota'],
    ['vivía en Bogota', 'Bogotá'],
    ['Lisboa', 'Lisboa'],
    ['Mumbai, then. What did that month hold?', 'Mumbai'],
    ['Bombay', 'Mumbai'],
  ])('%j with place %j is a place answer', (reply, place) => {
    expect(isPlaceReply(reply, place)).toBe(true);
  });

  it.each([
    ["actually, what's my moon sign?", 'Lisbon'],
    ['what about my career?', 'Delhi'],
    ['¿y mi carrera?', 'Madrid'],
    ['e a minha carreira?', 'Lisboa'],
    ['¿Cuál es mi signo lunar?  ', 'Madrid'],
  ])('%j ends in a question that does not name %j: not a place answer', (reply, place) => {
    expect(isPlaceReply(reply, place)).toBe(false);
  });
});

describe('travelGrant: what this turn may do with travel', () => {
  const pending = { kind: 'pending_travel', to: '2019-05' } as const;

  it('a message that asks to move grants any move, pending or not', () => {
    expect(travelGrant('take me to 1990 in Lisbon', undefined)).toEqual({ kind: 'asked' });
    expect(travelGrant('back to today', pending)).toEqual({ kind: 'asked' });
  });

  it('a reply to a pending move grants only that move, with the reply to check the place against', () => {
    expect(travelGrant('Delhi', pending)).toEqual({ kind: 'finish', to: '2019-05', reply: 'Delhi' });
  });

  it('no request and nothing pending grants nothing', () => {
    expect(travelGrant('Delhi', undefined)).toEqual({ kind: 'none' });
    expect(travelGrant('Take me to the part about marriage', undefined)).toEqual({ kind: 'none' });
  });
});

describe('asksToTravel: a long message is read only up to its cap', () => {
  it('pins the cap to its literal', () => {
    expect(MAX_INTENT_CHARS).toBe(500);
  });

  // Re-grade of PR #366 (2026-10-15): "go to " repeated to 80k characters took 4.7 s (quadratic regex).
  it.each([
    ['go to ', 80_000],
    ['take me to x ', 80_000],
    ['vamos a w ', 80_000],
  ])('%j repeated to %i characters is read in well under a second', (unit, length) => {
    const text = unit.repeat(Math.ceil(length / unit.length));
    const started = performance.now();
    asksToTravel(text);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it('a request inside the cap is read; one cut by it is not (a miss costs a refused call)', () => {
    const request = '. take me to 2019';
    const filler = 'x'.repeat(MAX_INTENT_CHARS - request.length);
    expect(asksToTravel(`${filler}${request}`)).toBe(true);
    expect(asksToTravel(`x${filler}${request}`)).toBe(false);
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
