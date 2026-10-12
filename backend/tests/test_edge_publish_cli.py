"""CLI for publishing signed AlmaMesh bundles: ``keygen`` + ``bundle``.

Mirrors the edge-reco publisher CLI: generate a pinned ed25519 keypair, then
sign a content-addressed origin a device can sync. End-to-end test proves the
published origin verifies against the generated public key.
"""

import json

from edgeproc.bundles.signing import Ed25519Verifier, key_id_for
from typer.testing import CliRunner

from almamesh.edge.bundle import read_synced_file, sync_constructs
from almamesh.edge.publish_cli import app

runner = CliRunner()


def test_keygen_command_creates_loadable_keypair(tmp_path) -> None:
    result = runner.invoke(app, ["keygen", str(tmp_path / "keys")])
    assert result.exit_code == 0, result.output
    assert (tmp_path / "keys" / "private.key").read_bytes()
    assert len((tmp_path / "keys" / "public.key").read_bytes()) == 32


def test_bundle_command_publishes_verifiable_origin(tmp_path) -> None:
    keys, origin, cache = tmp_path / "keys", tmp_path / "origin", tmp_path / "cache"
    assert runner.invoke(app, ["keygen", str(keys)]).exit_code == 0

    result = runner.invoke(
        app,
        [
            "bundle",
            str(origin),
            str(keys / "private.key"),
            "--version",
            "3.0.0",
            "--ephemeris-file",
            "de421.bsp",
        ],
    )
    assert result.exit_code == 0, result.output

    verifier = Ed25519Verifier.from_public_bytes((keys / "public.key").read_bytes())
    synced = sync_constructs(str(origin), cache, verifier)

    meta = json.loads(read_synced_file(cache, synced, "almamesh_meta.json"))
    assert meta["version"] == "3.0.0"
    assert meta["ephemeris_file"] == "de421.bsp"
    assert read_synced_file(cache, synced, "lahiri_ayanamsa.txt")


def test_bundle_offline_mode_ships_full_asset_set(tmp_path) -> None:
    """``bundle --offline`` ships wheels + skyfield data. Real 16 MB de421 is
    staged from ~/.skyfield-data at publish time; here we stub it small."""
    keys, origin, cache = tmp_path / "keys", tmp_path / "origin", tmp_path / "cache"
    assert runner.invoke(app, ["keygen", str(keys)]).exit_code == 0
    wheel = tmp_path / "almamesh-0.1.0-py3-none-any.whl"
    wheel.write_bytes(b"WHEEL")
    data = tmp_path / "skyfield-data"
    data.mkdir()
    (data / "de421.bsp").write_bytes(b"DE421-STUB")
    (data / "finals2000A.all").write_bytes(b"FINALS-STUB")

    result = runner.invoke(
        app,
        [
            "bundle",
            str(origin),
            str(keys / "private.key"),
            "--offline",
            "--almamesh-wheel",
            str(wheel),
            "--skyfield-data",
            str(data),
        ],
    )
    assert result.exit_code == 0, result.output

    verifier = Ed25519Verifier.from_public_bytes((keys / "public.key").read_bytes())
    synced = sync_constructs(str(origin), cache, verifier)
    assert read_synced_file(cache, synced, "skyfield-data/de421.bsp") == b"DE421-STUB"
    assert read_synced_file(cache, synced, "wheels/skyfield-1.55-py3-none-any.whl")


def test_keygen_prints_the_key_id_a_keyring_names_the_key_by(tmp_path) -> None:
    """Mirrors edge-proc 0.5 ``keygen``: line 1 is unchanged, line 2 is ``key_id <16 hex>``."""
    keys = tmp_path / "keys"
    result = runner.invoke(app, ["keygen", str(keys)])
    assert result.exit_code == 0, result.output

    lines = result.output.splitlines()
    assert lines[0].startswith("Wrote keypair to ")
    assert lines[1] == f"key_id {key_id_for((keys / 'public.key').read_bytes())}"


def test_bundle_pointer_stays_unstamped_whatever_the_edgeproc_env(tmp_path, monkeypatch) -> None:
    """The publisher never stamps key_id/expires_at, whatever ``EDGEPROC_PUBLISH_*`` says.

    edge-proc 0.5's ``edgeproc publish`` can stamp a key_id and an expiry from those
    settings. AlmaMesh publishes through the ``build_bundle`` library call, so a stray
    stamping env in a release shell must not add fields: the signed ``latest`` keeps the
    exact pre-keyring shape every pinned device already accepts.
    """
    monkeypatch.setenv("EDGEPROC_PUBLISH_STAMP_KEY_ID", "true")
    monkeypatch.setenv("EDGEPROC_PUBLISH_EXPIRES_IN", "7d")
    keys, origin = tmp_path / "keys", tmp_path / "origin"
    assert runner.invoke(app, ["keygen", str(keys)]).exit_code == 0

    result = runner.invoke(
        app, ["bundle", str(origin), str(keys / "private.key"), "--sequence", "7"]
    )
    assert result.exit_code == 0, result.output

    latest = json.loads((origin / "latest").read_bytes())
    assert set(latest) == {
        "manifest_hash",
        "version",
        "bundle_id",
        "channel",
        "sequence",
        "signature",
    }
    assert (latest["bundle_id"], latest["channel"], latest["sequence"]) == (
        "almamesh-constructs",
        "stable",
        7,
    )


def test_bundle_refuses_a_malformed_edgeproc_setting_before_writing(tmp_path, monkeypatch) -> None:
    """edge-proc 0.5 validates ``EDGEPROC_*`` wherever its CAS reads settings.

    A malformed value used to be ignored; it now fails validation. The publisher must turn
    that into a coded, one-line ``config.invalid`` refusal naming the variable, before any
    object or ``latest`` pointer is written, not a pydantic traceback mid-publish.
    """
    monkeypatch.setenv("EDGEPROC_PUBLISH_EXPIRES_IN", "not-a-duration")
    keys, origin = tmp_path / "keys", tmp_path / "origin"
    assert runner.invoke(app, ["keygen", str(keys)]).exit_code == 0

    result = runner.invoke(app, ["bundle", str(origin), str(keys / "private.key")])

    assert result.exit_code == 1
    assert result.output.startswith(
        "[config.invalid] invalid setting EDGEPROC_PUBLISH_EXPIRES_IN: "
    )
    assert "Traceback" not in result.output
    assert not origin.exists()
