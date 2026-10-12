import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LOAD_PACKAGES } from "../loadPackages";
import type { BirthInput, BootConfig, ChartWorkerRequest, ChartWorkerResponse } from "../protocol";

const { loadPyodide } = vi.hoisted(() => ({ loadPyodide: vi.fn() }));
vi.mock("pyodide", () => ({ loadPyodide, version: "314.0.7" }));

const CONFIG: BootConfig = {
  pyodideIndexUrl: "https://app.test/pyodide/",
  wheels: [
    "jplephem-2.23-py3-none-any.whl",
    "sgp4pure-2.25-py3-none-any.whl",
    "skyfield-1.55-py3-none-any.whl",
    "almamesh-0.1.0-py3-none-any.whl",
  ].map((filename, index) => ({ filename, bytes: new Uint8Array([index + 1]) })),
  skyfieldData: [
    { filename: "de421.bsp", bytes: new Uint8Array([5]) },
    { filename: "finals2000A.all", bytes: new Uint8Array([6]) },
  ],
};

const BIRTH: BirthInput = {
  datetimeUtc: "1990-01-15T12:00:00+00:00",
  latitude: 28.6139,
  longitude: 77.209,
  referenceDate: "2026-10-12T00:00:00+00:00",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

class WorkerScope extends EventTarget {
  public readonly responses: ChartWorkerResponse[] = [];
  public readonly fetch = vi.fn<typeof fetch>();
  public readonly location = new URL("https://app.test/chart-worker.js");
  private readonly pending = new Map<number, (response: ChartWorkerResponse) => void>();

  public postMessage(response: ChartWorkerResponse): void {
    this.responses.push(response);
    if (response.ok && response.kind === "bootProgress") return;
    this.pending.get(response.id)?.(response);
    this.pending.delete(response.id);
  }

  public request(request: ChartWorkerRequest): Promise<ChartWorkerResponse> {
    return new Promise((resolve) => {
      this.pending.set(request.id, resolve);
      this.dispatchEvent(new MessageEvent("message", { data: request }));
    });
  }
}

function pyodideFixture() {
  const events: string[] = [];
  const install = vi.fn(async (path: string, _options: { deps: boolean }) => {
    events.push(`install:${path}`);
  });
  const chartFn = Object.assign(vi.fn(() => JSON.stringify({ source: "booted-engine" })), {
    destroy: vi.fn(),
  });
  const pyodide = {
    loadPackage: vi.fn(async () => LOAD_PACKAGES.map((name) => ({ name }))),
    pyimport: vi.fn(() => ({ install: { callKwargs: install } })),
    FS: {
      writeFile: vi.fn((path: string, _bytes: Uint8Array) => { events.push(`write:${path}`); }),
      mkdirTree: vi.fn((path: string) => { events.push(`mkdir:${path}`); }),
    },
    runPython: vi.fn((_code: string) => { events.push("runPython"); }),
    runPythonAsync: vi.fn(async (_code: string) => { events.push("runPythonAsync"); }),
    globals: { get: vi.fn(() => chartFn) },
  };
  loadPyodide.mockResolvedValue(pyodide);
  return { pyodide, events, install, chartFn };
}

async function startWorker() {
  const scope = new WorkerScope();
  vi.stubGlobal("self", scope);
  // Offline-cache behavior has its own tests; this worker contract needs no I/O.
  vi.stubGlobal("caches", undefined);
  const { PY_BOOTSTRAP } = await import("../chartWorker");
  return { scope, PY_BOOTSTRAP };
}

beforeEach(() => {
  vi.resetModules();
  loadPyodide.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chart Worker bootstrap", () => {
  it("awaits ordered wheel installs and data seeding, then synchronously evaluates the exact glue before readiness", async () => {
    const { pyodide, events, install, chartFn } = pyodideFixture();
    const finalInstallStarted = deferred<void>();
    const finalInstall = deferred<void>();
    install.mockImplementation(async (path) => {
      events.push(`install:${path}`);
      if (path === `emfs:/${CONFIG.wheels.at(-1)!.filename}`) {
        finalInstallStarted.resolve();
        await finalInstall.promise;
      }
    });
    const { scope, PY_BOOTSTRAP } = await startWorker();
    const boot = scope.request({ kind: "boot", id: 1, config: CONFIG });
    await finalInstallStarted.promise;

    expect(await scope.request({ kind: "generateChart", id: 2, birth: BIRTH })).toEqual({
      ok: false, id: 2, error: "chart worker not booted",
    });
    expect(scope.responses.some((response) => response.ok && response.kind === "boot")).toBe(false);
    expect(pyodide.FS.mkdirTree).not.toHaveBeenCalled();
    expect(pyodide.runPython).not.toHaveBeenCalled();
    finalInstall.resolve();

    expect(await boot).toEqual({ ok: true, kind: "boot", id: 1 });
    expect(loadPyodide).toHaveBeenCalledExactlyOnceWith({ indexURL: "https://app.test/pyodide/v314.0.7/" });
    expect(pyodide.loadPackage).toHaveBeenCalledExactlyOnceWith([...LOAD_PACKAGES], {
      errorCallback: expect.any(Function),
    });
    expect(pyodide.pyimport).toHaveBeenCalledExactlyOnceWith("micropip");
    expect(install.mock.calls).toEqual(CONFIG.wheels.map(({ filename }) => [`emfs:/${filename}`, { deps: false }]));
    expect(pyodide.FS.writeFile.mock.calls).toEqual([
      ...CONFIG.wheels.map(({ filename, bytes }) => [`/${filename}`, bytes]),
      ...CONFIG.skyfieldData.map(({ filename, bytes }) => [`/home/pyodide/.skyfield-data/${filename}`, bytes]),
    ]);
    expect(events).toEqual([
      ...CONFIG.wheels.flatMap(({ filename }) => [`write:/${filename}`, `install:emfs:/${filename}`]),
      "mkdir:/home/pyodide/.skyfield-data",
      ...CONFIG.skyfieldData.map(({ filename }) => `write:/home/pyodide/.skyfield-data/${filename}`),
      "runPython",
    ]);
    expect(pyodide.runPython).toHaveBeenCalledExactlyOnceWith(PY_BOOTSTRAP);
    expect(pyodide.runPythonAsync).not.toHaveBeenCalled();
    expect(await scope.request({ kind: "generateChart", id: 3, birth: BIRTH })).toEqual({
      ok: true, kind: "generateChart", id: 3, chart: { source: "booted-engine" },
    });
    expect(chartFn).toHaveBeenCalledExactlyOnceWith(JSON.stringify(BIRTH));
    expect(chartFn.destroy).toHaveBeenCalledOnce();
  });

  it("returns a synchronous Python failure through the worker envelope and keeps the engine unready", async () => {
    const { pyodide } = pyodideFixture();
    pyodide.runPython.mockImplementation(() => { throw new Error("Python bootstrap import failed"); });
    const { scope, PY_BOOTSTRAP } = await startWorker();

    expect(await scope.request({ kind: "boot", id: 1, config: CONFIG })).toEqual({
      ok: false, id: 1, error: "Python bootstrap import failed",
    });
    expect(pyodide.runPython).toHaveBeenCalledExactlyOnceWith(PY_BOOTSTRAP);
    expect(pyodide.runPythonAsync).not.toHaveBeenCalled();
    expect(await scope.request({ kind: "generateChart", id: 2, birth: BIRTH })).toEqual({
      ok: false, id: 2, error: "chart worker not booted",
    });
    expect(pyodide.globals.get).not.toHaveBeenCalled();
    expect(scope.responses.some((response) => response.ok && response.kind === "boot")).toBe(false);
  });

  it("shares one package-loading promise when prewarm and boot overlap", async () => {
    const { pyodide } = pyodideFixture();
    const loading = deferred<typeof pyodide>();
    loadPyodide.mockReturnValue(loading.promise);
    const { scope } = await startWorker();
    const prewarm = scope.request({ kind: "prewarm", id: 1, pyodideIndexUrl: CONFIG.pyodideIndexUrl });
    const boot = scope.request({ kind: "boot", id: 2, config: CONFIG });
    expect(loadPyodide).toHaveBeenCalledOnce();
    expect(pyodide.loadPackage).not.toHaveBeenCalled();
    loading.resolve(pyodide);

    expect(await prewarm).toEqual({ ok: true, kind: "prewarm", id: 1 });
    expect(await boot).toEqual({ ok: true, kind: "boot", id: 2 });
    expect(loadPyodide).toHaveBeenCalledOnce();
    expect(pyodide.loadPackage).toHaveBeenCalledOnce();
    expect(pyodide.runPython).toHaveBeenCalledOnce();
    expect(pyodide.runPythonAsync).not.toHaveBeenCalled();
  });
});
