"""Harness: combining families, summaries, ablation variants and exclusions."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime

import pytest

from almamesh.calculations import SkyfieldAstronomy
from almamesh.retrodiction.engine import SubjectEngine
from almamesh.retrodiction.events import Birth, EventCategory, LifeEvent
from almamesh.retrodiction.harness import (
    EventScores,
    Exclusion,
    ablation_variants,
    combined,
    saturation,
    score_event,
    summarize,
)
from almamesh.retrodiction.indicators import FAMILIES, SHIPPED_FAMILIES

ALL = frozenset(f.name for f in FAMILIES)
N = 73


def _event(event_score: float, *, a: float = 0.0, b: float = 0.0) -> EventScores:
    """73 months; family ``a`` peaks at the event month with ``event_score``."""
    ramp = tuple(i / 1000 for i in range(N))
    fam_a = tuple(event_score if i == 36 else ramp[i] for i in range(N))
    fam_b = tuple(b for _ in range(N))
    families = {"a": fam_a, "b": fam_b}
    return EventScores("s", EventCategory.LEGAL, (2019, 5), "disputes", families, 36)


def test_combined_sums_the_named_families_only() -> None:
    scores = _event(5.0, b=0.25)
    assert combined(scores, {"a", "b"})[36] == pytest.approx(5.25)
    assert combined(scores, {"b"}) == [0.25] * N


def test_planted_signal_is_detected() -> None:
    summary = summarize([_event(5.0)] * 20, {"a"}, 3)
    assert summary.hits == pytest.approx(20.0)
    assert summary.base_rate == pytest.approx(3 / 73)
    assert summary.lift == pytest.approx(73 / 3)
    assert summary.p_value < 1e-20
    assert summary.lift_low > 1.0


def test_an_event_month_at_the_bottom_is_a_miss_with_p_one() -> None:
    summary = summarize([_event(-1.0)] * 20, {"a"}, 3)
    assert summary.hits == 0.0
    assert summary.lift == 0.0
    assert summary.p_value == pytest.approx(1.0)


def test_a_family_that_is_flat_earns_lift_one() -> None:
    summary = summarize([_event(5.0, b=1.0)] * 10, {"b"}, 6)
    assert summary.lift == pytest.approx(1.0)
    assert summary.p_value == pytest.approx(1.0)


def test_summarize_refuses_no_events() -> None:
    with pytest.raises(ValueError, match="no events"):
        summarize([], {"a"}, 3)


def test_saturation_reports_flat_targets() -> None:
    flat = saturation([_event(5.0, b=1.0)], {"b"})
    assert flat.mean_score == pytest.approx(1.0)
    assert flat.share_nonzero == pytest.approx(1.0)
    assert flat.top_tie_share == pytest.approx(1.0)
    peaked = saturation([_event(5.0)], {"a"})
    assert peaked.top_tie_share == pytest.approx(1 / 73)


def test_ablation_variants_cover_all_off_only_and_shipped() -> None:
    variants = ablation_variants()
    assert variants["all"] == ALL
    assert variants["shipped_only"] == SHIPPED_FAMILIES
    for name in ALL:
        assert variants[f"without:{name}"] == ALL - {name}
        assert variants[f"only:{name}"] == frozenset({name})
    assert len(variants) == 2 + 2 * len(ALL)


@pytest.fixture(scope="module")
def engine() -> Iterator[SubjectEngine]:
    birth = Birth(
        datetime=datetime.fromisoformat("1980-03-04T05:06:00+05:30"),
        latitude=13.08,
        longitude=80.27,
    )
    with SkyfieldAstronomy() as astronomy:
        yield SubjectEngine(birth, astronomy)


def test_score_event_builds_a_full_window(engine: SubjectEngine) -> None:
    event = LifeEvent(category=EventCategory.JOB_START, date="2019-05", precision="month")
    scored = score_event(engine, "s", event, 36)
    assert isinstance(scored, EventScores)
    assert scored.index == 36
    assert scored.month == (2019, 5)
    assert scored.area == "career"
    assert set(scored.families) == ALL
    assert all(len(v) == N for v in scored.families.values())
    assert len(set(combined(scored, ALL))) > 3  # the engine's scores vary month to month


def test_a_year_precision_event_is_excluded(engine: SubjectEngine) -> None:
    event = LifeEvent(category=EventCategory.EDUCATION, date="2001", precision="year")
    excluded = score_event(engine, "s", event, 36)
    assert isinstance(excluded, Exclusion)
    assert "precision" in excluded.reason


def test_a_window_reaching_before_birth_is_excluded(engine: SubjectEngine) -> None:
    event = LifeEvent(category=EventCategory.HEALTH, date="1981-01", precision="month")
    excluded = score_event(engine, "s", event, 36)
    assert isinstance(excluded, Exclusion)
    assert "window" in excluded.reason
