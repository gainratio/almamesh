import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { version as installedPyodideVersion } from "pyodide";
import { describe, expect, it } from "vitest";

import { LOAD_PACKAGES } from "../loadPackages";
import { PYODIDE_RUNTIME_VERSION, versionedPyodideIndexUrl } from "../pyodideDist";

const HERE = dirname(fileURLToPath(import.meta.url));
const SETUP_SCRIPT = join(HERE, "../../../../../apps/web/scripts/setup-dev-assets.sh");
const require = createRequire(import.meta.url);

interface LockPackage {
  readonly file_name: string;
  readonly depends: readonly string[];
}

/** Pyodide lock names are PEP 503-normalised on lookup (pydantic_core vs pydantic-core). */
function normalise(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

function lockClosure(roots: readonly string[]): Set<string> {
  const lockPath = join(dirname(require.resolve("pyodide")), "pyodide-lock.json");
  const raw = JSON.parse(readFileSync(lockPath, "utf8")) as { packages: Record<string, LockPackage> };
  const byName = new Map(Object.entries(raw.packages).map(([k, v]) => [normalise(k), v]));
  const files = new Set<string>();
  const seen = new Set<string>();
  const stack = roots.map(normalise);
  while (stack.length > 0) {
    const name = normalise(stack.pop() ?? "");
    if (seen.has(name)) continue;
    seen.add(name);
    const pkg = byName.get(name);
    if (pkg === undefined) throw new Error(`${name} is not in the Pyodide lock`);
    files.add(pkg.file_name);
    stack.push(...pkg.depends);
  }
  return files;
}

function setupScript(): string {
  return readFileSync(SETUP_SCRIPT, "utf8");
}

describe("versionedPyodideIndexUrl", () => {
  it("puts every Pyodide release under its own immutable directory", () => {
    expect(versionedPyodideIndexUrl("/pyodide/", "314.0.7", "https://almamesh.com/")).toBe(
      "https://almamesh.com/pyodide/v314.0.7/",
    );
  });

  it("gives two releases disjoint URLs, so a CacheFirst entry can never cross versions", () => {
    const origin = "https://almamesh.com/";
    const previous = versionedPyodideIndexUrl("/pyodide/", "0.29.4", origin);
    const next = versionedPyodideIndexUrl("/pyodide/", "314.0.7", origin);
    expect(next.startsWith(previous)).toBe(false);
    expect(previous.startsWith(next)).toBe(false);
  });

  it("accepts a base without a trailing slash", () => {
    expect(versionedPyodideIndexUrl("/pyodide", "314.0.7", "https://a.test/")).toBe(
      "https://a.test/pyodide/v314.0.7/",
    );
  });

  it("defaults to the bundled runtime version (the one loadPyodide checks against)", () => {
    expect(PYODIDE_RUNTIME_VERSION).toBe(installedPyodideVersion);
    expect(versionedPyodideIndexUrl("/pyodide/", undefined, "https://a.test/")).toBe(
      `https://a.test/pyodide/v${installedPyodideVersion}/`,
    );
  });
});

describe("self-hosted Pyodide dist stays in lockstep with the npm runtime", () => {
  it("pins the latest CPython-versioned runtime (314.x = Python 3.14)", () => {
    expect(installedPyodideVersion).toBe("314.0.7");
  });

  it("setup-dev-assets.sh fetches the same Pyodide version the worker bundles", () => {
    const match = setupScript().match(/PYODIDE_VERSION="\$\{PYODIDE_VERSION:-([^}]+)\}"/);
    expect(match?.[1]).toBe(installedPyodideVersion);
  });

  it("setup-dev-assets.sh ships exactly the lock closure of LOAD_PACKAGES", () => {
    const listed = [...setupScript().matchAll(/^\s+(\S+\.whl)$/gm)].map((m) => m[1]);
    expect(new Set(listed)).toEqual(lockClosure(LOAD_PACKAGES));
  });

  it("setup-dev-assets.sh ships the 314.x ES-module loader (pyodide.asm.js was renamed)", () => {
    const script = setupScript();
    expect(script).toContain("pyodide.asm.mjs");
    expect(script).not.toMatch(/pyodide\.asm\.js\b/);
  });
});
