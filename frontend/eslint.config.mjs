// Bun/Node ESM compatibility: some runtimes don't expose `structuredClone` in
// the config evaluation context, but ESLint 9 expects it.
if (typeof globalThis.structuredClone !== "function") {
  globalThis.structuredClone = (value) => JSON.parse(JSON.stringify(value));
}

// Some ESLint dependencies call `signal.throwIfAborted()`. Ensure a minimal
// implementation exists even when a non-standard signal object is used.
if (typeof Object.prototype.throwIfAborted !== "function") {
  Object.defineProperty(Object.prototype, "throwIfAborted", {
    value() {
      if (this && this.aborted) {
        throw this.reason ?? new Error("Aborted");
      }
    },
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

import path from "node:path";
import { defineConfig, includeIgnoreFile } from "eslint/config";
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import { LINT_IGNORES } from "./eslint.ignores.mjs";

// ONE flat config for the whole frontend workspace: apps/web AND every
// packages/* workspace. `bun run lint` (frontend/) runs `eslint .` against it,
// and so do `bun run gate` and the Dagger `frontend` gate. No workspace keeps
// its own config; tests/frontend-lint-coverage-contract.test.ts fails if one
// appears or if ESLint would skip a real source file in any workspace.
export default defineConfig([
  // Lint ignores what git ignores. Gitignored scratch files (e.g. the
  // verify-*.mjs live-validation scripts) never reach a commit, so a lint error
  // in one must not block `git push` via the pre-push hook. Patterns resolve
  // relative to each .gitignore's own directory, exactly like git.
  includeIgnoreFile(
    [
      path.resolve(import.meta.dirname, "../.gitignore"),
      path.resolve(import.meta.dirname, "apps/web/.gitignore"),
    ],
    { gitignoreResolution: true, name: "almamesh/gitignored-files" },
  ),

  // Build output, vendored bundles, scratch dirs: the one shared list.
  { ignores: LINT_IGNORES },

  // Base JS recommended rules
  js.configs.recommended,

  // TypeScript + TSX
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      "react-hooks": reactHooks,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      // Keep React Hooks rules focused (avoid experimental/over-strict rules).
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // TypeScript already checks undefined symbols; base ESLint `no-undef` does not understand TS types/DOM.
      "no-undef": "off",
      // Prefer TS-aware unused-vars.
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },

  // First-party Node/ESM scripts (build + Playwright exit-gate driver). These
  // run under Node and also embed browser-evaluated snippets via Playwright's
  // page.evaluate, so they legitimately reference both Node and DOM globals.
  {
    files: ["**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        URL: "readonly",
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        indexedDB: "readonly",
        caches: "readonly",
        localStorage: "readonly",
        fetch: "readonly",
        performance: "readonly",
        Event: "readonly",
        HTMLElement: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        AbortController: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },

  // Node-only fixture generators that encode bytes. Scoped to these two files
  // so the browser-flavoured .mjs globals above stay narrow.
  {
    files: ["scripts/generate-cities.mjs", "scripts/make-legacy-v2-fixture.mjs"],
    languageOptions: {
      globals: { Buffer: "readonly", TextEncoder: "readonly", TextDecoder: "readonly" },
    },
  },

  // The shared Tailwind preset is CommonJS (`module.exports`) so both
  // `require` and `import` consumers load it (package.json "exports").
  {
    files: ["packages/constants/tailwind.preset.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { module: "writable", require: "readonly" },
    },
  },

  // shared-types mirrors the backend's Pydantic classes by name, e.g.
  // `interface HealthGuidance extends Persona {}`. The empty body is
  // deliberate: the named type documents which backend class it matches.
  // Allow exactly that shape (one `extends`, no members) and nothing else.
  {
    files: ["packages/shared-types/src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-empty-object-type": [
        "error",
        { allowInterfaces: "with-single-extends" },
      ],
    },
  },
]);
