// Incremental prose view of a JSON document that is still being streamed.
//
// The structured sections ask the model for a JSON object, so the raw stream is
// braces, keys and escapes. This extractor walks each delta ONCE (O(delta), no
// re-scan of the growing document) and keeps only what a reader wants to see
// while they wait: the decoded string VALUES, a running word count, and a
// bounded tail of the prose. It never validates — the final document is parsed
// and validated separately once the stream ends.

/** Upper bound on the prose tail kept for the live preview. */
export const PROSE_PREVIEW_CHARS = 480;

export interface JsonProseExtractor {
  /** Feed the next streamed delta. */
  push(delta: string): void;
  /** Words of prose seen so far (string values only, keys excluded). */
  words(): number;
  /** The last ≤ PROSE_PREVIEW_CHARS characters of decoded prose. */
  preview(): string;
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  n: "\n",
  t: "\t",
  r: "",
  b: "",
  f: "",
};

interface ScanState {
  readonly stack: string[];
  expectKey: boolean;
  inString: boolean;
  isKey: boolean;
  escape: "none" | "backslash" | "unicode";
  hex: string;
  values: number;
}

function startString(state: ScanState, out: string[]): void {
  state.inString = true;
  state.isKey = state.expectKey && state.stack[state.stack.length - 1] === "{";
  if (state.isKey) return;
  if (state.values > 0) out.push("\n");
  state.values += 1;
}

function structural(state: ScanState, ch: string, out: string[]): void {
  if (ch === '"') return startString(state, out);
  if (ch === "{" || ch === "[") {
    state.stack.push(ch);
    state.expectKey = ch === "{";
  } else if (ch === "}" || ch === "]") {
    state.stack.pop();
    state.expectKey = false;
  } else if (ch === ":") {
    state.expectKey = false;
  } else if (ch === ",") {
    state.expectKey = state.stack[state.stack.length - 1] === "{";
  }
}

function escaped(state: ScanState, ch: string): string {
  if (state.escape === "unicode") {
    state.hex += ch;
    if (state.hex.length < 4) return "";
    state.escape = "none";
    const code = Number.parseInt(state.hex, 16);
    return Number.isNaN(code) ? "" : String.fromCharCode(code);
  }
  if (ch === "u") {
    state.escape = "unicode";
    state.hex = "";
    return "";
  }
  state.escape = "none";
  return SIMPLE_ESCAPES[ch] ?? ch;
}

function inString(state: ScanState, ch: string, out: string[]): void {
  let text: string;
  if (state.escape !== "none") {
    text = escaped(state, ch);
  } else if (ch === "\\") {
    state.escape = "backslash";
    return;
  } else if (ch === '"') {
    state.inString = false;
    state.expectKey = false;
    return;
  } else {
    text = ch;
  }
  if (!state.isKey && text) out.push(text);
}

/** Counts words in streamed text without keeping the text itself. */
export interface WordCounter {
  push(text: string): void;
  words(): number;
}

export function createWordCounter(): WordCounter {
  let count = 0;
  let lastWasSpace = true;
  return {
    push(text) {
      for (const ch of text) {
        const space = /\s/.test(ch);
        if (!space && lastWasSpace) count += 1;
        lastWasSpace = space;
      }
    },
    words: () => count,
  };
}

export function createJsonProseExtractor(): JsonProseExtractor {
  const state: ScanState = {
    stack: [],
    expectKey: false,
    inString: false,
    isKey: false,
    escape: "none",
    hex: "",
    values: 0,
  };
  let tail = "";
  const counter = createWordCounter();

  const append = (text: string): void => {
    counter.push(text);
    tail += text;
    // Amortized trim: copy only when the tail doubles past its bound.
    if (tail.length > PROSE_PREVIEW_CHARS * 2) tail = tail.slice(-PROSE_PREVIEW_CHARS);
  };

  return {
    push(delta) {
      const out: string[] = [];
      for (const ch of delta) {
        if (state.inString) inString(state, ch, out);
        else structural(state, ch, out);
      }
      if (out.length > 0) append(out.join(""));
    },
    words: () => counter.words(),
    preview: () => (tail.length > PROSE_PREVIEW_CHARS ? tail.slice(-PROSE_PREVIEW_CHARS) : tail),
  };
}
