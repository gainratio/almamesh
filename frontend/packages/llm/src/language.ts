// Language-awareness for the client-side LLM prompts.
//
// AlmaMesh narration (interpretations + chat) must answer in the user's chosen
// UI language. The chart ENGINE is never touched — this only steers the prose the
// model writes. Astrology proper nouns / Sanskrit terms (nakshatra names, planet
// names, yoga names) stay in their canonical form; only the NARRATION language
// changes. `en` is the default and needs no instruction (the prompts are already
// English), so `languageInstruction("en")` returns "".

import type { ChatMessage } from "./client";

/** The UI/narration languages the prompts can target. Mirrors the i18n catalog. */
export type PromptLanguage = "en" | "es" | "pt" | "hi";

/** Endonym + English name for each non-default target language. */
const LANGUAGE_NAMES: Record<Exclude<PromptLanguage, "en">, { english: string; native: string }> = {
  es: { english: "Spanish", native: "Español" },
  pt: { english: "Portuguese", native: "Português" },
  hi: { english: "Hindi", native: "हिन्दी" },
};

/**
 * A strong, unambiguous instruction telling the model to write its ENTIRE
 * response in the target language, while letting astrology proper nouns / Sanskrit
 * terms stay in their canonical form. Returns "" for `en` (the prompts are already
 * English), so existing English output is byte-identical.
 */
export function languageInstruction(language: PromptLanguage = "en"): string {
  if (language === "en") {
    return "";
  }
  const { english, native } = LANGUAGE_NAMES[language];
  return [
    `LANGUAGE (MANDATORY): Write your entire response in ${english} (${native}).`,
    `All prose, headings, and section content must be in ${english}. Do not use English.`,
    `Astrology proper nouns and Sanskrit technical terms (planet names, sign names,`,
    `nakshatra names, yoga names, dasha) MAY remain in their canonical form — but every`,
    `sentence around them, and all narration, must be written in ${english}.`,
  ].join("\n");
}

/**
 * Append the language instruction (when any) as its own block to a system-prompt
 * string. A no-op for `en`, so the English prompt is unchanged.
 */
export function withLanguage(systemPrompt: string, language: PromptLanguage = "en"): string {
  const instruction = languageInstruction(language);
  return instruction === "" ? systemPrompt : `${systemPrompt}\n\n${instruction}`;
}

/**
 * Return a copy of `messages` whose system message carries the language
 * instruction. A no-op for `en`. If there is no system message, the messages are
 * returned unchanged (these builders always emit one).
 */
export function applyLanguageToMessages(
  messages: ChatMessage[],
  language: PromptLanguage = "en",
): ChatMessage[] {
  if (language === "en") {
    return messages;
  }
  return messages.map((m) =>
    m.role === "system" ? { ...m, content: withLanguage(m.content ?? "", language) } : m,
  );
}
