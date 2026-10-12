# Offline wheels (Skyfield astronomy stack)

Pure-Python (`py3-none-any`) wheels vendored so the in-browser Pyodide engine can
boot the engine's Python deps **offline** after first sync. They are shipped inside
the signed edge-proc bundle under `wheels/<filename>.whl` (see
`src/almamesh/edge/bundle.py::gather_offline_wheels`) and installed leaf-first
(deps:false) before the almamesh wheel that imports them.

Pinned versions:

| Wheel | Version | Tag |
|-------|---------|-----|
| `jplephem` | 2.23 | `py3-none-any` |
| `sgp4` | 2.25 | `py3-none-any` (MUST be the pure wheel, not a platform binary) |
| `skyfield` | 1.55 | `py3-none-any` (matches `backend/uv.lock`) |

Skyfield must satisfy the dependency declared in `backend/pyproject.toml` and
match the backend lock. `tests/test_browser_astronomy_dependencies.py` reads the
actual wheel's `METADATA` and checks the provider and integration-script paths,
because offline installation with `deps:false` skips dependency resolution.

The Skyfield 1.55 wheel was downloaded from [the official PyPI release](https://pypi.org/project/skyfield/1.55/)
and its SHA-256 verified against [PyPI's release metadata](https://pypi.org/pypi/skyfield/1.55/json):

```text
skyfield-1.55-py3-none-any.whl (371137 bytes)
9f98964855067460c94aa81a337194136f4a97a62ba8bbbfac1b8556f2b66ad4
```

`sgp4` publishes platform-specific binary wheels (e.g. `cp313-*-macosx`). Pyodide
cannot load those — it needs the pure `py3-none-any` wheel. Always confirm the tag.

Strength receipts are signed in TypeScript by `@gainratio/avow`; the browser
engine does not load Python `avow`, `rfc8785`, or `pynacl`. Pyodide's own runtime
and its selected package wheels, including NumPy, ship as app static assets.

## Refresh

```bash
pip download --no-deps --only-binary=:all: \
  --python-version 3.13 --implementation py --abi none --platform any \
  -d backend/offline_wheels \
  skyfield==1.55 jplephem==2.23 sgp4==2.25
```

`--platform any --abi none --implementation py` forces the pure-Python wheels.
After refreshing, verify the wheel hash against official release metadata and
update the version table, bundle tests, runtime provider, and browser integration
scripts. Rebuild the signed bundle and prove browser/backend calculation parity
before releasing; changing the vendored wheel alone does not update production.
