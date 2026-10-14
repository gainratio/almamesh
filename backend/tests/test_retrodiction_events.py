"""Loading, validating and privacy-guarding retrodiction event files."""

from __future__ import annotations

from pathlib import Path

import pytest

from almamesh.retrodiction.events import (
    EventCategory,
    RetrodictionInputError,
    inside_git_tree,
    load_events,
)

_BIRTH = '{datetime: "1980-03-04T05:06:00+05:30", latitude: 13.08, longitude: 80.27}'


def _write(directory: Path, body: str, *, kind: str = "personal") -> Path:
    path = directory / "events.yaml"
    path.write_text(f"kind: {kind}\nlabel: test\nsource: unit test\n{body}", encoding="utf-8")
    return path


def _one_event(event: str, birth: str = _BIRTH) -> str:
    return f"subjects:\n  - id: a\n    birth: {birth}\n    events:\n      - {event}\n"


def test_loads_a_valid_month_event(tmp_path: Path) -> None:
    path = _write(tmp_path, _one_event("{category: job_start, date: '2019-05', precision: month}"))
    loaded = load_events(path)
    event = loaded.subjects[0].events[0]
    assert event.category is EventCategory.JOB_START
    assert event.month == (2019, 5)
    assert loaded.kind == "personal"


def test_a_day_event_resolves_to_its_month(tmp_path: Path) -> None:
    body = _one_event("{category: legal, date: '2019-11-21', precision: day, place: Chennai}")
    event = load_events(_write(tmp_path, body)).subjects[0].events[0]
    assert event.month == (2019, 11)
    assert event.place == "Chennai"


def test_a_year_event_has_no_month(tmp_path: Path) -> None:
    body = _one_event("{category: education, date: '2001', precision: year}")
    assert load_events(_write(tmp_path, body)).subjects[0].events[0].month is None


def test_kind_defaults_to_personal(tmp_path: Path) -> None:
    path = tmp_path / "e.yaml"
    path.write_text(_one_event("{category: health, date: '2010-01', precision: month}"))
    assert load_events(path).kind == "personal"


@pytest.mark.parametrize(
    ("event", "message"),
    [
        ("{category: lottery, date: '2019-05', precision: month}", "category"),
        ("{category: legal, date: '2019-05', precision: day}", "does not match precision"),
        ("{category: legal, date: '2019-13', precision: month}", "not a real date"),
        ("{category: legal, date: 'May 2019', precision: month}", "does not match precision"),
    ],
)
def test_malformed_events_are_refused(tmp_path: Path, event: str, message: str) -> None:
    with pytest.raises(RetrodictionInputError, match=message):
        load_events(_write(tmp_path, _one_event(event)))


def test_a_naive_birth_datetime_is_refused(tmp_path: Path) -> None:
    birth = '{datetime: "1980-03-04T05:06:00", latitude: 13.0, longitude: 80.0}'
    body = _one_event("{category: legal, date: '2019-05', precision: month}", birth)
    with pytest.raises(RetrodictionInputError, match="UTC offset"):
        load_events(_write(tmp_path, body))


def test_missing_birth_data_is_refused(tmp_path: Path) -> None:
    event = "{category: legal, date: '2019-05', precision: month}"
    body = f"subjects:\n  - id: a\n    events:\n      - {event}\n"
    with pytest.raises(RetrodictionInputError, match="birth"):
        load_events(_write(tmp_path, body))


def test_a_subject_without_events_is_refused(tmp_path: Path) -> None:
    body = f"subjects:\n  - id: a\n    birth: {_BIRTH}\n    events: []\n"
    with pytest.raises(RetrodictionInputError, match="events"):
        load_events(_write(tmp_path, body))


def test_a_public_set_without_provenance_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "p.yaml"
    path.write_text(
        "kind: public\n" + _one_event("{category: legal, date: '2019-05', precision: month}")
    )
    with pytest.raises(RetrodictionInputError, match="source"):
        load_events(path)


def test_invalid_yaml_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "bad.yaml"
    path.write_text("subjects: [unclosed\n")
    with pytest.raises(RetrodictionInputError, match="YAML"):
        load_events(path)


def test_a_non_mapping_document_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "list.yaml"
    path.write_text("- just\n- a list\n")
    with pytest.raises(RetrodictionInputError, match="mapping"):
        load_events(path)


def test_a_missing_file_is_refused(tmp_path: Path) -> None:
    with pytest.raises(RetrodictionInputError, match="cannot read"):
        load_events(tmp_path / "nope.yaml")


def test_a_personal_file_inside_a_git_tree_is_refused(tmp_path: Path) -> None:
    (tmp_path / ".git").mkdir()
    nested = tmp_path / "data"
    nested.mkdir()
    body = _one_event("{category: legal, date: '2019-05', precision: month}")
    with pytest.raises(RetrodictionInputError, match="inside a git working tree"):
        load_events(_write(nested, body))


def test_a_personal_file_in_a_worktree_checkout_is_refused(tmp_path: Path) -> None:
    (tmp_path / ".git").write_text("gitdir: /elsewhere\n")  # a linked worktree's .git is a file
    body = _one_event("{category: legal, date: '2019-05', precision: month}")
    with pytest.raises(RetrodictionInputError, match="inside a git working tree"):
        load_events(_write(tmp_path, body))


def test_a_synthetic_file_may_live_in_the_repo(tmp_path: Path) -> None:
    (tmp_path / ".git").mkdir()
    body = _one_event("{category: legal, date: '2019-05', precision: month}")
    assert load_events(_write(tmp_path, body, kind="synthetic")).kind == "synthetic"


def test_this_repository_counts_as_a_git_tree() -> None:
    assert inside_git_tree(Path(__file__))


def test_a_scratch_directory_is_not_a_git_tree(tmp_path: Path) -> None:
    assert not inside_git_tree(tmp_path / "events.yaml")


@pytest.mark.parametrize("name", ["events.example.yaml", "synthetic_null.yaml"])
def test_committed_event_files_are_synthetic(name: str) -> None:
    path = Path(__file__).resolve().parents[2] / "examples" / "retrodiction" / name
    assert load_events(path).kind == "synthetic"
