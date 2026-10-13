"""Download and safely extract one named artifact of one GitHub Actions run.

The browser-journeys status job runs this inside Dagger (fleet rule: no shell in
workflows) to read the evidence its own run uploaded:

    GITHUB_TOKEN=... python3 scripts/fetch_run_artifact.py \
        --repository gainratio/almamesh --run-id 123 --name NAME --output DIR

The token goes only to the GitHub API. The archive download answers with a
redirect to a pre-signed storage URL, which is fetched without the token.
Stdlib only: the Dagger image has Python and nothing else.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath
from tempfile import TemporaryFile
from typing import IO, Any

API_URL = "https://api.github.com"
MAX_ARCHIVE_BYTES = 1 << 30
TIMEOUT_SECONDS = 60
REPOSITORY = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+")
RUN_ID = re.compile(r"[1-9][0-9]{0,19}")
ARTIFACT_NAME = re.compile(r"[A-Za-z0-9._-]{1,200}")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args: object, **_kwargs: object) -> None:
        return None


def _get(url: str, token: str | None) -> IO[bytes]:
    headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    opener = urllib.request.build_opener(_NoRedirect)
    response: IO[bytes] = opener.open(
        urllib.request.Request(url, headers=headers), timeout=TIMEOUT_SECONDS
    )
    return response


def _require_identity(repository: str, run_id: str, name: str) -> None:
    for pattern, value in ((REPOSITORY, repository), (RUN_ID, run_id), (ARTIFACT_NAME, name)):
        if pattern.fullmatch(value) is None:
            raise SystemExit(f"invalid artifact identity: {value!r}")


def _unexpired(api_url: str, repository: str, run_id: str, name: str, token: str) -> list[Any]:
    query = urllib.parse.urlencode({"name": name, "per_page": 100})
    with _get(f"{api_url}/repos/{repository}/actions/runs/{run_id}/artifacts?{query}", token) as r:
        listed: list[Any] = json.load(r).get("artifacts", [])
    return [a for a in listed if a.get("name") == name and a.get("expired") is False]


def _newest_download_url(api_url: str, repository: str, run_id: str, name: str, token: str) -> str:
    matches = _unexpired(api_url, repository, run_id, name, token)
    if not matches:
        raise SystemExit(f"no unexpired artifact {name!r} in run {run_id}")
    url = str(max(matches, key=lambda item: int(item["id"]))["archive_download_url"])
    if not url.startswith(f"{api_url}/repos/{repository}/actions/artifacts/"):
        raise SystemExit("artifact download URL is outside this repository")
    return url


def _signed_location(download_url: str, token: str) -> str:
    try:
        _get(download_url, token).close()
    except urllib.error.HTTPError as redirect:
        location = redirect.headers.get("Location", "")
        if redirect.code in (301, 302, 303, 307, 308) and location.startswith(
            ("https://", "http://")
        ):
            return str(location)
        raise SystemExit(f"artifact download answered HTTP {redirect.code}") from redirect
    raise SystemExit("artifact download did not redirect to signed storage")


def _download(location: str, sink: IO[bytes]) -> None:
    with _get(location, None) as response:
        while chunk := response.read(1 << 20):
            if sink.tell() + len(chunk) > MAX_ARCHIVE_BYTES:
                raise SystemExit("artifact archive exceeds the size limit")
            sink.write(chunk)


def _extract(archive: zipfile.ZipFile, output: Path) -> None:
    for member in archive.namelist():
        path = PurePosixPath(member)
        if path.is_absolute() or ".." in path.parts or "\\" in member:
            raise SystemExit(f"unsafe archive member: {member!r}")
    output.mkdir(parents=True)
    archive.extractall(output)


def fetch_run_artifact(
    api_url: str, repository: str, run_id: str, name: str, output: Path, token: str
) -> None:
    """Extract the newest unexpired `name` artifact of `run_id` into a new `output` dir."""
    _require_identity(repository, run_id, name)
    if output.exists():
        raise SystemExit(f"output already exists: {output}")
    download_url = _newest_download_url(api_url, repository, run_id, name, token)
    location = _signed_location(download_url, token)
    with TemporaryFile() as sink:
        _download(location, sink)
        sink.seek(0)
        with zipfile.ZipFile(sink) as archive:
            _extract(archive, output)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ("--repository", "--run-id", "--name"):
        parser.add_argument(flag, required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    token = os.environ.get("GITHUB_TOKEN", "")
    if not token.strip():
        raise SystemExit("GITHUB_TOKEN is required")
    fetch_run_artifact(
        API_URL, arguments.repository, arguments.run_id, arguments.name, arguments.output, token
    )


if __name__ == "__main__":
    main()
