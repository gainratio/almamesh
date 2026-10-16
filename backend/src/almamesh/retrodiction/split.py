"""The one-time split of natives into a DEV half and a HELD-OUT half (amendment d).

By native, never by event, so a native's events stay together. 50/50 with
``random.Random(SPLIT_SEED)`` over the charted (post-1900) natives in file order. The
digest is SHA-256 over the export's content digest, the seed and both sorted id
lists; the licensed export's digest is pinned in ``ADB_SPLIT_DIGEST`` and the CLI
refuses to score a half whose split does not reproduce it. Every exploratory run uses
DEV; HELD-OUT is scored only for a release candidate.
"""

from __future__ import annotations

import hashlib
import json
import random
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, Literal

from almamesh.retrodiction.engine import birth_in_range
from almamesh.retrodiction.events import RetrodictionInputError

if TYPE_CHECKING:
    from almamesh.retrodiction.events import EventsFile, Subject

Part = Literal["dev", "held-out"]

SPLIT_SEED: Final[int] = 20261015
ADB_SPLIT_DIGEST: Final[str] = "299ec3937460a109c44a125943bc8f8f77da57259c545094f43c5d7c008664ca"


@dataclass(frozen=True)
class NativeSplit:
    """Both halves as sorted native ids, and the digest that pins them."""

    dev: tuple[str, ...]
    held_out: tuple[str, ...]
    digest: str


def _subject_record(subject: Subject) -> list[object]:
    birth = subject.birth
    events = [[e.category.value, e.date, e.precision] for e in subject.events]
    return [subject.id, birth.datetime.isoformat(), birth.latitude, birth.longitude, events]


def export_digest(events: EventsFile) -> str:
    """SHA-256 of the scored content (ids, births, events) in file order."""
    records = [_subject_record(s) for s in events.subjects]
    return hashlib.sha256(json.dumps(records).encode()).hexdigest()


def _digest(events: EventsFile, seed: int, dev: list[str], held_out: list[str]) -> str:
    body = {"export": export_digest(events), "seed": seed, "dev": dev, "held_out": held_out}
    return hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()


def _charted_ids(events: EventsFile) -> list[str]:
    return [s.id for s in events.subjects if birth_in_range(s.birth)]


def split_natives(events: EventsFile, seed: int = SPLIT_SEED) -> NativeSplit:
    """Half of the charted natives to DEV, the rest to HELD-OUT, seeded."""
    kept = _charted_ids(events)
    chosen = frozenset(random.Random(seed).sample(range(len(kept)), len(kept) // 2))
    dev = sorted(kept[i] for i in chosen)
    held_out = sorted(set(kept) - set(dev))
    return NativeSplit(tuple(dev), tuple(held_out), _digest(events, seed, dev, held_out))


def checked_split(events: EventsFile, pinned: str = ADB_SPLIT_DIGEST) -> NativeSplit:
    """The split, refused unless it reproduces the pinned digest."""
    split = split_natives(events)
    if split.digest != pinned:
        raise RetrodictionInputError(
            f"split digest {split.digest[:12]} is not the pinned {pinned[:12]}; "
            "a changed export or seed needs a dated amendment"
        )
    return split


def select_part(events: EventsFile, split: NativeSplit, part: Part) -> EventsFile:
    """The natives of one half, in file order, with all their events."""
    ids = frozenset(split.dev if part == "dev" else split.held_out)
    label = f"{events.label} [{part}, split {split.digest[:12]}]"
    subjects = [s for s in events.subjects if s.id in ids]
    return events.model_copy(update={"subjects": subjects, "label": label})


__all__ = [
    "ADB_SPLIT_DIGEST",
    "SPLIT_SEED",
    "NativeSplit",
    "Part",
    "checked_split",
    "export_digest",
    "select_part",
    "split_natives",
]
