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

export default defineConfig([
  // Lint ignores what git ignores. Gitignored scratch files (e.g. the
  // verify-*.mjs live-validation scripts) never reach a commit, so a lint error
  // in one must not block `git push` via the pre-push hook. Patterns resolve
  // relative to each .gitignore's own directory, exactly like git.
  includeIgnoreFile(
    [
      path.resolve(import.meta.dirname, "../../../.gitignore"),
      path.resolve(import.meta.dirname, ".gitignore"),
    ],
    { gitignoreResolution: true, name: "almamesh/gitignored-files" },
  ),


  // Build / generated output + vendored third-party bundles (Pyodide dist).
  // `public/**` ships the prebuilt Pyodide runtime verbatim; it is not our
  // source and must not be linted (4900+ no-undef false positives otherwise).
  {
    ignores: [
      "dist/**",
      "dist-verify/**",
      // The no-hooks real-journey build (report-pdf/dual-voice configs + the
      // documented local live-validation flow) — same generated output, same
      // 4900+ false positives if linted. Without this, running the exit gate
      // locally breaks the next `git commit` (lint-staged runs the lint).
      "dist-real/**",
      // The two builds the service-worker update gate compares
      // (scripts/build-sw-update-fixtures.mjs) — generated output again, and
      // linting a minified sw.js alone is ~15k false positives.
      "dist-sw-update/**",
      "node_modules/**",
      "playwright-report/**",
      "test-results/**",
      "public/**",
      // wrangler's scratch dir — `wrangler pages dev dist` (the documented
      // local Cloudflare Pages check, docs/deploy/almamesh-com.md) drops
      // generated shims here.
      ".wrangler/**",
    ],
  },

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
]);
