/**
 * Does the user's message ask to MOVE this conversation (a time-travel trip, or back to today)?
 * The travel tool refuses a call on a turn that did not (travelTool.ts): a question about another
 * time, today included, is answered in place with read_period. dashboard.agentic.real 2026-10-15:
 * GPT Luna read today on "outlook today?" in a September 2017 trip, then travelled back to today.
 *
 * Explicit requests only, in the three app languages, matched with accents dropped:
 *  - a move verb in command position ("take me to", "go back to", "let's go to", "can we go to",
 *    "llévame a", "vamos a", "volvamos a", "me leve para", "voltemos para") with a time;
 *  - leaving a trip ("leave this trip", "back to today", "get me out of here", "salir de este
 *    viaje", "sair desta viagem").
 * A verb after a subject or an auxiliary ("Did I go to", "Should I travel to", "Vou viajar para")
 * is the user's own life, not a request. A miss costs a refused call the model is told about.
 */
import type { ChatMessage } from '@almamesh/shared-types';

/** Lower case, accents dropped, curly apostrophes straightened: "Lléveme" and "Lleveme" read alike. */
function plain(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').replace(/[’‘]/g, "'").toLowerCase();
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
  'janeiro', 'fevereiro', 'marco', 'maio', 'junho', 'julho', 'setembro', 'outubro', 'novembro', 'dezembro',
].join('|');

/** A time a move can go to: a year, a month, or today. */
const TIME = `(?:\\d{4}|${MONTHS}|today|now|the present|hoy|ahora|(?:el )?presente|hoje|agora|(?:o )?presente)`;

/** Command position: the start of a clause, a polite lead-in, or "let's". */
const LEAD = String.raw`(?:^|[.!?;:,¿¡]\s*|\b(?:and|then|now|so|ok|okay|please|y|e|entonces|entao|por favor)\s+)` +
  String.raw`(?:(?:please|can you|could you|would you|will you|can we|could we|shall we|let's|lets|let us|puedes|podemos|pode|podemos)\s+)?`;

const EN_VERB = String.raw`(?:(?:take|bring|send|get) (?:me|us)|go|jump|travel|time[- ]?travel|return|head|come|move)(?: back)?`;
/** "Let's go" forms and "take me": a place may come before the time ("vamos a Madrid en 2019"). */
const ES_PT_LETS = String.raw`(?:(?:me|nos) (?:lleva|llevas|lleve|leva|levas|leve)|vamos|vayamos|volvamos|regresemos|viajemos|voltemos|regressemos)`;
/** Single-person commands: the time comes first, since "viaje a Madrid en 2019" is also "viajé" with its accent dropped. */
const ES_PT_ONE = String.raw`(?:ir|ve|vaya|volver|vuelve|vuelva|regresar|regresa|regrese|viajar|viaja|viaje|voltar|volta|volte|regressar|regressa|regresse)`;
const WANT = String.raw`\b(?:(?:i|we)(?: want| wanna| would like|'d like| need)(?: to)?|quiero|queremos|quisiera|quero|queria) ` +
  String.raw`(?:go|travel|jump|return|head|move|ir|volver|regresar|viajar|voltar|regressar)(?: back)?`;
const PREP = String.raw`(?:to|a|al|hasta|hacia|para|pra|ao|ate)`;
/** The time right after the preposition: "a 2019", "al año 2019", "para março". */
const NEXT_TIME = String.raw` ${PREP} (?:el |o |the )?(?:ano |year )?${TIME}\b`;
/** Or a place, then the time: "a Madrid en 2019", never "a ver mi carrera en 2019". */
const PLACE_TIME = String.raw` ${PREP} (?!\w+(?:ar|er|ir)\b)[\w-]+(?: [\w-]+){0,2} (?:en|em|in) ${TIME}\b`;
/** Imperatives with the pronoun attached: only ever a request. */
const ATTACHED = String.raw`\b(?:llevame|llevanos|lleveme|llevenos|llevadme|leve-me|leva-me|leve-nos|leva-nos)\b`;

/** A move with a time: "take me to May 2019", "llévame al 2019", "voltemos para 2019". */
const MOVE_WITH_TIME: readonly RegExp[] = [
  new RegExp(`${LEAD}${EN_VERB} to\\b.*\\b${TIME}\\b`),
  new RegExp(`${LEAD}${ES_PT_LETS}(?:${NEXT_TIME}|${PLACE_TIME})`),
  new RegExp(`${LEAD}${ES_PT_ONE}${NEXT_TIME}`),
  new RegExp(`${WANT}${NEXT_TIME}`),
  new RegExp(`${ATTACHED} ${PREP}\\b.*\\b${TIME}\\b`),
  new RegExp(`\\btime[- ]?travel\\b.*\\b${TIME}\\b`),
  new RegExp(`\\bmove (?:this|the) (?:chat|conversation|thread)\\b.*\\b${TIME}\\b`),
];

/** Leaving the trip needs no time: it goes back to today. */
const LEAVE_TRIP: readonly RegExp[] = [
  /\bback to (?:today|now|the present)\b/,
  /\b(?:leave|exit|end|quit|close|stop)(?: this| the| my)? (?:trip|time[- ]?travel)\b/,
  /\bget (?:me|us) out of (?:here|this trip|the trip)\b/,
  new RegExp(`\\b(?:i'm|i am|im|we're|we are) done with (?:this trip|the trip|${TIME}\\b)`),
  /\b(?:salir|sal|salgamos|terminar|termina|terminemos|termine|acabar|acaba|cerrar|cierra|dejar|deja|dejemos)(?: de| del)?(?: este| el| mi| esta)? viaje\b/,
  /\b(?:sacame|sacanos) de aqui\b/,
  new RegExp(`\\btermine con ${TIME}\\b`),
  /\b(?:sair|saia|saiamos|encerrar|encerre|encerra|terminar|termine|termina|acabar|fechar|feche)(?: da| de| dessa| desta| dessa)?(?: esta| essa| a| minha)? viagem\b/,
  /\b(?:me tira|me tire|tira-me|tire-me) daqui\b/,
  new RegExp(`\\bterminei com ${TIME}\\b`),
];

/** A move with no time yet ("take me to Delhi"): the model asks when, and the answer finishes it. */
const MOVE_WITHOUT_TIME: readonly RegExp[] = [
  new RegExp(`${LEAD}(?:(?:take|bring|send) (?:me|us)|time[- ]?travel)(?: back)? to\\b`),
  new RegExp(`${ATTACHED} ${PREP}\\b`),
  new RegExp(`${LEAD}(?:me|nos) (?:lleva|llevas|lleve|leva|levas|leve) ${PREP}\\b`),
];

const matches = (patterns: readonly RegExp[], text: string) => patterns.some((pattern) => pattern.test(text));

export function asksToTravel(question: string): boolean {
  const text = plain(question);
  return matches(MOVE_WITH_TIME, text) || matches(LEAVE_TRIP, text);
}

/**
 * A move the user asked for on the last turn that has not happened: the model asked where (or
 * when) instead. The answer to that question ("Delhi") names no move, so this turn may finish it.
 * Read from the thread's own saved messages; it expires after one user turn.
 */
export interface PendingTravel {
  readonly kind: 'pending_travel';
  /** The user's message that asked to move. */
  readonly request: string;
}

/** The travel tool's typed result status for a queued move (travelTool.ts TravelQueued). */
function moveQueued(message: ChatMessage): boolean {
  return (message.parts ?? []).some((part) =>
    part.type === 'tool-call' && part.toolName === 'travel' && (part.result as { status?: unknown } | undefined)?.status === 'queued');
}

/** The pending move, when the thread ends on an answer to a move request that queued no move. */
export function pendingTravelIn(messages: readonly ChatMessage[]): PendingTravel | undefined {
  const answer = messages.at(-1);
  const asked = messages.at(-2);
  if (answer?.role !== 'assistant' || answer.error || asked?.role !== 'user' || moveQueued(answer)) return undefined;
  const request = asked.content;
  return asksToTravel(request) || matches(MOVE_WITHOUT_TIME, plain(request)) ? { kind: 'pending_travel', request } : undefined;
}

/**
 * An answer that says this conversation moved: "We've stepped out of September 2017", "You're off
 * the trip and back to today". Checked only on a turn where no move was queued (chatTurn.ts):
 * DeepSeek v4.1 flash said so in 3 of 20 runs while the trip stayed put (travel-guard-live 2026-10-15).
 * Telling the user how to move ("say 'back to today'") is not a claim.
 */
const MOVE_CLAIMS: readonly RegExp[] = [
  /\b(?:we've|we have|i've|i have|you've|you have) (?:now |just )?(?:left|stepped out of|exited|ended|returned|come back|moved|travell?ed|gone back|taken you|brought you)\b/,
  /\b(?:you're|you are|we're|we are) (?:now |all )?(?:back (?:to|in) (?:today|the present|now)\b|off (?:the|this|your) .{0,40}trip\b|out of (?:the|this|your) .{0,40}trip\b|no longer (?:in|on) )/,
  /\b(?:the|this|your) trip (?:has|is) (?:now )?(?:ended|over|closed|done)\b/,
  /\b(?:this|the) (?:conversation|chat|thread) (?:has |is )?(?:now )?moved\b/,
  /\bwelcome back to (?:today|the present)\b/,
  /\b(?:hemos|he) (?:salido|vuelto|regresado|viajado|terminado)\b/,
  /\b(?:estamos|estas|esta) de (?:vuelta|regreso)\b/,
  /\b(?:ya no estamos en|volvimos a|regresamos a|salimos del viaje)\b/,
  /\b(?:saimos da|voltamos para|voltamos a|encerramos a viagem|ja nao estamos em)\b/,
  /\b(?:estamos|esta|voce esta) de volta\b/,
];

export function claimsMove(answer: string): boolean {
  return matches(MOVE_CLAIMS, plain(answer));
}
