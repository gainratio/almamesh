"""The browser-journey status job reads its own run's evidence artifact, and nothing else."""

from __future__ import annotations

import io
import json
import runpy
import threading
import zipfile
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
REPOSITORY = "gainratio/almamesh"
RUN_ID = "4242"
NAME = "browser-journeys-evidence-" + "1" * 40
TOKEN = "ghs_fixture_token"


@dataclass
class FakeGitHub:
    """One API host and one blob host on different origins, recording every request."""

    artifacts: list[dict[str, object]] = field(default_factory=list)
    archive: bytes = b""
    seen: list[tuple[str, str, str | None]] = field(default_factory=list)
    api_url: str = ""
    blob_url: str = ""


def zipped(files: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, contents in files.items():
            archive.writestr(name, contents)
    return buffer.getvalue()


def handler_for(state: FakeGitHub, host: str) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args: object) -> None:
            return

        def do_GET(self) -> None:  # noqa: N802 (http.server API)
            state.seen.append((host, self.path, self.headers.get("Authorization")))
            if host == "blob":
                self.reply(200, state.archive)
            elif "/actions/runs/" in self.path:
                body = {"total_count": len(state.artifacts), "artifacts": state.artifacts}
                self.reply(200, json.dumps(body).encode())
            else:
                self.send_response(302)
                self.send_header("Location", state.blob_url + "/signed?sig=abc")
                self.end_headers()

        def reply(self, status: int, body: bytes) -> None:
            self.send_response(status)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return Handler


@pytest.fixture
def github() -> Iterator[FakeGitHub]:
    state = FakeGitHub()
    servers = [
        ThreadingHTTPServer(("127.0.0.1", 0), handler_for(state, "api")),
        ThreadingHTTPServer(("localhost", 0), handler_for(state, "blob")),
    ]
    for server in servers:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    state.api_url = f"http://127.0.0.1:{servers[0].server_port}"
    state.blob_url = f"http://localhost:{servers[1].server_port}"
    yield state
    for server in servers:
        server.shutdown()


def artifact(state: FakeGitHub, artifact_id: int, *, expired: bool = False) -> dict[str, object]:
    url = f"{state.api_url}/repos/{REPOSITORY}/actions/artifacts/{artifact_id}/zip"
    return {"id": artifact_id, "name": NAME, "expired": expired, "archive_download_url": url}


@pytest.fixture
def fetch() -> Callable[..., None]:
    helper: dict[str, Any] = runpy.run_path(str(REPO_ROOT / "scripts/fetch_run_artifact.py"))
    function: Callable[..., None] = helper["fetch_run_artifact"]
    return function


def run(fetch: Callable[..., None], state: FakeGitHub, output: Path) -> None:
    fetch(state.api_url, REPOSITORY, RUN_ID, NAME, output, TOKEN)


def test_extracts_the_newest_unexpired_artifact_of_the_named_run(
    github: FakeGitHub, fetch: Callable[..., None], tmp_path: Path
) -> None:
    github.artifacts = [
        artifact(github, 7),
        artifact(github, 9),
        artifact(github, 11, expired=True),
    ]
    github.archive = zipped({"journey-status.json": b"{}", "time-travel/trace.zip": b"trace"})
    run(fetch, github, tmp_path / "evidence")
    assert (tmp_path / "evidence/journey-status.json").read_bytes() == b"{}"
    assert (tmp_path / "evidence/time-travel/trace.zip").read_bytes() == b"trace"
    listing, download, blob = github.seen
    assert (
        listing[1]
        == f"/repos/{REPOSITORY}/actions/runs/{RUN_ID}/artifacts?name={NAME}&per_page=100"
    )
    assert download[1] == f"/repos/{REPOSITORY}/actions/artifacts/9/zip"
    assert listing[2] == download[2] == f"Bearer {TOKEN}"
    # The signed blob URL carries its own authority; the token never leaves GitHub's API.
    assert blob == ("blob", "/signed?sig=abc", None)


def test_a_missing_artifact_fails_closed(
    github: FakeGitHub, fetch: Callable[..., None], tmp_path: Path
) -> None:
    github.artifacts = [artifact(github, 3, expired=True)]
    with pytest.raises(SystemExit, match="no unexpired artifact"):
        run(fetch, github, tmp_path / "evidence")
    assert not (tmp_path / "evidence").exists()


def test_a_download_url_outside_this_repository_is_refused(
    github: FakeGitHub, fetch: Callable[..., None], tmp_path: Path
) -> None:
    foreign = artifact(github, 5)
    foreign["archive_download_url"] = f"{github.api_url}/repos/other/repo/actions/artifacts/5/zip"
    github.artifacts = [foreign]
    with pytest.raises(SystemExit, match="outside"):
        run(fetch, github, tmp_path / "evidence")
    assert len(github.seen) == 1


@pytest.mark.parametrize("member", ["../escape.txt", "/abs.txt", "a/../../escape.txt"])
def test_an_archive_member_escaping_the_output_is_refused(
    github: FakeGitHub, fetch: Callable[..., None], tmp_path: Path, member: str
) -> None:
    github.artifacts = [artifact(github, 1)]
    github.archive = zipped({member: b"x"})
    with pytest.raises(SystemExit, match="unsafe archive member"):
        run(fetch, github, tmp_path / "out" / "evidence")
    assert not (tmp_path / "out" / "escape.txt").exists()
    assert not (tmp_path / "escape.txt").exists()


@pytest.mark.parametrize(
    ("repository", "run_id", "name"),
    [
        ("gainratio/almamesh/x", RUN_ID, NAME),
        (REPOSITORY, "12a", NAME),
        (REPOSITORY, RUN_ID, "a&b"),
    ],
)
def test_malformed_identity_is_refused_before_any_request(
    github: FakeGitHub,
    fetch: Callable[..., None],
    tmp_path: Path,
    repository: str,
    run_id: str,
    name: str,
) -> None:
    with pytest.raises(SystemExit, match="invalid"):
        fetch(github.api_url, repository, run_id, name, tmp_path / "evidence", TOKEN)
    assert github.seen == []
