"""Offline asset bundle: the full set the in-browser Pyodide engine needs to boot.

The signed bundle must carry everything the browser loads OFFLINE after first
sync: the skyfield-stack pure-Python wheels (`jplephem`, `sgp4`, `skyfield`),
the almamesh wheel,
the DE421 ephemeris, `finals2000A.all`, and signed meta.
(Pyodide's runtime + numpy ship as app static assets, NOT in this bundle.)

The real `de421.bsp` is 16 MB; the CLI stages it at publish time from
`~/.skyfield-data`. This unit test substitutes small STUB bytes for the two
skyfield-data files so the round trip stays fast + machine-independent, while
still proving byte-identity end to end.
"""

import json

from edgeproc.bundles.signing import Ed25519Signer, Ed25519Verifier, generate_keypair

from almamesh.edge.bundle import (
    gather_offline_wheels,
    publish_offline_bundle,
    read_synced_file,
    sync_constructs,
)

_VENDORED_WHEELS = (
    "wheels/jplephem-2.23-py3-none-any.whl",
    "wheels/sgp4-2.25-py3-none-any.whl",
    "wheels/skyfield-1.55-py3-none-any.whl",
)


def _verifier(public_key: object) -> Ed25519Verifier:
    return Ed25519Verifier.from_public_bytes(public_key.public_bytes_raw())  # type: ignore[attr-defined]


def test_gather_offline_wheels_returns_pinned_wheels() -> None:
    wheels = gather_offline_wheels()
    assert set(wheels) == set(_VENDORED_WHEELS)
    assert all(blob[:2] == b"PK" for blob in wheels.values())  # real zip wheels


def _stub_skyfield_data(tmp_path) -> tuple:
    data_dir = tmp_path / "skyfield-data"
    data_dir.mkdir()
    (data_dir / "de421.bsp").write_bytes(b"DE421-STUB-EPHEMERIS")
    (data_dir / "finals2000A.all").write_bytes(b"FINALS2000A-STUB")
    return data_dir, b"DE421-STUB-EPHEMERIS", b"FINALS2000A-STUB"


def test_publish_offline_bundle_round_trips_every_asset(tmp_path) -> None:
    private_key, public_key = generate_keypair()
    origin, cache = tmp_path / "origin", tmp_path / "cache"
    almamesh_wheel = tmp_path / "almamesh-0.1.0-py3-none-any.whl"
    almamesh_wheel.write_bytes(b"ALMAMESH-WHEEL-BYTES")
    data_dir, de421, finals = _stub_skyfield_data(tmp_path)

    publish_offline_bundle(
        origin,
        Ed25519Signer(private_key),
        version="1.0.0",
        almamesh_wheel=almamesh_wheel,
        skyfield_data_dir=data_dir,
    )
    result = sync_constructs(str(origin), cache, _verifier(public_key))

    # skyfield-stack wheels arrive byte-identical
    vendored = gather_offline_wheels()
    for path, blob in vendored.items():
        assert read_synced_file(cache, result, path) == blob
    # almamesh wheel + skyfield data arrive byte-identical
    assert read_synced_file(cache, result, "wheels/almamesh-0.1.0-py3-none-any.whl") == (
        b"ALMAMESH-WHEEL-BYTES"
    )
    assert read_synced_file(cache, result, "skyfield-data/de421.bsp") == de421
    assert read_synced_file(cache, result, "skyfield-data/finals2000A.all") == finals
    # engine construct still ships
    assert read_synced_file(cache, result, "lahiri_ayanamsa.txt")

    meta = json.loads(read_synced_file(cache, result, "almamesh_meta.json"))
    for path in (*vendored, "wheels/almamesh-0.1.0-py3-none-any.whl"):
        assert path in meta["constructs"]
    assert "skyfield-data/de421.bsp" in meta["constructs"]
    assert "skyfield-data/finals2000A.all" in meta["constructs"]
    assert meta["ephemeris_file"] == "de421.bsp"
