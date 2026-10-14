"""The frozen ADB event-type -> eval category table (code only, no ADB records)."""

from __future__ import annotations

from almamesh.retrodiction.adb_codes import ADB_EVENT_CODES, adb_codes_digest
from almamesh.retrodiction.events import EventCategory

# Pinned literal: a table change goes red here and needs a dated spec amendment.
ADB_CODES_DIGEST = "617f06c555819a90ad24b58e37948daa7e6f4398dfda13fcda2c8623f41ef2af"


def test_should_pin_the_adb_code_table_digest() -> None:
    assert adb_codes_digest() == ADB_CODES_DIGEST


def test_should_map_relatives_deaths_but_never_the_natives_own_death() -> None:
    relatives = {794, 795, 796, 797, 798}
    assert {ADB_EVENT_CODES[i].category for i in relatives} == {EventCategory.DEATH_IN_FAMILY}
    own_death = {763, 764, 766, 767, 768, 769, 770, 771, 772, 774, 1012}
    assert own_death.isdisjoint(ADB_EVENT_CODES)


def test_should_route_core_work_and_relationship_codes() -> None:
    assert ADB_EVENT_CODES[822].category is EventCategory.JOB_START
    assert ADB_EVENT_CODES[819].category is EventCategory.JOB_LOSS
    assert ADB_EVENT_CODES[810].category is EventCategory.MARRIAGE
    assert ADB_EVENT_CODES[811].category is EventCategory.SEPARATION
    assert ADB_EVENT_CODES[775].category is EventCategory.RELOCATION


def test_should_leave_ambiguous_codes_unmapped() -> None:
    # prison-or-hospital, meet-someone, significant non-relative, contracts
    assert {826, 807, 799, 818}.isdisjoint(ADB_EVENT_CODES)
