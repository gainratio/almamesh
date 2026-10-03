"""Guard: the Python engine is CRYPTO-FREE, in every runtime.

WHY this exists (the scar): the in-browser predictive path broke three times along
the same fault line. First ``almamesh.domains`` eagerly re-exported the receipt
helpers, forcing ``import avow`` -> ``pynacl`` at module load. Then
``almamesh.predictive`` — one level UP, where nothing guarded it — reintroduced an
identical module-level ``from avow import SignedReceipt``, and the app died at the
first online Life Atlas compute. Both were patched by making the crypto import lazy.

The third failure retired the lazy-import strategy altogether: PyNaCl's compiled
``_sodium`` extension does not register under this app's Pyodide boot AT ALL (plain
``nacl``, ``cffi`` and ``_cffi_backend`` load fine; only the dylib fails), so no
amount of deferring could make in-Pyodide signing work. Signing therefore moved OUT
of Python into the Worker's TypeScript (``@gainratio/avow``, pure JS Ed25519), and
the invariant hardened from "import crypto lazily" to:

    NOTHING under ``almamesh`` may import ``avow`` or ``nacl``. Ever. Anywhere.

That is both stronger and simpler than the old lazy-import contract, and it is what
lets the browser boot drop the ``pynacl`` package entirely.

The Worker entry points are PARSED OUT OF ``chartWorker.ts`` rather than hardcoded,
so a new Worker entry point automatically inherits the guard instead of silently
escaping it — which is exactly how ``predictive`` escaped last time.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[1]
_SRC = _BACKEND / "src" / "almamesh"
_CHART_WORKER = (
    _BACKEND.parent / "frontend" / "packages" / "browser" / "src" / "pyodide" / "chartWorker.ts"
)
_STRENGTH_RECEIPT_TS = _CHART_WORKER.parent / "strengthReceipt.ts"

# `from almamesh.foo.bar import baz, qux` inside the PY_BOOTSTRAP template.
_IMPORT_RE = re.compile(r"^\s*from\s+(almamesh[\w.]*)\s+import\s+([\w,\s]+)$", re.MULTILINE)

_FORBIDDEN = ("avow", "nacl")

# Any Python import of the forbidden modules, in either import form.
_CRYPTO_IMPORT_RE = re.compile(
    r"^\s*(?:from\s+(?:avow|nacl)[\w.]*\s+import\s|import\s+(?:avow|nacl)\b)",
    re.MULTILINE,
)


def _worker_entry_points() -> list[tuple[str, tuple[str, ...]]]:
    """Every ``from almamesh... import ...`` the Worker's Python glue performs."""
    source = _CHART_WORKER.read_text(encoding="utf-8")
    entries: dict[str, tuple[str, ...]] = {}
    for module, names in _IMPORT_RE.findall(source):
        symbols = tuple(name.strip() for name in names.split(",") if name.strip())
        entries[module] = tuple(sorted(set(entries.get(module, ()) + symbols)))
    return sorted(entries.items())


def _probe_source(module: str, symbols: tuple[str, ...]) -> str:
    """A fresh-interpreter script importing one Worker entry point, crypto-free."""
    return (
        "import sys\n"
        f"from {module} import {', '.join(symbols)}\n"
        f"leaked = {{m for m in {_FORBIDDEN!r} if m in sys.modules}}\n"
        f"assert not leaked, 'importing {module} leaked ' + repr(sorted(leaked))\n"
    )


def test_chart_worker_source_is_reachable() -> None:
    """The guard must never go vacuous by silently losing its source of truth."""
    assert _CHART_WORKER.is_file(), f"chartWorker.ts not found at {_CHART_WORKER}"


def test_worker_entry_points_are_discovered() -> None:
    """Non-vacuity: the parse must actually find the Worker's real entry points."""
    modules = {module for module, _ in _worker_entry_points()}
    assert "almamesh.calculations" in modules
    assert "almamesh.predictive" in modules
    assert "almamesh.mesh" in modules
    assert "almamesh.rectification" in modules


@pytest.mark.parametrize(("module", "symbols"), _worker_entry_points(), ids=lambda v: str(v))
def test_worker_entry_point_does_not_import_avow(module: str, symbols: tuple[str, ...]) -> None:
    """A fresh interpreter imports each Worker entry point without avow/pynacl."""
    result = subprocess.run(
        [sys.executable, "-c", _probe_source(module, symbols)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr


def test_engine_sources_are_discovered() -> None:
    """Non-vacuity: the whole-package sweep must actually find the engine."""
    modules = list(_SRC.rglob("*.py"))
    assert len(modules) > 50, f"expected the full engine, swept only {len(modules)} files"


def test_no_almamesh_module_imports_crypto() -> None:
    """The hardened invariant: the ENTIRE package is free of avow/nacl imports.

    Static and total — it covers modules no Worker entry point happens to reach,
    which is where the last two regressions hid."""
    offenders = [
        str(path.relative_to(_SRC))
        for path in sorted(_SRC.rglob("*.py"))
        if _CRYPTO_IMPORT_RE.search(path.read_text(encoding="utf-8"))
    ]
    assert not offenders, f"these engine modules import avow/nacl: {offenders}"


def test_worker_python_glue_never_imports_crypto() -> None:
    """The Worker's inline Python glue must not import avow/nacl either.

    The old design imported ``avow`` here deliberately (lazily, inside the signer).
    That is now forbidden outright: PyNaCl cannot load in this Pyodide boot."""
    glue = _CHART_WORKER.read_text(encoding="utf-8")
    assert not _CRYPTO_IMPORT_RE.search(glue), (
        "chartWorker.ts's Python glue imports avow/nacl — signing belongs in "
        "TypeScript (@gainratio/avow), not in Pyodide"
    )


def test_signing_moved_to_typescript_rather_than_vanishing() -> None:
    """The capability MOVED; it was not quietly dropped.

    Without this, every assertion above could be satisfied by simply deleting
    signing altogether — the guard would pass while the product lost the receipt.
    So pin the other side: a TypeScript seam signs with the shared Avow envelope,
    and the Worker actually calls it."""
    assert _STRENGTH_RECEIPT_TS.is_file(), f"missing TS signer at {_STRENGTH_RECEIPT_TS}"
    signer = _STRENGTH_RECEIPT_TS.read_text(encoding="utf-8")
    assert "@gainratio/avow" in signer, "the TS signer must use the shared Avow envelope"
    assert "sealDomainStrengths" in signer

    worker = _CHART_WORKER.read_text(encoding="utf-8")
    assert "sealDomainStrengths" in worker, (
        "chartWorker.ts must seal domain strengths in TypeScript"
    )


def test_pynacl_is_not_loaded_in_the_browser_boot() -> None:
    """The payoff: the browser no longer downloads/loads the Ed25519 WASM dylib.

    ``pynacl`` sat in LOAD_PACKAGES purely for the Python signer. With signing in
    TypeScript it is dead weight on every boot — including natal-only sessions that
    never compute a Life Atlas at all."""
    worker = _CHART_WORKER.read_text(encoding="utf-8")
    load_packages = re.search(r"LOAD_PACKAGES\s*=\s*\[(.*?)\]", worker, re.DOTALL)
    assert load_packages is not None, "could not locate LOAD_PACKAGES in chartWorker.ts"
    assert "pynacl" not in load_packages.group(1)
