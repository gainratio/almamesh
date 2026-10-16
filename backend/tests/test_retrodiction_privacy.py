"""Licence guards: the published aggregates carry no record-level field, and the eval CLI
fails fast (never hangs, never reaches a network) when the private data is absent."""

from __future__ import annotations

import types
from pathlib import Path
from typing import Union, get_args, get_origin

import pytest
from pydantic import BaseModel
from typer.testing import CliRunner

from almamesh.retrodiction.cli import app
from almamesh.retrodiction.placebo_card import PlaceboCard
from almamesh.retrodiction.scorecard import Scorecard

RECORD_FIELDS = frozenset(
    {"id", "ids", "name", "birth", "datetime", "latitude", "longitude", "place", "events",
     "subject", "subjects", "native", "natives", "natives_ids", "adb_id", "date", "events_list"}
)  # fmt: skip


def _models_in(annotation: object) -> list[type[BaseModel]]:
    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        return [annotation]
    nested = get_args(annotation)
    if get_origin(annotation) in (Union, types.UnionType, list, tuple, dict) or nested:
        return [m for arg in nested for m in _models_in(arg)]
    return []


def field_names(model: type[BaseModel], seen: frozenset[type] = frozenset()) -> set[str]:
    """Every field name reachable from a published model, nested models included."""
    if model in seen:
        return set()
    names = set(model.model_fields)
    for info in model.model_fields.values():
        for child in _models_in(info.annotation):
            names |= field_names(child, seen | {model})
    return names


@pytest.mark.parametrize("model", [Scorecard, PlaceboCard])
def test_published_aggregates_have_no_record_level_field(model: type[BaseModel]) -> None:
    assert field_names(model) & RECORD_FIELDS == set()


def test_the_guard_sees_a_record_field_hidden_in_a_nested_model() -> None:
    class Row(BaseModel):
        adb_id: int

    class Card(BaseModel):
        rows: list[Row]

    assert field_names(Card) & RECORD_FIELDS == {"adb_id"}


@pytest.mark.parametrize(
    "command", ["retrodiction", "scorecard", "placebo-scorecard", "adb-summary"]
)
def test_a_missing_private_export_is_refused_with_a_clear_message(
    tmp_path: Path, command: str
) -> None:
    missing = tmp_path / "no-such-export.zip"
    result = CliRunner().invoke(app, [command, "--adb", str(missing)])
    assert result.exit_code == 2, result.output
    assert "refused" in result.output
    assert "no such file" in result.output
    assert not (tmp_path / "retrodiction-report").exists()
