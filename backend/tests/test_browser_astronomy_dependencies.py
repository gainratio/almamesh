"""The signed browser astronomy wheel must satisfy the backend's real contract.

Read wheel METADATA rather than trusting its filename: offline Worker installs use
``deps=False``, so neither micropip nor the backend resolver checks this boundary.
"""

import re
import tomllib
from email import message_from_bytes
from pathlib import Path
from zipfile import ZipFile

import pytest
from packaging.requirements import Requirement
from packaging.utils import canonicalize_name, parse_wheel_filename
from packaging.version import Version

_BACKEND = Path(__file__).resolve().parents[1]
_REPO = _BACKEND.parent


def _browser_skyfield() -> tuple[Path, Version]:
    found = []
    for path in (_BACKEND / "offline_wheels").glob("*.whl"):
        with ZipFile(path) as wheel:
            metadata_paths = [
                name for name in wheel.namelist() if name.endswith(".dist-info/METADATA")
            ]
            assert len(metadata_paths) == 1, path.name
            metadata = message_from_bytes(wheel.read(metadata_paths[0]))
        if canonicalize_name(metadata["Name"]) == "skyfield":
            version = Version(metadata["Version"])
            name, filename_version, _, tags = parse_wheel_filename(path.name)
            assert name == "skyfield" and filename_version == version
            assert {str(tag) for tag in tags} == {"py3-none-any"}
            found.append((path, version))
    assert len(found) == 1, "Browser bundle must contain exactly one pure Python Skyfield wheel"
    return found[0]


def test_browser_skyfield_satisfies_declared_backend_requirement() -> None:
    _, version = _browser_skyfield()
    project = tomllib.loads((_BACKEND / "pyproject.toml").read_text())
    requirement = next(
        parsed
        for dependency in project["project"]["dependencies"]
        if canonicalize_name((parsed := Requirement(dependency)).name) == "skyfield"
    )
    assert version in requirement.specifier, f"Browser Skyfield {version} violates {requirement}"


def test_browser_skyfield_matches_locked_backend_version() -> None:
    _, browser_version = _browser_skyfield()
    lock = tomllib.loads((_BACKEND / "uv.lock").read_text())
    backend_version = Version(
        next(pkg["version"] for pkg in lock["package"] if pkg["name"] == "skyfield")
    )
    assert browser_version == backend_version, (
        f"Browser Skyfield {browser_version} differs from locked backend {backend_version}"
    )


@pytest.mark.parametrize(
    "relative_path",
    [
        "frontend/apps/web/src/providers/AlmaMeshRuntimeProvider.tsx",
        "frontend/packages/browser/integration/parity.mjs",
        "frontend/packages/browser/integration/rectification-precision.mjs",
    ],
)
def test_browser_skyfield_configuration_resolves_to_actual_wheel(relative_path: str) -> None:
    wheel, _ = _browser_skyfield()
    source = (_REPO / relative_path).read_text()
    configured = re.findall(r"['\"](?:wheels/)?(skyfield-[^'\"/]+\.whl)['\"]", source)
    assert configured == [wheel.name], f"{relative_path} does not load the vendored Skyfield wheel"
