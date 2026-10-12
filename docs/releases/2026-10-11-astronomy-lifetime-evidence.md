# Astronomy resource lifetime evidence

The working change reduces a predictive invocation from four ephemeris kernels
to one and explicitly releases its file and mapped arrays on return or failure.
This removes reliance on cyclic garbage collection for resource release.
It does not establish the cause of a Safari crash or prove a browser memory budget.

## Observed resource counts

On 2026-10-11, the same CPython diagnostic was run against original main
`8d10fbbb` and the current working change. It disables cyclic GC, records real
Skyfield kernels for inspection, and computes the same Delhi prediction three
times with a one-month window. Counts below are taken after each call returns.

| Code | Call | Total kernels opened | Still open / mapped | Mapped bytes |
| --- | ---: | ---: | ---: | ---: |
| Main `8d10fbbb` | 1 | 4 | 4 / 4 | 67,152,512 |
| Main `8d10fbbb` | 2 | 8 | 8 / 8 | 134,305,024 |
| Main `8d10fbbb` | 3 | 12 | 12 / 12 | 201,457,536 |
| Working change | 1 | 1 | 0 / 0 | 0 |
| Working change | 2 | 2 | 0 / 0 | 0 |
| Working change | 3 | 3 | 0 / 0 | 0 |

During final composition, the working change had one open kernel and
16,788,128 mapped bytes in each invocation. Normal production GC was not
profiled by this experiment. Mapped bytes are resource sizes, not measured RSS
or Pyodide heap. Python objects can outlive their explicitly closed resources.

## Reproduce

Save this as `/tmp/almamesh-astronomy-lifetime-diagnostic.py`:

```python
import gc
import json
from datetime import UTC, datetime, timedelta

import almamesh.calculations as calculations
import almamesh.predictive as predictive

kernels, after = [], []
original_load = calculations.load_file

def load(path):
    kernel = original_load(path)
    kernels.append(kernel)
    return kernel

calculations.load_file = load
gc.collect()
was_enabled = gc.isenabled()
gc.disable()
try:
    for _ in range(3):
        predictive.compute_predictive_contexts(
            datetime(1990, 1, 15, 12, tzinfo=UTC), 28.6139, 77.2090,
            datetime(2026, 6, 9, 12, tzinfo=UTC),
            civil_offset=timedelta(minutes=330), window_months=1,
        )
        after.append({
            "constructors": len(kernels),
            "open_kernels": sum(not k.spk.daf.file.closed for k in kernels),
            "mapped_kernels": sum(k.spk.daf._map is not None for k in kernels),
            "mapped_bytes": sum(len(k.spk.daf._map) for k in kernels
                                if k.spk.daf._map is not None),
        })
    print(json.dumps({"source": predictive.__file__, "after_each_prediction": after}, indent=2))
finally:
    calculations.load_file = original_load
    for kernel in kernels:
        kernel.close()
    if was_enabled:
        gc.enable()
    gc.collect()
```

From the working checkout's `backend/`, run serially. The baseline checkout must
contain `8d10fbbb` backend sources and the same ephemeris bytes:

```sh
PYTHONPATH=/tmp/almamesh-codex-baseline-8d10fbbb/backend/src uv run --extra dev python /tmp/almamesh-astronomy-lifetime-diagnostic.py
uv run --extra dev python /tmp/almamesh-astronomy-lifetime-diagnostic.py
```

Regression tests in `backend/tests/test_astronomy_lifetime.py` separately cover
success, calculation failure, constructor failure, borrowed ownership, repeated
calls with GC disabled, moon-window cleanup, idempotence, cleanup retry, and
preserving a primary exception when cleanup also fails. Natal, transit,
strength, predictive, and moon-window golden fixtures were left unchanged.
