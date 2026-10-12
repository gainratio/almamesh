"""Export Git-owned public documentation paths for source-only CI containers.

Run on the host checkout before exporting source:
    python3 scripts/public_docs_manifest.py --repo-root . --output .almamesh-public-docs.json

Local checkouts always ask Git directly. An archive must carry this explicit
manifest; a filesystem walk cannot distinguish tracked ignored documentation
from private ignored notes.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path, PurePosixPath

MANIFEST_NAME = ".almamesh-public-docs.json"
GENERATION_COMMAND = (
    "python3 scripts/public_docs_manifest.py --repo-root . --output .almamesh-public-docs.json"
)


class PublicDocsManifestError(ValueError):
    """The documentation export lacks a valid, explicit public-path inventory."""


def _git_output(repo_root: Path, *arguments: str) -> str:
    try:
        result = subprocess.run(
            ["git", *arguments],
            cwd=repo_root,
            capture_output=True,
            text=True,
            check=True,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        raise PublicDocsManifestError(
            f"Git public-doc enumeration failed; run `{GENERATION_COMMAND}` "
            "in the host checkout before exporting source."
        ) from error
    return result.stdout


def _validate_paths(repo_root: Path, value: object) -> list[str]:
    if not isinstance(value, list) or not value:
        raise PublicDocsManifestError("Public-doc paths must be a nonempty sorted list.")
    paths: list[str] = []
    for path in value:
        if not isinstance(path, str):
            raise PublicDocsManifestError("Every public-doc path must be a string.")
        relative = PurePosixPath(path)
        if (
            relative.is_absolute()
            or len(relative.parts) < 2
            or relative.parts[0] != "docs"
            or ".." in relative.parts
            or relative.as_posix() != path
            or "\\" in path
            or "\x00" in path
            or path.endswith(".local.md")
        ):
            raise PublicDocsManifestError(f"Invalid or private public-doc path: {path!r}")
        target = repo_root / path
        if (
            not target.is_file()
            or target.is_symlink()
            or not target.resolve().is_relative_to(repo_root.resolve())
        ):
            raise PublicDocsManifestError(
                f"Public-doc file missing or outside the export: {path!r}"
            )
        paths.append(path)
    if paths != sorted(set(paths)):
        raise PublicDocsManifestError("Public-doc paths must be sorted and unique.")
    return paths


def git_public_doc_paths(repo_root: Path) -> list[str]:
    """Include tracked files and new nonignored files; never read doc contents."""
    listed = _git_output(
        repo_root, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "docs/"
    )
    paths = sorted(
        {path for path in listed.split("\x00") if path and not path.endswith(".local.md")}
    )
    return _validate_paths(repo_root, paths)


def write_public_docs_manifest(repo_root: Path, output: Path) -> None:
    """Capture the host checkout's Git identity and public-path inventory."""
    root = repo_root.resolve()
    git_root = Path(_git_output(root, "rev-parse", "--show-toplevel").strip()).resolve()
    if git_root != root:
        raise PublicDocsManifestError("--repo-root must be the Git checkout root.")
    source_commit = _git_output(root, "rev-parse", "--verify", "HEAD").strip()
    if re.fullmatch(r"[0-9a-f]{40}", source_commit) is None:
        raise PublicDocsManifestError("Git HEAD must identify one exact source commit.")
    payload = {"version": 1, "source_commit": source_commit, "paths": git_public_doc_paths(root)}
    output.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def public_doc_paths(repo_root: Path) -> list[str]:
    """Use Git in a checkout; require the host manifest in a source-only export."""
    if (repo_root / ".git").exists():
        return git_public_doc_paths(repo_root)
    manifest = repo_root / MANIFEST_NAME
    try:
        payload = json.loads(manifest.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise PublicDocsManifestError(
            f"Public-doc manifest missing; run `{GENERATION_COMMAND}` "
            "in the host Git checkout before exporting source."
        ) from error
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise PublicDocsManifestError(
            "Public-doc manifest is unreadable or invalid JSON."
        ) from error
    if (
        not isinstance(payload, dict)
        or set(payload) != {"version", "source_commit", "paths"}
        or type(payload.get("version")) is not int
        or payload["version"] != 1
        or not isinstance(payload.get("source_commit"), str)
        or re.fullmatch(r"[0-9a-f]{40}", payload["source_commit"]) is None
    ):
        raise PublicDocsManifestError(
            "Public-doc manifest has invalid version or source provenance."
        )
    return _validate_paths(repo_root, payload["paths"])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    parser.add_argument("--output", type=Path, default=Path(MANIFEST_NAME))
    arguments = parser.parse_args()
    root = arguments.repo_root.resolve()
    output = arguments.output if arguments.output.is_absolute() else root / arguments.output
    try:
        write_public_docs_manifest(root, output)
    except (OSError, PublicDocsManifestError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
