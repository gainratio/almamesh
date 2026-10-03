"""The Python half of the cross-language strength-receipt conformance proof.

The engine computes each domain's ``StrengthSummary`` in Python; the browser
Worker SIGNS it in TypeScript (``@gainratio/avow``). That split is only sound if
both sides canonicalize a subject to the SAME bytes and sign it to the SAME
Ed25519 signature.

``testdata/vectors/domain-strength-receipt.json`` is the shared proof. This module
asserts the vectors really are what the Python ``avow`` kernel produces; the
TypeScript suite (``@almamesh/browser``'s ``strengthReceipt.test.ts``) asserts the
TS signer reproduces them, and that it verifies Python-minted receipts. Neither
half is meaningful alone — together they pin the byte-compatibility that licenses
signing outside Pyodide.

``avow`` is a TEST-ONLY dependency here: it is the oracle, never engine code.
``test_engine_is_crypto_free.py`` fails the build if ``src/almamesh`` ever imports
it.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from avow import RECEIPT_SCHEMA, canonical_bytes, content_hash, public_key_hex, sign_payload
from nacl.signing import SigningKey

_VECTORS = (
    Path(__file__).resolve().parents[2] / "testdata" / "vectors" / "domain-strength-receipt.json"
)


def _load() -> dict[str, Any]:
    loaded: dict[str, Any] = json.loads(_VECTORS.read_text(encoding="utf-8"))
    return loaded


def test_vector_file_is_reachable() -> None:
    """Non-vacuity: the shared fixture must exist where BOTH suites look for it."""
    assert _VECTORS.is_file(), f"shared vectors not found at {_VECTORS}"


def test_vectors_cover_the_jcs_number_hazards() -> None:
    """Non-vacuity: the vectors must actually stress where naive encoders drift."""
    data = _load()
    assert len(data["receipts"]) >= 2
    canonical = "".join(r["canonical_hex"] for r in data["receipts"])
    assert "36302c" in canonical, 'expected 60.0 to canonicalize as "60"'
    assert "31652d372c" in canonical, 'expected 1e-07 to canonicalize as "1e-7"'


def test_public_key_derives_from_the_vector_seed() -> None:
    data = _load()
    key = SigningKey(bytes.fromhex(data["seed_hex"]))
    assert public_key_hex(key) == data["public_key"]


def test_python_kernel_reproduces_every_vector() -> None:
    """The committed vectors ARE Python-kernel output — canonical bytes, hash, signature.

    If `rfc8785` or PyNaCl ever changed encoding, this fails here rather than
    silently drifting away from the TypeScript signer."""
    data = _load()
    key = SigningKey(bytes.fromhex(data["seed_hex"]))
    for vector in data["receipts"]:
        subject = vector["subject"]
        message = canonical_bytes(subject)
        assert message.hex() == vector["canonical_hex"], subject["domain"]
        assert content_hash(subject) == vector["payload_hash"], subject["domain"]
        assert key.sign(message).signature.hex() == vector["signature"], subject["domain"]


def test_vectors_are_full_receipts_from_python_sign_payload() -> None:
    """Each vector is the complete envelope Python's ``sign_payload`` emits.

    avow 0.5 made receipts self-describing (a required ``schema`` field that
    ``verify_signature`` checks first). Pinning the whole envelope, not just the
    signed bytes, means a future envelope change fails here and forces a re-mint
    with ``tools/mint_strength_receipt_vectors.py`` instead of drifting."""
    data = _load()
    assert data["receipt_schema"] == RECEIPT_SCHEMA
    key = SigningKey(bytes.fromhex(data["seed_hex"]))
    for vector in data["receipts"]:
        receipt = sign_payload(vector["subject"], key).model_dump(mode="json", by_alias=True)
        assert receipt["schema"] == data["receipt_schema"], vector["subject"]["domain"]
        assert receipt["payload_hash"] == vector["payload_hash"]
        assert receipt["public_key"] == data["public_key"]
        assert receipt["signature"] == vector["signature"]


def test_vector_subjects_match_the_real_strength_summary_schema() -> None:
    """The vectors must be REAL subjects, not a convenient shape that drifted.

    A receipt seals ``{domain, summary}`` where ``summary`` is the engine's
    ``StrengthSummary`` dump. Validating the vector payload against the live model
    is what stops the conformance proof from quietly testing a fiction."""
    from almamesh.schemas.domains import LifeDomain, StrengthSummary

    for vector in _load()["receipts"]:
        subject = vector["subject"]
        assert subject["domain"] in {member.value for member in LifeDomain}
        summary = StrengthSummary.model_validate(subject["summary"])
        # Round-trips to the SAME dict the vector signed — no coercion drift.
        assert summary.model_dump(mode="json") == subject["summary"]
