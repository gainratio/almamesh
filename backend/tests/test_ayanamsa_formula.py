"""Rigorous-precession Lahiri ayanamsa: formula vs official lookup table.

CORRECTNESS-CRITICAL. These tests pin the precession-based Lahiri formula to
the J2000 anchor (23.85306 deg = 23 deg 51' 11") and cross-check it against the
official Lahiri/Chitrapaksha daily lookup table (the IAE / Rashtriya Panchang
standard) across 1900-2050. If the formula drifts >0.01 deg from the table at
any sampled epoch, the engine is shipping a divergent ayanamsa model -> fail.
"""

from datetime import UTC, datetime

from almamesh.calculations import (
    AYANAMSA_J2000_ANCHORS_DEG,
    AyanamsaCalculator,
    AyanamsaType,
    get_ayanamsa,
    get_ayanamsa_for_convention,
)
from almamesh.snapshot import compute_stamped_chart

# J2000.0 = JD 2451545.0; the documented Lahiri anchor in degrees.
J2000_JD = 2451545.0
J2000_ANCHOR_DEG = 23.85306

# Sampled epochs (Jan 1 12:00 TT, approx) for the formula-vs-table cross-check.
JD_1950 = 2433282.5
JD_2000 = 2451545.0
JD_2050 = 2469807.5


def test_ayanamsa_at_j2000_matches_anchor() -> None:
    """The formula reproduces the documented J2000 Lahiri anchor to <0.001 deg."""
    assert abs(get_ayanamsa(J2000_JD) - J2000_ANCHOR_DEG) < 0.001


def test_formula_agrees_with_table_within_threshold() -> None:
    """Formula stays within 0.01 deg of the official lookup table 1950-2050."""
    table = AyanamsaCalculator()
    for jd in (JD_1950, JD_2000, JD_2050):
        formula_value = get_ayanamsa(jd)
        table_value = table.get_ayanamsa(jd)
        assert abs(formula_value - table_value) < 0.01, (
            f"formula {formula_value} vs table {table_value} at jd {jd}"
        )


def test_table_reader_fails_closed_when_resource_missing() -> None:
    """A missing resource must raise, never silently fall back to a guess."""
    calc = AyanamsaCalculator()
    calc._table = []  # simulate a missing/empty resource
    try:
        calc.get_ayanamsa(J2000_JD)
    except (RuntimeError, ValueError, FileNotFoundError):
        return
    raise AssertionError("expected fail-closed error on empty ayanamsa table")


def test_supported_ayanamsa_anchors_and_ordering_at_j2000() -> None:
    """All J2000-anchored conventions match Swiss Ephemeris anchors and canonical order."""
    raman = get_ayanamsa_for_convention(J2000_JD, AyanamsaType.RAMAN)
    kp = get_ayanamsa_for_convention(J2000_JD, AyanamsaType.KP)
    lahiri = get_ayanamsa_for_convention(J2000_JD, AyanamsaType.LAHIRI)
    fagan = get_ayanamsa_for_convention(J2000_JD, AyanamsaType.FAGAN_BRADLEY)

    assert raman < kp < lahiri < fagan
    for convention, expected in AYANAMSA_J2000_ANCHORS_DEG.items():
        assert abs(get_ayanamsa_for_convention(J2000_JD, convention) - expected) < 1e-6


def test_compute_stamped_chart_records_requested_ayanamsa() -> None:
    """Stamped charts compute with and record non-Lahiri ayanamsas deterministically."""
    birth = datetime(1990, 5, 15, 6, 30, tzinfo=UTC)
    ref = datetime(2026, 6, 1, 0, 0, tzinfo=UTC)
    lahiri = compute_stamped_chart(birth, 28.6139, 77.2090, reference_date=ref)
    raman = compute_stamped_chart(
        birth, 28.6139, 77.2090, reference_date=ref, ayanamsa_type=AyanamsaType.RAMAN
    )
    kp = compute_stamped_chart(
        birth, 28.6139, 77.2090, reference_date=ref, ayanamsa_type=AyanamsaType.KP
    )

    assert lahiri.snapshot.ayanamsa == "LAHIRI"
    assert raman.snapshot.ayanamsa == "RAMAN"
    assert kp.snapshot.ayanamsa == "KP"
    assert lahiri.snapshot.snapshot_id != raman.snapshot.snapshot_id
    assert raman.ayanamsa_value < kp.ayanamsa_value < lahiri.ayanamsa_value


def test_transit_context_keeps_consistent_ayanamsa_frame_for_slow_hits_and_sade_sati() -> None:
    """Saturn Return & Sade Sati under RAMAN use RAMAN transit longitudes (no mixed-frame shift)."""
    from almamesh.constants.astrology import PlanetName
    from almamesh.transits import calculate_transit_context

    birth = datetime(1990, 5, 15, 6, 30, tzinfo=UTC)
    ref = datetime(2019, 1, 1, 0, 0, tzinfo=UTC)
    lahiri_natal = compute_stamped_chart(
        birth, 28.6139, 77.2090, reference_date=ref, ayanamsa_type=AyanamsaType.LAHIRI
    )
    raman_natal = compute_stamped_chart(
        birth, 28.6139, 77.2090, reference_date=ref, ayanamsa_type=AyanamsaType.RAMAN
    )

    lahiri_tx = calculate_transit_context(
        lahiri_natal, birth, transit_instant=ref, ayanamsa_type=AyanamsaType.LAHIRI
    )
    raman_tx = calculate_transit_context(
        raman_natal, birth, transit_instant=ref, ayanamsa_type=AyanamsaType.RAMAN
    )

    lahiri_sr = next(h for h in lahiri_tx.slow_hits if h.natal_point == "natal_saturn")
    raman_sr = next(h for h in raman_tx.slow_hits if h.natal_point == "natal_saturn")
    # Same-frame Saturn Return depends only on differential precession (~0.0001 deg over 30y),
    # so Raman and Lahiri returns agree within 1 day (mixed frames drifted 42-150+ days).
    assert abs((raman_sr.exact - lahiri_sr.exact).total_seconds()) < 86_400

    # Gochara Saturn sign and Sade Sati active/phase must agree in the RAMAN frame.
    raman_saturn_sign = raman_tx.gochara.placements[PlanetName.SATURN].sign
    if raman_tx.sade_sati.is_active:
        assert any(
            seg.phase == raman_tx.sade_sati.current_phase and seg.saturn_sign == raman_saturn_sign
            for seg in raman_tx.sade_sati.cycle
        )
