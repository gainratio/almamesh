"""Public-doc discovery preserves Git ownership across a source-only export."""

from __future__ import annotations

import json
import runpy
import subprocess
from pathlib import Path
from typing import Any

import pytest

from tests import test_readme_contract as readme_contract

REPO_ROOT = Path(__file__).resolve().parents[2]
MANIFEST_NAME = ".almamesh-public-docs.json"


@pytest.fixture
def helper() -> dict[str, Any]:
    return runpy.run_path(str(REPO_ROOT / "scripts/public_docs_manifest.py"))


def write(root: Path, path: str, contents: str = "public fixture\n") -> None:
    target = root / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(contents, encoding="utf-8")


@pytest.fixture
def checkout(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "checkout"
    root.mkdir()
    (root / ".git").mkdir()
    write(root, ".gitignore", "docs/private/\ndocs/legacy/\ndocs/*.local.md\n")
    write(root, "docs/Guide.md")
    write(root, "docs/legacy/tracked.md")
    write(root, "docs/New.md")
    write(root, "docs/private/note.md", "must stay private")
    write(root, "docs/legacy/untracked.md", "ignored scratch")
    write(root, "docs/owner.local.md", "must stay private")

    def git_run(
        arguments: list[str], *, cwd: Path, check: bool, capture_output: bool, text: bool
    ) -> subprocess.CompletedProcess[str]:
        # Assert the real host-Git boundary; the UV test image itself has no Git.
        assert cwd.resolve() == root.resolve()
        assert check and capture_output and text
        outputs = {
            (
                "git",
                "ls-files",
                "-z",
                "--cached",
                "--others",
                "--exclude-standard",
                "--",
                "docs/",
            ): (
                "docs/Guide.md\x00docs/legacy/tracked.md\x00docs/New.md\x00docs/owner.local.md\x00"
            ),
            ("git", "rev-parse", "--show-toplevel"): str(root) + "\n",
            ("git", "rev-parse", "--verify", "HEAD"): "a" * 40 + "\n",
            ("git", "rev-parse", "HEAD"): "a" * 40 + "\n",
        }
        return subprocess.CompletedProcess(arguments, 0, stdout=outputs[tuple(arguments)])

    monkeypatch.setattr(subprocess, "run", git_run)
    return root


@pytest.fixture
def archive(tmp_path: Path) -> Path:
    root = tmp_path / "archive"
    root.mkdir()
    paths = ["docs/Guide.md", "docs/New.md", "docs/legacy/tracked.md"]
    for name in [*paths, "docs/private/note.md", "docs/owner.local.md"]:
        write(root, name)
    write(
        root, MANIFEST_NAME, json.dumps({"version": 1, "source_commit": "a" * 40, "paths": paths})
    )
    return root


def test_git_export_preserves_tracked_ignored_and_untracked_public_docs(
    checkout: Path, helper: dict[str, Any]
) -> None:
    paths = helper["public_doc_paths"](checkout)
    assert paths == ["docs/Guide.md", "docs/New.md", "docs/legacy/tracked.md"]
    helper["write_public_docs_manifest"](checkout, checkout / MANIFEST_NAME)
    payload = json.loads((checkout / MANIFEST_NAME).read_text(encoding="utf-8"))
    assert payload["version"] == 1
    assert len(payload["source_commit"]) == 40
    assert payload["paths"] == paths
    assert (
        payload["source_commit"]
        == subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=checkout, check=True, capture_output=True, text=True
        ).stdout.strip()
    )


def test_real_checkout_uses_git_instead_of_a_stale_manifest(
    checkout: Path, helper: dict[str, Any]
) -> None:
    write(checkout, MANIFEST_NAME, "invalid old manifest")
    assert helper["public_doc_paths"](checkout) == [
        "docs/Guide.md",
        "docs/New.md",
        "docs/legacy/tracked.md",
    ]


def test_archive_uses_validated_manifest_without_git(
    archive: Path, helper: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PATH", "/nonexistent")
    assert helper["public_doc_paths"](archive) == [
        "docs/Guide.md",
        "docs/New.md",
        "docs/legacy/tracked.md",
    ]


def test_git_failure_never_falls_back_to_manifest(
    checkout: Path, helper: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    helper["write_public_docs_manifest"](checkout, checkout / MANIFEST_NAME)
    monkeypatch.setenv("PATH", "/nonexistent")

    def missing_git(*_arguments: object, **_keywords: object) -> None:
        raise FileNotFoundError("git")

    monkeypatch.setattr(subprocess, "run", missing_git)
    with pytest.raises(helper["PublicDocsManifestError"], match="Git"):
        helper["public_doc_paths"](checkout)


def test_missing_archive_manifest_fails_with_host_generation_instruction(
    tmp_path: Path, helper: dict[str, Any]
) -> None:
    write(tmp_path, "docs/Guide.md")
    with pytest.raises(helper["PublicDocsManifestError"], match="scripts/public_docs_manifest.py"):
        helper["public_doc_paths"](tmp_path)


@pytest.mark.parametrize(
    "paths",
    [
        [],
        "docs/Guide.md",
        ["../private.md"],
        ["/docs/Guide.md"],
        ["docs/../README.md"],
        ["docs//Guide.md"],
        ["docs\\Guide.md"],
        ["docs/owner.local.md"],
        ["docs/missing.md"],
        ["docs/Guide.md", "docs/Guide.md"],
        ["docs/New.md", "docs/Guide.md"],
        [1],
    ],
)
def test_archive_rejects_invalid_or_nonpublic_paths(
    archive: Path, helper: dict[str, Any], paths: object
) -> None:
    write(archive, "docs/owner.local.md", "private")
    payload = {"version": 1, "source_commit": "a" * 40, "paths": paths}
    write(archive, MANIFEST_NAME, json.dumps(payload))
    with pytest.raises(helper["PublicDocsManifestError"]):
        helper["public_doc_paths"](archive)


@pytest.mark.parametrize(
    "payload",
    [None, [], {}, {"version": True}, {"version": 2}, {"version": 1, "source_commit": "main"}],
)
def test_archive_rejects_malformed_provenance(
    archive: Path, helper: dict[str, Any], payload: object
) -> None:
    write(archive, MANIFEST_NAME, json.dumps(payload))
    with pytest.raises(helper["PublicDocsManifestError"]):
        helper["public_doc_paths"](archive)


def test_archive_rejects_invalid_json(archive: Path, helper: dict[str, Any]) -> None:
    write(archive, MANIFEST_NAME, "{bad json")
    with pytest.raises(helper["PublicDocsManifestError"]):
        helper["public_doc_paths"](archive)


def test_archive_rejects_a_symlink_outside_the_export(
    archive: Path, helper: dict[str, Any], tmp_path: Path
) -> None:
    write(tmp_path, "private.md", "private")
    (archive / "docs/Guide.md").unlink()
    (archive / "docs/Guide.md").symlink_to(tmp_path / "private.md")
    with pytest.raises(helper["PublicDocsManifestError"]):
        helper["public_doc_paths"](archive)


def test_archive_readme_contract_detects_an_unlinked_public_doc(
    archive: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    links = [*readme_contract.ROOT_DOCS, "docs/Guide.md", "docs/legacy/"]
    write(archive, "README.md", "## More detail\n" + "\n".join(f"[doc]({p})" for p in links))
    monkeypatch.setattr(readme_contract, "REPO_ROOT", archive)
    monkeypatch.setattr(readme_contract, "README", archive / "README.md")
    monkeypatch.setenv("PATH", "/nonexistent")
    with pytest.raises(AssertionError, match="docs/New.md"):
        readme_contract.test_more_detail_links_every_technical_doc()


def test_archive_readme_contract_ignores_private_notes_without_reading_docs(
    archive: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    links = [*readme_contract.ROOT_DOCS, "docs/Guide.md", "docs/New.md", "docs/legacy/"]
    write(archive, "README.md", "## More detail\n" + "\n".join(f"[doc]({p})" for p in links))
    monkeypatch.setattr(readme_contract, "REPO_ROOT", archive)
    monkeypatch.setattr(readme_contract, "README", archive / "README.md")
    monkeypatch.setenv("PATH", "/nonexistent")
    original_read_text = Path.read_text

    def guarded_read_text(path: Path, *arguments: Any, **keywords: Any) -> str:
        assert not path.is_relative_to(archive / "docs")
        return original_read_text(path, *arguments, **keywords)

    monkeypatch.setattr(Path, "read_text", guarded_read_text)
    readme_contract.test_more_detail_links_every_technical_doc()


def test_archive_readme_contract_requires_tracked_ignored_folder_links(
    archive: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    links = [*readme_contract.ROOT_DOCS, "docs/Guide.md", "docs/New.md"]
    write(archive, "README.md", "## More detail\n" + "\n".join(f"[doc]({p})" for p in links))
    monkeypatch.setattr(readme_contract, "REPO_ROOT", archive)
    monkeypatch.setattr(readme_contract, "README", archive / "README.md")
    monkeypatch.setenv("PATH", "/nonexistent")
    with pytest.raises(AssertionError, match="docs/legacy/"):
        readme_contract.test_more_detail_links_every_technical_doc()
