"""The one-time DEV / HELD-OUT split of natives (amendment d), pinned by digest."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from almamesh.retrodiction.adb import import_adb
from almamesh.retrodiction.events import (
    Birth,
    EventsFile,
    LifeEvent,
    RetrodictionInputError,
    Subject,
)
from almamesh.retrodiction.split import (
    ADB_SPLIT_DIGEST,
    SPLIT_SEED,
    checked_split,
    select_part,
    split_natives,
)

# The digest of the split of the licensed export, computed once on 2026-10-14 from
# adb_export_261012_2235 and recorded in amendment (d). A different export, seed or
# algorithm changes it, and the CLI then refuses to score either half.
PINNED_ADB_SPLIT_DIGEST = "299ec3937460a109c44a125943bc8f8f77da57259c545094f43c5d7c008664ca"
# The algorithm, pinned on a synthetic file so CI catches a change without the export.
SYNTHETIC_SPLIT_DIGEST = "2d6a8bb9efc92fd8ad9c9d3775d34d3e6aea56f73180cab2c3b6ce24fa609844"


def _subject(index: int, year: int = 1950) -> Subject:
    birth = Birth(
        datetime=f"{year}-01-0{1 + index % 9}T06:00:00+00:00", latitude=1.0, longitude=2.0
    )
    events = [
        LifeEvent(category="marriage", date=f"{year + 30}-0{1 + index % 9}", precision="month")
    ]
    return Subject(id=f"adb-{index}", birth=birth, events=events)


def _file(count: int = 10, *, early: int = 0) -> EventsFile:
    subjects = [_subject(i, 1890) for i in range(early)]
    subjects += [_subject(i) for i in range(early, early + count)]
    return EventsFile(kind="public", label="split test", source="unit test", subjects=subjects)


def test_should_split_post_1900_natives_in_half_when_split() -> None:
    # Given ten charted natives and two born before 1900
    events = _file(10, early=2)
    # When
    split = split_natives(events)
    # Then each kept native is in exactly one half, and pre-1900 natives in neither
    assert len(split.dev) == 5
    assert len(split.held_out) == 5
    assert set(split.dev).isdisjoint(split.held_out)
    assert set(split.dev) | set(split.held_out) == {f"adb-{i}" for i in range(2, 12)}


def test_should_pin_the_split_algorithm_when_run_on_a_fixed_file() -> None:
    # Given / When
    split = split_natives(_file(10))
    # Then
    assert SPLIT_SEED == 20261015
    assert split.digest == SYNTHETIC_SPLIT_DIGEST


def test_should_change_the_digest_when_the_seed_changes() -> None:
    assert split_natives(_file(10), seed=1).digest != split_natives(_file(10)).digest


def test_should_change_the_digest_when_the_export_changes() -> None:
    assert split_natives(_file(11)).digest != split_natives(_file(10)).digest


def test_should_keep_whole_natives_in_file_order_when_selecting_a_part() -> None:
    # Given
    events = _file(10)
    split = split_natives(events)
    # When
    dev = select_part(events, split, "dev")
    held = select_part(events, split, "held-out")
    # Then
    assert [s.id for s in dev.subjects] == [s.id for s in events.subjects if s.id in split.dev]
    assert {s.id for s in held.subjects} == set(split.held_out)
    assert all(s.events for s in dev.subjects)


def test_should_refuse_a_split_whose_digest_is_not_the_pinned_one() -> None:
    with pytest.raises(RetrodictionInputError, match="split digest"):
        checked_split(_file(10), pinned="0" * 64)


def test_should_accept_the_split_when_its_digest_is_pinned() -> None:
    events = _file(10)
    assert checked_split(events, pinned=SYNTHETIC_SPLIT_DIGEST).digest == SYNTHETIC_SPLIT_DIGEST


def test_should_pin_the_licensed_export_split_digest() -> None:
    assert ADB_SPLIT_DIGEST == PINNED_ADB_SPLIT_DIGEST


@pytest.mark.skipif(
    "ALMAMESH_ADB_EXPORT" not in os.environ, reason="licensed export lives outside git"
)
def test_should_reproduce_the_pinned_split_when_the_export_is_present() -> None:
    events = import_adb(Path(os.environ["ALMAMESH_ADB_EXPORT"])).events
    assert split_natives(events).digest == PINNED_ADB_SPLIT_DIGEST
