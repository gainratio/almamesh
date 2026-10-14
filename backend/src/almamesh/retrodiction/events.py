"""The retrodiction event file: typed models, refusals, and the personal-data guard.

A ``personal`` file (the default kind) must live outside every git working tree, so a
real person's birth data and life events can never be committed by accident.
"""

from __future__ import annotations

import datetime as dt
import re
from datetime import date
from enum import StrEnum
from pathlib import Path
from typing import Annotated, Final, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

Kind = Literal["personal", "public", "synthetic"]
Precision = Literal["day", "month", "year"]

_DATE_SHAPES: Final[dict[str, re.Pattern[str]]] = {
    "day": re.compile(r"^(\d{4})-(\d{2})-(\d{2})$"),
    "month": re.compile(r"^(\d{4})-(\d{2})$"),
    "year": re.compile(r"^(\d{4})$"),
}


class RetrodictionInputError(ValueError):
    """An event file the eval refuses to score (one line, nothing written)."""


class EventCategory(StrEnum):
    """The closed set of life-event categories the eval can score."""

    CAREER_CHANGE = "career_change"
    JOB_START = "job_start"
    JOB_LOSS = "job_loss"
    LEGAL = "legal"
    RELATIONSHIP_START = "relationship_start"
    MARRIAGE = "marriage"
    SEPARATION = "separation"
    RELOCATION = "relocation"
    HEALTH = "health"
    ACCIDENT = "accident"
    BIRTH_OF_CHILD = "birth_of_child"
    DEATH_IN_FAMILY = "death_in_family"
    FINANCIAL_GAIN = "financial_gain"
    FINANCIAL_LOSS = "financial_loss"
    EDUCATION = "education"


def _date_parts(text: str, precision: str) -> tuple[int, ...]:
    """The numeric parts of ``text``; refuses a shape that disagrees with ``precision``."""
    match = _DATE_SHAPES[precision].match(text)
    if match is None:
        raise ValueError(f"date {text!r} does not match precision {precision!r}")
    parts = tuple(int(p) for p in match.groups())
    year, month, day = (*parts, 1, 1)[:3]
    try:
        date(year, month, day)
    except ValueError as exc:
        raise ValueError(f"date {text!r} is not a real date") from exc
    return parts


class LifeEvent(BaseModel):
    """One dated life event."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    category: EventCategory
    date: str
    precision: Precision
    place: str | None = None

    @field_validator("date", mode="before")
    @classmethod
    def _as_text(cls, value: object) -> object:
        return value.isoformat() if isinstance(value, date) else str(value)

    @model_validator(mode="after")
    def _shape_matches_precision(self) -> LifeEvent:
        _date_parts(self.date, self.precision)
        return self

    @property
    def month(self) -> tuple[int, int] | None:
        """(year, month) for day/month precision; None for a year-only event."""
        parts = _date_parts(self.date, self.precision)
        return (parts[0], parts[1]) if len(parts) > 1 else None


class Birth(BaseModel):
    """Birth instant with its civil UTC offset, and coordinates."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    datetime: dt.datetime
    latitude: Annotated[float, Field(ge=-90, le=90)]
    longitude: Annotated[float, Field(ge=-180, le=180)]

    @field_validator("datetime")
    @classmethod
    def _aware(cls, value: dt.datetime) -> dt.datetime:
        if value.utcoffset() is None:
            raise ValueError("birth datetime needs its UTC offset, e.g. +05:30")
        return value


class Subject(BaseModel):
    """One native: birth data and their events."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    id: str
    birth: Birth
    events: Annotated[list[LifeEvent], Field(min_length=1)]


class EventsFile(BaseModel):
    """A whole event file."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    kind: Kind = "personal"
    label: str = "events"
    source: str | None = None
    subjects: Annotated[list[Subject], Field(min_length=1)]

    @model_validator(mode="after")
    def _public_needs_source(self) -> EventsFile:
        if self.kind == "public" and not self.source:
            raise ValueError("a public set needs a source (provenance and licence)")
        return self


def inside_git_tree(path: Path) -> bool:
    """True when ``path`` sits under a directory holding ``.git`` (a dir or a worktree file)."""
    return any((parent / ".git").exists() for parent in path.resolve().parents)


def _read_mapping(path: Path) -> dict[str, object]:
    """The YAML document as a mapping, or a refusal."""
    try:
        document = yaml.safe_load(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise RetrodictionInputError(f"cannot read {path}: {exc.strerror}") from exc
    except yaml.YAMLError as exc:
        raise RetrodictionInputError(f"{path} is not valid YAML: {exc}") from exc
    if not isinstance(document, dict):
        raise RetrodictionInputError(f"{path} must be a YAML mapping with a 'subjects' list")
    return document


def _validated(document: dict[str, object]) -> EventsFile:
    """The typed file, or a refusal naming the first bad field."""
    try:
        return EventsFile.model_validate(document)
    except ValidationError as exc:
        first = exc.errors()[0]
        where = ".".join(str(p) for p in first["loc"]) or "file"
        raise RetrodictionInputError(f"{where}: {first['msg']}") from exc


def load_events(path: Path) -> EventsFile:
    """Load an event file; refuse malformed input and personal files inside a git tree."""
    loaded = _validated(_read_mapping(path))
    if loaded.kind == "personal" and inside_git_tree(path):
        raise RetrodictionInputError(
            f"{path} is personal data inside a git working tree; move it outside "
            "(e.g. ~/.almamesh/retrodiction/) or mark a fake set kind: synthetic"
        )
    return loaded


__all__ = [
    "Birth",
    "EventCategory",
    "EventsFile",
    "LifeEvent",
    "RetrodictionInputError",
    "Subject",
    "inside_git_tree",
    "load_events",
]
