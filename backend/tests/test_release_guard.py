"""Release preflight: signed bundle sequence must not roll back live."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from edgeproc.bundles.manifest import VersionPointer, pointer_signing_bytes
from edgeproc.bundles.signing import Ed25519Signer, generate_keypair

from almamesh.edge import release_guard
from almamesh.edge.release_guard import ReleaseGuardError, compare_release_sequences, verify_pointer


def _pointer(
    signer: Ed25519Signer, *, sequence: int, manifest_hash: str = "a" * 64
) -> VersionPointer:
    unsigned = VersionPointer(
        manifest_hash=manifest_hash,
        version=f"0.0.{sequence}",
        bundle_id="almamesh-constructs",
        channel="stable",
        sequence=sequence,
        signature="",
    )
    return unsigned.model_copy(update={"signature": signer.sign(pointer_signing_bytes(unsigned))})


def test_verify_pointer_requires_a_valid_signed_stable_sequence() -> None:
    private_key, public_key = generate_keypair()
    signer = Ed25519Signer(private_key)
    pointer = _pointer(signer, sequence=3)

    assert verify_pointer(pointer, public_key) == pointer


def test_verify_pointer_rejects_a_forged_signature() -> None:
    private_key, public_key = generate_keypair()
    pointer = _pointer(Ed25519Signer(private_key), sequence=3)
    forged = pointer.model_copy(update={"signature": "not-a-signature"})

    with pytest.raises(ReleaseGuardError, match="signature"):
        verify_pointer(forged, public_key)


def test_verify_pointer_rejects_an_unbound_pointer() -> None:
    private_key, public_key = generate_keypair()
    signer = Ed25519Signer(private_key)
    unsigned = VersionPointer(
        manifest_hash="a" * 64,
        version="0.0.1",
        signature="",
    )
    pointer = unsigned.model_copy(
        update={"signature": signer.sign(pointer_signing_bytes(unsigned))}
    )

    with pytest.raises(ReleaseGuardError, match="stable AlmaMesh"):
        verify_pointer(pointer, public_key)


def test_verify_pointer_rejects_a_legacy_pointer_without_sequence() -> None:
    private_key, public_key = generate_keypair()
    signer = Ed25519Signer(private_key)
    unsigned = VersionPointer(
        manifest_hash="a" * 64,
        version="0.0.1",
        bundle_id="almamesh-constructs",
        channel="stable",
        signature="",
    )
    pointer = unsigned.model_copy(
        update={"signature": signer.sign(pointer_signing_bytes(unsigned))}
    )

    with pytest.raises(ReleaseGuardError, match="no monotonic"):
        verify_pointer(pointer, public_key)


def test_compare_release_sequences_accepts_a_newer_signed_release() -> None:
    private_key, _ = generate_keypair()
    signer = Ed25519Signer(private_key)

    compare_release_sequences(_pointer(signer, sequence=8), _pointer(signer, sequence=7))


def test_compare_release_sequences_accepts_an_exact_idempotent_redeploy() -> None:
    private_key, _ = generate_keypair()
    signer = Ed25519Signer(private_key)
    pointer = _pointer(signer, sequence=8)

    compare_release_sequences(pointer, pointer)


def test_compare_release_sequences_rejects_a_rollback() -> None:
    private_key, _ = generate_keypair()
    signer = Ed25519Signer(private_key)

    with pytest.raises(ReleaseGuardError, match="lower than live"):
        compare_release_sequences(_pointer(signer, sequence=7), _pointer(signer, sequence=8))


def test_compare_release_sequences_rejects_equal_sequence_equivocation() -> None:
    private_key, _ = generate_keypair()
    signer = Ed25519Signer(private_key)

    with pytest.raises(ReleaseGuardError, match="different pointer"):
        compare_release_sequences(
            _pointer(signer, sequence=8, manifest_hash="b" * 64),
            _pointer(signer, sequence=8),
        )


def test_run_validates_a_local_candidate_file(tmp_path: Path) -> None:
    private_key, public_key = generate_keypair()
    candidate_path, public_path = tmp_path / "latest", tmp_path / "public.key"
    candidate_path.write_bytes(
        _pointer(Ed25519Signer(private_key), sequence=2).model_dump_json().encode()
    )
    public_path.write_bytes(public_key.public_bytes_raw())

    release_guard.run(candidate_path, public_path, None)


def test_run_compares_the_candidate_with_the_verified_live_pointer(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    private_key, public_key = generate_keypair()
    candidate = _pointer(Ed25519Signer(private_key), sequence=2)
    candidate_path, public_path = tmp_path / "latest", tmp_path / "public.key"
    candidate_path.write_bytes(candidate.model_dump_json().encode())
    public_path.write_bytes(public_key.public_bytes_raw())
    monkeypatch.setattr(
        release_guard,
        "_fetch_pointer",
        lambda _url: _pointer(Ed25519Signer(private_key), sequence=1),
    )

    release_guard.run(candidate_path, public_path, "https://almamesh.com/bundle/latest")


def test_fetch_pointer_adds_a_cache_buster(monkeypatch: pytest.MonkeyPatch) -> None:
    private_key, public_key = generate_keypair()
    pointer = _pointer(Ed25519Signer(private_key), sequence=2)
    calls: list[tuple[str, dict[str, str]]] = []

    class Response:
        def __enter__(self) -> Response:
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def read(self) -> bytes:
            return pointer.model_dump_json().encode()

    def fake_urlopen(request: object, *, timeout: int) -> Response:
        calls.append((request.full_url, request.headers))  # type: ignore[attr-defined]
        assert timeout == 30
        return Response()

    monkeypatch.setattr(release_guard, "urlopen", fake_urlopen)
    fetched = release_guard._fetch_pointer("https://almamesh.com/bundle/latest")

    assert fetched == pointer
    assert calls == [
        (
            "https://almamesh.com/bundle/latest?release_guard=1",
            {
                "Cache-control": "no-cache",
                "User-agent": "AlmaMesh-ReleaseGuard/1.0",
                "Accept": "application/json",
            },
        )
    ]


def test_live_preflight_requires_https_transport() -> None:
    with pytest.raises(ReleaseGuardError, match="HTTPS"):
        release_guard._live_url("http://almamesh.com/bundle/latest")


def test_main_reports_a_successful_preflight(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    tmp_path: Path,
) -> None:
    private_key, public_key = generate_keypair()
    candidate_path, public_path = tmp_path / "latest", tmp_path / "public.key"
    candidate_path.write_bytes(
        _pointer(Ed25519Signer(private_key), sequence=2).model_dump_json().encode()
    )
    public_path.write_bytes(public_key.public_bytes_raw())
    monkeypatch.setattr(
        sys,
        "argv",
        ["release_guard", "--candidate", str(candidate_path), "--public-key", str(public_path)],
    )

    assert release_guard.main() == 0
    assert capsys.readouterr().out == "release preflight passed\n"


def _stamped_pointer(
    signer: Ed25519Signer,
    *,
    sequence: int,
    key_id: str | None = None,
    expires_at: int | None = None,
) -> VersionPointer:
    """A pointer carrying the edge-proc 0.5 signed keyring fields the browser tier honors."""
    unsigned = VersionPointer(
        manifest_hash="a" * 64,
        version=f"0.0.{sequence}",
        bundle_id="almamesh-constructs",
        channel="stable",
        sequence=sequence,
        key_id=key_id,
        expires_at=expires_at,
        signature="",
    )
    return unsigned.model_copy(update={"signature": signer.sign(pointer_signing_bytes(unsigned))})


def test_verify_pointer_accepts_a_pointer_naming_the_pinned_key() -> None:
    private_key, public_key = generate_keypair()
    signer = Ed25519Signer(private_key)
    pointer = _stamped_pointer(signer, sequence=3, key_id=signer.key_id)

    assert verify_pointer(pointer, public_key) == pointer


def test_verify_pointer_rejects_a_pointer_naming_another_key() -> None:
    # The signature is genuine, but the pointer names a key the pinned trust root does not
    # hold. @gainratio/browser refuses it (a named key is the only key tried), so the release
    # preflight must refuse it before it ships rather than after every device rejects it.
    private_key, public_key = generate_keypair()
    pointer = _stamped_pointer(Ed25519Signer(private_key), sequence=3, key_id="0" * 16)

    with pytest.raises(ReleaseGuardError, match="signature"):
        verify_pointer(pointer, public_key)


def test_verify_pointer_rejects_an_expired_candidate() -> None:
    private_key, public_key = generate_keypair()
    pointer = _stamped_pointer(Ed25519Signer(private_key), sequence=3, expires_at=1)

    with pytest.raises(ReleaseGuardError, match="expired"):
        verify_pointer(pointer, public_key)


def test_verify_pointer_judges_expiry_against_the_injected_clock() -> None:
    private_key, public_key = generate_keypair()
    pointer = _stamped_pointer(Ed25519Signer(private_key), sequence=3, expires_at=2_000)

    assert verify_pointer(pointer, public_key, clock=lambda: 1_999.0) == pointer
    with pytest.raises(ReleaseGuardError, match="expired"):
        verify_pointer(pointer, public_key, clock=lambda: 2_000.0)
