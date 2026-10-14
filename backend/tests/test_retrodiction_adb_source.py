"""Opening an Astro-Databank export safely: path guard, zip handling, password, XML prologue.

Every refusal here is one line and leaves nothing on disk. Fixtures are FAKE natives.
"""

from __future__ import annotations

import subprocess
import zipfile
from pathlib import Path

import pytest

from almamesh.retrodiction import adb_source
from almamesh.retrodiction.adb import import_adb
from almamesh.retrodiction.adb_source import (
    KEYCHAIN_SERVICE,
    PASSWORD_ENV,
    keychain_password,
    zip_password,
)
from almamesh.retrodiction.events import RetrodictionInputError
from tests.adb_xml import (
    FakeEntry,
    aes_marked_zip,
    export_xml,
    plain_zip,
    zipcrypto_zip,
)

_PASSWORD = b"correct horse"
_XML = export_xml((FakeEntry(),))


def _password() -> bytes:
    return _PASSWORD


def _refused(path: Path, match: str) -> None:
    with pytest.raises(RetrodictionInputError, match=match):
        import_adb(path, password=_password)


def test_should_stream_a_zipcrypto_export_with_the_keychain_password(tmp_path: Path) -> None:
    # Given an encrypted export, the shape Astrodienst ships to licensees
    path = zipcrypto_zip(tmp_path / "adb_export_1.zip", "adb_export_1.xml", _XML, _PASSWORD)
    # When imported with the right password
    result = import_adb(path, password=_password)
    # Then it parses in memory and leaves no plaintext next to the archive
    assert result.summary.subjects_kept == 1
    assert sorted(p.name for p in tmp_path.iterdir()) == ["adb_export_1.zip"]


def test_should_refuse_a_wrong_password(tmp_path: Path) -> None:
    path = zipcrypto_zip(tmp_path / "e.zip", "e.xml", _XML, b"another password")
    _refused(path, "wrong password")


def test_should_refuse_a_corrupt_member(tmp_path: Path) -> None:
    # Given a stored member whose bytes no longer match its CRC
    path = tmp_path / "c.zip"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_STORED) as archive:
        archive.writestr("c.xml", _XML)
    raw = bytearray(path.read_bytes())
    at = raw.find(b"<important_notice>")
    raw[at + 1] = ord("X")
    path.write_bytes(bytes(raw))
    # When imported / Then refused as corrupt, not half-read
    _refused(path, "corrupt")


def test_should_refuse_aes_encryption(tmp_path: Path) -> None:
    _refused(aes_marked_zip(tmp_path / "a.zip", "a.xml", _XML), "AES")


def test_should_refuse_an_export_inside_a_git_tree(tmp_path: Path) -> None:
    # Given a licensed export copied into a repository checkout
    (tmp_path / ".git").mkdir()
    (tmp_path / "data").mkdir()
    path = plain_zip(tmp_path / "data" / "export.zip", {"x.xml": _XML})
    # When imported / Then refused: the licence says the data stays confidential
    _refused(path, "git working tree")


def test_should_refuse_a_missing_file(tmp_path: Path) -> None:
    _refused(tmp_path / "nope.zip", "cannot read")


def test_should_refuse_a_file_that_is_not_a_zip(tmp_path: Path) -> None:
    path = tmp_path / "export.zip"
    path.write_text(_XML)
    _refused(path, "not a zip")


@pytest.mark.parametrize(
    "members",
    [{"adb_license.pdf": "pdf"}, {"a.xml": _XML, "b.xml": _XML}],
)
def test_should_refuse_a_zip_without_exactly_one_xml(
    tmp_path: Path, members: dict[str, str]
) -> None:
    _refused(plain_zip(tmp_path / "z.zip", members), "exactly one .xml")


def test_should_pick_the_xml_next_to_the_licence_pdf(tmp_path: Path) -> None:
    # Given the licensed layout: the export plus the personalised licence PDF
    path = plain_zip(tmp_path / "z.zip", {"adb_license.pdf": "pdf", "adb_export.xml": _XML})
    # When imported / Then the XML member is the one parsed
    assert import_adb(path, password=_password).summary.subjects_kept == 1


@pytest.mark.parametrize(
    "prologue",
    [
        '<!DOCTYPE lolz [<!ENTITY lol "lol">]>',
        '<!DOCTYPE x SYSTEM "file:///etc/passwd">',
    ],
)
def test_should_refuse_a_document_type_declaration(tmp_path: Path, prologue: str) -> None:
    # Given an export carrying a DTD (entity expansion or an external fetch)
    xml = export_xml((FakeEntry(),), prologue=prologue)
    # When imported / Then refused at the declaration, before any entity expands
    _refused(plain_zip(tmp_path / "d.zip", {"d.xml": xml}), "DTD")


def test_should_refuse_another_root_element(tmp_path: Path) -> None:
    xml = '<?xml version="1.0"?><astrodatabank_exports></astrodatabank_exports>'
    _refused(plain_zip(tmp_path / "r.zip", {"r.xml": xml}), "not an Astro-Databank export")


def test_should_refuse_malformed_xml(tmp_path: Path) -> None:
    xml = export_xml((FakeEntry(),)).replace("</astrodatabank_export>", "")
    _refused(plain_zip(tmp_path / "m.zip", {"m.xml": xml}), "malformed XML")


def test_should_refuse_an_expat_without_amplification_limits(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Given a Python linked against expat older than 2.4.1 (no billion-laughs guard)
    monkeypatch.setattr(adb_source, "EXPAT_VERSION", (2, 4, 0))
    # When imported / Then refused rather than parsing untrusted XML unguarded
    _refused(plain_zip(tmp_path / "x.zip", {"x.xml": _XML}), "expat")


def _fake_security(stdout: bytes, returncode: int) -> object:
    def run(args: list[str], **_: object) -> subprocess.CompletedProcess[bytes]:
        assert args == ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]
        return subprocess.CompletedProcess(args, returncode, stdout=stdout, stderr=b"")

    return run


def test_should_read_the_password_from_the_keychain(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(adb_source.subprocess, "run", _fake_security(b"s3cret\n", 0))
    assert keychain_password() == b"s3cret"


@pytest.mark.parametrize(("stdout", "code"), [(b"leak-me\n", 44), (b"\n", 0)])
def test_should_refuse_a_missing_keychain_item_without_echoing_it(
    monkeypatch: pytest.MonkeyPatch, stdout: bytes, code: int
) -> None:
    monkeypatch.setattr(adb_source.subprocess, "run", _fake_security(stdout, code))
    with pytest.raises(RetrodictionInputError, match=KEYCHAIN_SERVICE) as caught:
        keychain_password()
    assert "leak-me" not in str(caught.value)


def test_should_refuse_when_the_security_tool_is_absent(monkeypatch: pytest.MonkeyPatch) -> None:
    def missing(*_: object, **__: object) -> None:
        raise FileNotFoundError("security")

    monkeypatch.setattr(adb_source.subprocess, "run", missing)
    with pytest.raises(RetrodictionInputError, match="macOS Keychain"):
        keychain_password()


def _keychain_must_not_run(*_: object, **__: object) -> None:
    raise AssertionError("the environment password must win over the Keychain")


def test_should_prefer_the_environment_password(monkeypatch: pytest.MonkeyPatch) -> None:
    # Given the password exported in the environment (the Keychain item may be stale)
    monkeypatch.setenv(PASSWORD_ENV, "from-env")
    monkeypatch.setattr(adb_source.subprocess, "run", _keychain_must_not_run)
    # When the zip password is resolved / Then the environment wins
    assert zip_password() == b"from-env"


def test_should_fall_back_to_the_keychain_when_the_variable_is_unset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv(PASSWORD_ENV, raising=False)
    monkeypatch.setattr(adb_source.subprocess, "run", _fake_security(b"from-keychain\n", 0))
    assert zip_password() == b"from-keychain"


def test_should_refuse_an_empty_environment_password(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(PASSWORD_ENV, "")
    monkeypatch.setattr(adb_source.subprocess, "run", _keychain_must_not_run)
    with pytest.raises(RetrodictionInputError, match=f"{PASSWORD_ENV} is set but empty"):
        zip_password()


def test_should_open_an_encrypted_export_with_the_environment_password(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Given an encrypted export and the password only in the environment
    monkeypatch.setenv(PASSWORD_ENV, _PASSWORD.decode())
    monkeypatch.setattr(adb_source.subprocess, "run", _keychain_must_not_run)
    path = zipcrypto_zip(tmp_path / "adb_export_2.zip", "adb_export_2.xml", _XML, _PASSWORD)
    # When imported with the default password source / Then it opens
    assert import_adb(path).summary.subjects_kept == 1


def test_should_not_echo_a_wrong_environment_password(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(PASSWORD_ENV, "not-the-password-xyz")
    path = zipcrypto_zip(tmp_path / "w.zip", "w.xml", _XML, _PASSWORD)
    with pytest.raises(RetrodictionInputError, match="wrong password") as caught:
        import_adb(path)
    assert "not-the-password-xyz" not in str(caught.value)


def test_should_import_a_plain_decrypted_xml_without_a_password(tmp_path: Path) -> None:
    # Given the export already decrypted to a bare .xml file
    path = tmp_path / "adb_export_1.xml"
    path.write_text(_XML, encoding="utf-8")
    # When imported / Then it streams from the file and never asks for a password
    result = import_adb(path, password=_keychain_must_not_run)  # type: ignore[arg-type]
    assert result.summary.subjects_kept == 1


def test_should_refuse_a_plain_xml_inside_a_git_tree(tmp_path: Path) -> None:
    (tmp_path / ".git").mkdir()
    path = tmp_path / "adb_export_1.xml"
    path.write_text(_XML, encoding="utf-8")
    _refused(path, "git working tree")


def test_should_apply_the_dtd_guard_to_a_plain_xml(tmp_path: Path) -> None:
    path = tmp_path / "adb_export_1.xml"
    path.write_text(export_xml((FakeEntry(),), prologue='<!DOCTYPE x [<!ENTITY a "b">]>'))
    _refused(path, "DTD")
