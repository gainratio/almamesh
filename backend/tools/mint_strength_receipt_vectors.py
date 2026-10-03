"""Re-mint the shared strength-receipt golden vectors — DEV-ONLY.

Run after an ``avow`` upgrade changes the receipt envelope:

    cd backend && uv run python tools/mint_strength_receipt_vectors.py

It keeps the committed subjects, seed and comment, and rewrites every derived
field (``receipt_schema``, ``public_key``, ``canonical_hex``, ``payload_hash``,
``signature``) from the Python ``avow`` kernel's own ``sign_payload``. Both
``tests/test_strength_receipt_vectors.py`` and the TypeScript
``strengthReceipt.test.ts`` then check their kernel against the file. Review the
diff: a change to the signed bytes means old and new kernels disagree.
"""

from __future__ import annotations

import json
from pathlib import Path

from avow import RECEIPT_SCHEMA, canonical_bytes, public_key_hex, sign_payload
from avow.canonical import JsonValue
from nacl.signing import SigningKey

VECTORS = (
    Path(__file__).resolve().parents[2] / "testdata" / "vectors" / "domain-strength-receipt.json"
)


def _vector(subject: JsonValue, key: SigningKey) -> dict[str, JsonValue]:
    """One vector: the subject plus the fields Python avow derives from it."""
    receipt = sign_payload(subject, key)
    return {
        "subject": subject,
        "canonical_hex": canonical_bytes(subject).hex(),
        "payload_hash": receipt.payload_hash,
        "signature": receipt.signature,
    }


def mint(data: dict[str, JsonValue], subjects: list[JsonValue]) -> dict[str, JsonValue]:
    """Return the vector file with every derived field recomputed by Python avow."""
    key = SigningKey(bytes.fromhex(str(data["seed_hex"])))
    return {
        "_comment": data["_comment"],
        "receipt_schema": RECEIPT_SCHEMA,
        "seed_hex": data["seed_hex"],
        "public_key": public_key_hex(key),
        "receipts": [_vector(subject, key) for subject in subjects],
    }


def main() -> None:
    data = json.loads(VECTORS.read_text(encoding="utf-8"))
    subjects = [vector["subject"] for vector in data["receipts"]]
    VECTORS.write_text(json.dumps(mint(data, subjects), indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
