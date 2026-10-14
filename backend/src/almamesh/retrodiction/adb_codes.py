"""The frozen Astro-Databank event-type table: ADB ``evn_id`` -> eval ``EventCategory``.

A pre-registration choice like ``mapping.MAPPING``: changing it changes the pinned
``adb_codes_digest`` and needs a dated amendment in the retrodiction spec. It holds only
ADB's event-type vocabulary (id + label), never a data record. An event maps only when
BOTH its ``evn_id`` and its ``sevcode`` label match a row here, so a renumbered or
renamed type is reported as unmapped instead of silently scored under the wrong area.

Deliberately unmapped (reviewed 2026-10-14):
- the native's own death (763-774, 1012): the eval has no "own death" category;
- 799 death of a significant person: not family;
- 807 meet a significant person: may be a mentor, not a romance;
- 826 / 910 institutionalised or released (prison OR hospital): legal or health is unknown;
- 818 contracts, 820/1013 social status, 823 prize, 824 published: no single target;
- mental-health, crime-victim, mundane and misc codes: outside the 15 categories.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from types import MappingProxyType
from typing import Final

from almamesh.retrodiction.events import EventCategory


@dataclass(frozen=True)
class AdbCode:
    """One ADB event type as the export labels it, and the category it scores under."""

    label: str
    category: EventCategory


_C = EventCategory
_ROWS: Final[tuple[tuple[int, str, EventCategory], ...]] = (
    (816, "Work : New Career", _C.CAREER_CHANGE),
    (964, "Work : Start Business", _C.CAREER_CHANGE),
    (2869, "Work : Retired", _C.CAREER_CHANGE),
    (822, "Work : New Job", _C.JOB_START),
    (819, "Work : Fired/Laid off/Quit", _C.JOB_LOSS),
    (925, "Crime : Law suit", _C.LEGAL),
    (1930, "Crime : Trial dates", _C.LEGAL),
    (988, "Crime : Arrest", _C.LEGAL),
    (808, "Relationship : Begin significant relationship", _C.RELATIONSHIP_START),
    (810, "Relationship : Marriage", _C.MARRIAGE),
    (811, "Relationship : Divorce dates", _C.SEPARATION),
    (809, "Relationship : End significant relationship", _C.SEPARATION),
    (775, "Family : Change residence", _C.RELOCATION),
    (746, "Health : Medical diagnosis", _C.HEALTH),
    (747, "Health : Medical procedure", _C.HEALTH),
    (991, "Health : Acute illness", _C.HEALTH),
    (745, "Health : Chronic illness", _C.HEALTH),
    (743, "Health : Accident (Non-fatal)", _C.ACCIDENT),
    (918, "Health : Job related injury", _C.ACCIDENT),
    (800, "Family : Adopted a child", _C.BIRTH_OF_CHILD),
    (794, "Death of Child", _C.DEATH_IN_FAMILY),
    (795, "Death of Mate", _C.DEATH_IN_FAMILY),
    (796, "Death of Mother", _C.DEATH_IN_FAMILY),
    (797, "Death of Father", _C.DEATH_IN_FAMILY),
    (798, "Death of Sibling", _C.DEATH_IN_FAMILY),
    (1014, "Financial : Gain significant money", _C.FINANCIAL_GAIN),
    (761, "Financial : Inherited money", _C.FINANCIAL_GAIN),
    (760, "Financial : Lose significant money", _C.FINANCIAL_LOSS),
    (759, "Financial : Bankruptcy", _C.FINANCIAL_LOSS),
    (829, "Social : Begin a program of study", _C.EDUCATION),
    (913, "Social : End a program of study", _C.EDUCATION),
)

ADB_EVENT_CODES: Final = MappingProxyType(
    {evn_id: AdbCode(label, category) for evn_id, label, category in _ROWS}
)


def adb_codes_digest() -> str:
    """SHA-256 of the table as canonical JSON (id -> [label, category])."""
    table = {str(i): [c.label, c.category.value] for i, c in sorted(ADB_EVENT_CODES.items())}
    return hashlib.sha256(json.dumps(table, sort_keys=True).encode()).hexdigest()


__all__ = ["ADB_EVENT_CODES", "AdbCode", "adb_codes_digest"]
