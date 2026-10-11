"""Astronomy resources are owned explicitly; cyclic GC must not close ephemerides."""

from __future__ import annotations

import gc
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

import pytest

import almamesh.calculations as calculations
import almamesh.predictive as predictive
from almamesh.strength import compute_strength_context
from almamesh.transits import calculate_transit_context
from almamesh.transits.moon_window import EventPoint, compute_moon_window

if TYPE_CHECKING:
    from skyfield.jpllib import SpiceKernel

BIRTH = datetime(1990, 1, 15, 12, tzinfo=UTC)
REFERENCE = datetime(2026, 6, 9, 12, tzinfo=UTC)
LAT, LON = 28.6139, 77.2090
CIVIL = timedelta(minutes=330)


@pytest.fixture
def kernels(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[SpiceKernel]]:
    """Record real resources, rather than inferring release from Python object death."""
    opened: list[SpiceKernel] = []
    original = calculations.load_file

    def recording_load(path: str) -> SpiceKernel:
        kernel = original(path)
        opened.append(kernel)
        return kernel

    monkeypatch.setattr(calculations, "load_file", recording_load)
    yield opened
    for kernel in opened:
        kernel.close()


def assert_closed(kernel: SpiceKernel) -> None:
    assert kernel.spk.daf.file.closed
    assert kernel.spk.daf._map is None
    assert kernel.spk.daf._array is None
    assert kernel.segments == []


def compute() -> predictive.PredictiveContexts:
    return predictive.compute_predictive_contexts(
        BIRTH, LAT, LON, REFERENCE, civil_offset=CIVIL, window_months=1
    )


def test_prediction_owns_one_kernel_and_closes_it(kernels: list[SpiceKernel]) -> None:
    result = compute()
    assert result.transit_context.instant == REFERENCE
    assert len(kernels) == 1
    assert_closed(kernels[0])


def test_prediction_closes_its_kernel_when_composition_fails(
    kernels: list[SpiceKernel], monkeypatch: pytest.MonkeyPatch
) -> None:
    def fail(*_args: object) -> None:
        raise RuntimeError("domain composition failed")

    monkeypatch.setattr(predictive, "compute_life_domains", fail)
    with pytest.raises(RuntimeError, match="domain composition failed"):
        compute()
    assert len(kernels) == 1
    assert_closed(kernels[0])


def test_constructor_closes_kernel_when_timescale_loading_fails(
    kernels: list[SpiceKernel], monkeypatch: pytest.MonkeyPatch
) -> None:
    def fail(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("timescale failed")

    monkeypatch.setattr(calculations.Loader, "timescale", fail)
    with pytest.raises(RuntimeError, match="timescale failed"):
        calculations.SkyfieldAstronomy()
    assert len(kernels) == 1
    assert_closed(kernels[0])


def test_constructor_preserves_primary_error_when_cleanup_fails(
    kernels: list[SpiceKernel], monkeypatch: pytest.MonkeyPatch
) -> None:
    original_load = calculations.load_file

    def load_with_failed_close(path: str) -> SpiceKernel:
        kernel = original_load(path)
        fail_first_close(kernel, monkeypatch)
        return kernel

    def fail(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("timescale failed")

    monkeypatch.setattr(calculations, "load_file", load_with_failed_close)
    monkeypatch.setattr(calculations.Loader, "timescale", fail)
    with pytest.raises(RuntimeError, match="timescale failed") as error:
        calculations.SkyfieldAstronomy()
    assert "OSError" in " ".join(error.value.__notes__)
    assert len(kernels) == 1


def fail_first_close(kernel: SpiceKernel, monkeypatch: pytest.MonkeyPatch) -> None:
    original_close = kernel.close
    failed = False

    def close() -> None:
        nonlocal failed
        if not failed:
            failed = True
            raise OSError("cleanup failed")
        original_close()

    monkeypatch.setattr(kernel, "close", close)


def test_context_preserves_primary_error_and_allows_cleanup_retry(
    kernels: list[SpiceKernel], monkeypatch: pytest.MonkeyPatch
) -> None:
    astro = calculations.SkyfieldAstronomy()
    fail_first_close(kernels[0], monkeypatch)
    with pytest.raises(RuntimeError, match="calculation failed") as error, astro:
        raise RuntimeError("calculation failed")
    assert "OSError" in " ".join(error.value.__notes__)
    astro.close()
    assert_closed(kernels[0])


def test_context_propagates_cleanup_error_without_primary_and_allows_retry(
    kernels: list[SpiceKernel], monkeypatch: pytest.MonkeyPatch
) -> None:
    astro = calculations.SkyfieldAstronomy()
    fail_first_close(kernels[0], monkeypatch)
    with pytest.raises(OSError, match="cleanup failed"), astro:
        pass
    astro.close()
    assert_closed(kernels[0])


def test_standalone_natal_closes_its_kernel_after_failure(
    kernels: list[SpiceKernel], monkeypatch: pytest.MonkeyPatch
) -> None:
    def fail(*_args: object) -> None:
        raise RuntimeError("planet calculation failed")

    monkeypatch.setattr(calculations, "_calculate_planetary_positions", fail)
    with pytest.raises(RuntimeError, match="planet calculation failed"):
        calculations.calculate_sidereal_context(BIRTH, LAT, LON, reference_date=REFERENCE)
    assert_closed(kernels[0])


def test_injected_astronomy_stays_open_for_its_owner(kernels: list[SpiceKernel]) -> None:
    with calculations.SkyfieldAstronomy() as astro:
        natal = calculations.calculate_sidereal_context(
            BIRTH, LAT, LON, reference_date=REFERENCE, astronomy=astro
        )
        calculate_transit_context(
            natal, BIRTH, transit_instant=REFERENCE, window_months=1, astronomy=astro
        )
        compute_strength_context(natal, BIRTH, LAT, LON, civil_offset=CIVIL, astronomy=astro)
        compute_moon_window(REFERENCE, REFERENCE + timedelta(days=1), astronomy=astro)
        assert len(kernels) == 1
        assert not kernels[0].spk.daf.file.closed
    assert_closed(kernels[0])


def test_moon_window_closes_its_owned_kernel(kernels: list[SpiceKernel]) -> None:
    compute_moon_window(REFERENCE, REFERENCE + timedelta(days=1))
    assert len(kernels) == 1
    assert_closed(kernels[0])


def test_moon_window_closes_kernel_when_event_validation_fails(kernels: list[SpiceKernel]) -> None:
    event = EventPoint(when=REFERENCE + timedelta(days=2), latitude=LAT, longitude=LON)
    with pytest.raises(ValueError, match="instant is outside the place bounds"):
        compute_moon_window(REFERENCE, REFERENCE + timedelta(days=1), event=event)
    assert len(kernels) == 1
    assert_closed(kernels[0])


def test_close_is_idempotent(kernels: list[SpiceKernel]) -> None:
    astro = calculations.SkyfieldAstronomy()
    astro.eph["earth"].at(astro.ts.utc(2000, 1, 1))
    astro.close()
    astro.close()
    assert_closed(kernels[0])


def test_repeated_predictions_leave_no_open_maps_without_cyclic_gc(
    kernels: list[SpiceKernel],
) -> None:
    gc.collect()
    was_enabled = gc.isenabled()
    gc.disable()
    try:
        for _ in range(3):
            compute()
            assert all(kernel.spk.daf.file.closed for kernel in kernels)
            assert all(kernel.spk.daf._map is None for kernel in kernels)
        assert len(kernels) == 3
    finally:
        if was_enabled:
            gc.enable()
        gc.collect()
