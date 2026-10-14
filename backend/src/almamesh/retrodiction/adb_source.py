"""Opening an Astro-Databank export: the encrypted zip, its password, and a safe XML stream.

The licensed export is a zip holding one ``.xml`` (plus the licence PDF), encrypted with a
per-download password: read from ``$ALMAMESH_ADB_ZIP_PASSWORD``, or, only when that is unset,
from the macOS Keychain item of the same name. The value is never printed or logged.
The XML member is decrypted and parsed as a stream straight out of the archive, so no
plaintext copy ever touches the disk.

The parser is the stdlib expat-backed ``XMLParser`` with two guards: any document type
declaration is refused at the declaration (no entity can be defined, so none can expand,
and no external DTD is fetched), and expat must be >= 2.4.1, the first release with
billion-laughs amplification limits.
"""

from __future__ import annotations

import os
import subprocess
import zipfile
import zlib
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager, contextmanager
from pathlib import Path
from pyexpat import version_info
from typing import IO, Final
from xml.etree.ElementTree import Element, ParseError, TreeBuilder, XMLParser

from almamesh.retrodiction.events import RetrodictionInputError, inside_git_tree

PasswordSource = Callable[[], bytes]

PASSWORD_ENV: Final = "ALMAMESH_ADB_ZIP_PASSWORD"
KEYCHAIN_SERVICE: Final = PASSWORD_ENV
EXPAT_VERSION: tuple[int, int, int] = version_info
ROOT_TAG: Final = "astrodatabank_export"
_MIN_EXPAT: Final = (2, 4, 1)
_AES_METHOD: Final = 99
_ENCRYPTED_FLAG: Final = 0x1
_CHUNK: Final = 1 << 16


def keychain_password(service: str = KEYCHAIN_SERVICE) -> bytes:
    """The zip password from the macOS Keychain; never echoed, never logged."""
    command = ["security", "find-generic-password", "-s", service, "-w"]
    try:
        done = subprocess.run(command, capture_output=True, check=False)  # noqa: S603
    except FileNotFoundError as exc:
        raise RetrodictionInputError("the macOS Keychain `security` tool is missing") from exc
    password = done.stdout.rstrip(b"\r\n")
    if done.returncode != 0 or not password:
        raise RetrodictionInputError(
            f"no Keychain password under {service!r}; store it with "
            f'`security add-generic-password -a "$USER" -s {service} -w`'
        )
    return password


def zip_password() -> bytes:
    """``$ALMAMESH_ADB_ZIP_PASSWORD`` when set (it wins), else the Keychain item."""
    value = os.environ.get(PASSWORD_ENV)
    if value is None:
        return keychain_password()
    if not value:
        raise RetrodictionInputError(f"{PASSWORD_ENV} is set but empty")
    return value.encode()


def _guard_path(path: Path) -> None:
    if not path.is_file():
        raise RetrodictionInputError(f"cannot read {path}: no such file")
    if inside_git_tree(path):
        raise RetrodictionInputError(
            f"{path} is licensed Astro-Databank data inside a git working tree; keep it "
            "outside (e.g. ~/.almamesh/retrodiction/adb/)"
        )


def _archive(path: Path) -> zipfile.ZipFile:
    try:
        return zipfile.ZipFile(path)
    except zipfile.BadZipFile as exc:
        raise RetrodictionInputError(f"{path} is not a zip archive") from exc


def _xml_member(archive: zipfile.ZipFile) -> zipfile.ZipInfo:
    members = [i for i in archive.infolist() if i.filename.lower().endswith(".xml")]
    if len(members) != 1:
        raise RetrodictionInputError(
            f"the export zip must hold exactly one .xml member, found {len(members)}"
        )
    return members[0]


def _open_member(
    archive: zipfile.ZipFile, member: zipfile.ZipInfo, password: PasswordSource
) -> IO[bytes]:
    if member.compress_type == _AES_METHOD:
        raise RetrodictionInputError(
            "the export uses WinZip AES encryption, which the stdlib cannot read"
        )
    secret = password() if member.flag_bits & _ENCRYPTED_FLAG else None
    try:
        return archive.open(member, pwd=secret)
    except RuntimeError as exc:
        raise RetrodictionInputError(f"wrong password for {member.filename}") from exc


@contextmanager
def _zip_stream(path: Path, password: PasswordSource) -> Iterator[IO[bytes]]:
    with _archive(path) as archive, _open_member(archive, _xml_member(archive), password) as raw:
        yield raw


def open_export(path: Path, password: PasswordSource) -> AbstractContextManager[IO[bytes]]:
    """A byte stream of the export: a plain ``.xml`` file, or the ``.xml`` inside the zip
    (decrypted on the fly, nothing extracted to disk). The password is asked only for an
    encrypted zip member."""
    _guard_path(path)
    if path.suffix.lower() == ".xml":
        return path.open("rb")
    return _zip_stream(path, password)


class _ExportBuilder(TreeBuilder):
    """Collects each finished top-level element; refuses DTDs and foreign roots."""

    def __init__(self) -> None:
        super().__init__()
        self.ready: list[Element] = []
        self._depth = 0

    def doctype(self, name: str, pubid: str | None, system: str | None) -> None:
        raise RetrodictionInputError("refusing an export that declares a DTD (entities)")

    def start(self, tag: str, attrs: dict[str, str]) -> Element:
        if self._depth == 0 and tag != ROOT_TAG:
            raise RetrodictionInputError(f"not an Astro-Databank export (root <{tag}>)")
        element = super().start(tag, attrs)
        self._depth += 1
        if self._depth == 1:
            self.ready.append(element)
        return element

    def end(self, tag: str) -> Element:
        element = super().end(tag)
        self._depth -= 1
        if self._depth == 1:
            self.ready.append(element)
        return element


def _chunks(raw: IO[bytes]) -> Iterator[bytes]:
    try:
        yield from iter(lambda: raw.read(_CHUNK), b"")
    except (zlib.error, zipfile.BadZipFile) as exc:
        raise RetrodictionInputError("corrupt archive (or wrong password)") from exc


def _drain(builder: _ExportBuilder) -> Iterator[Element]:
    """Hand out each ready element once, then empty it so 80k entries never pile up."""
    while builder.ready:
        element = builder.ready.pop(0)
        yield element
        element.clear()


def iter_export(raw: IO[bytes]) -> Iterator[Element]:
    """The root (at its start tag, attributes only) then each finished top-level child."""
    if EXPAT_VERSION < _MIN_EXPAT:
        raise RetrodictionInputError("this Python's expat lacks entity-amplification limits")
    builder = _ExportBuilder()
    parser = XMLParser(target=builder)
    try:
        for chunk in _chunks(raw):
            parser.feed(chunk)
            yield from _drain(builder)
        parser.close()
    except ParseError as exc:
        raise RetrodictionInputError(f"malformed XML: {exc}") from exc


__all__ = [
    "EXPAT_VERSION",
    "KEYCHAIN_SERVICE",
    "PASSWORD_ENV",
    "PasswordSource",
    "iter_export",
    "keychain_password",
    "open_export",
    "zip_password",
]
