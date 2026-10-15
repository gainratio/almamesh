/**
 * Does the user's message ask to MOVE this conversation (a time-travel trip, or back to today)?
 * The travel tool refuses a call on a turn that did not (travelTool.ts): a question about another
 * time, today included, is answered in place with read_period. dashboard.agentic.real 2026-10-15:
 * GPT Luna read today on "outlook today?" in a September 2017 trip, then travelled back to today.
 *
 * Explicit requests only, in the three app languages: "take me to", "go (back) to", "travel to",
 * "time travel", "move this conversation to", "back to today"; es "llévame a", "volver a hoy";
 * pt "me leve para", "voltar para hoje". A miss only costs a refused call the model is told about.
 */
const MOVE_REQUESTS: readonly RegExp[] = [
  /\b(?:take|bring|send) (?:me|us)(?: back)? to\b/i,
  /\b(?:go|jump|travel|return|head|come)(?: back)? to\b/i,
  /\btime[- ]?travel\b/i,
  /\bmove (?:this|the) (?:chat|conversation|thread)\b/i,
  /\bback to today\b/i,
  /\bll[eé]va(?:me|nos) a\b/i,
  /\b(?:volver|vuelve|vuelva|regresar|regresa|ir|viajar|viaja) (?:a|al)\b/i,
  /\b(?:me|nos) (?:leve|leva)\b|\b(?:leve|leva)-(?:me|nos)\b/i,
  /\b(?:voltar|volte|volta|ir|viajar|viaja|vamos) (?:para|a)\b/i,
];

/** Words that name a time or "today": a move needs a destination. */
const DESTINATION = /\b(?:today|hoy|hoje|\d{4}|january|february|march|april|may|june|july|august|september|october|november|december|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|janeiro|fevereiro|março|maio|junho|julho|setembro|outubro|novembro|dezembro)\b/i;

export function asksToTravel(question: string): boolean {
  return MOVE_REQUESTS.some((pattern) => pattern.test(question)) && DESTINATION.test(question);
}
