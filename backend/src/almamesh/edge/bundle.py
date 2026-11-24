"""Signed content-addressed delivery of AlmaMesh constructs.

The engine's data (Lahiri ayanamsa table) plus a signed provenance
manifest (``almamesh_meta.json``) are delivered to devices as one bundle:
almamesh.com serves a tiny signed ``/latest`` pointer, immutable ``/chunk/<hash>``
and ``/manifest/<hash>``. The device verifies the ed25519 signature against a
pinned trust-root key and atomically swaps constructs in — verification is
fail-closed. The edge is delivery-only; compute stays local.
"""

from __future__ import annotations

import importlib.metadata
import importlib.resources
import os
from collections.abc import Mapping
from pathlib import Path

from edgeproc.bundles.adapters import FilesystemAdapter, HttpAdapter
from edgeproc.bundles.cas import FilesystemCacheStore
from edgeproc.bundles.chunking import GearCDC
from edgeproc.bundles.manifest import IndexManifest, VersionPointer
from edgeproc.bundles.publish import build_bundle
from edgeproc.bundles.signing import Signer, Verifier, generate_keypair
from edgeproc.bundles.sync import SyncResult, materialize_file, sync_index
from pydantic import BaseModel, ConfigDict

from almamesh.config import get_settings

_BUNDLE_ID = "almamesh-constructs"
# Yoga rules are typed Python inside the almamesh wheel (shipped via wheels/),
# not a data construct — the old YAML rule catalog was deleted in the audit.
_CONSTRUCT_FILES = ("lahiri_ayanamsa.txt",)
_META_NAME = "almamesh_meta.json"

# Offline asset layout inside the bundle (the in-browser Pyodide engine loads
# these after first sync; Pyodide runtime + numpy ship as app static assets).
_OFFLINE_WHEELS_DIR = Path(__file__).resolve().parents[3] / "offline_wheels"
_WHEELS_PREFIX = "wheels"
_SKYFIELD_DATA_PREFIX = "skyfield-data"
# Skyfield 1.55 bundles its built-in timescale tables inside the skyfield wheel
# (`loader.timescale(builtin=True)`), so only `de421.bsp` needs to ship here.
_SKYFIELD_DATA_FILES = ("de421.bsp",)


class BundleMeta(BaseModel):
    """Provenance recorded in every bundle — feeds the report footer + version lock."""

    model_config = ConfigDict(frozen=True)

    bundle_id: str
    version: str
    engine_version: str
    ephemeris_file: str
    ayanamsa: str
    constructs: list[str]


def build_meta(
    version: str,
    *,
    constructs: list[str],
    ephemeris_file: str,
    ayanamsa: str = "lahiri",
    bundle_id: str = _BUNDLE_ID,
) -> BundleMeta:
    """Stamp engine + ephemeris + ayanamsa provenance for one publish."""
    return BundleMeta(
        bundle_id=bundle_id,
        version=version,
        engine_version=importlib.metadata.version("almamesh"),
        ephemeris_file=ephemeris_file,
        ayanamsa=ayanamsa,
        constructs=sorted(constructs),
    )


def gather_construct_files() -> dict[str, bytes]:
    """The engine data shipped to devices: the Lahiri ayanamsa table."""
    resources = importlib.resources.files("almamesh") / "resources"
    out: dict[str, bytes] = {}
    for name in _CONSTRUCT_FILES:
        node = resources
        for part in name.split("/"):
            node = node / part
        out[name] = node.read_bytes()
    return out


def gather_offline_wheels() -> dict[str, bytes]:
    """The vendored pure-Python skyfield-stack wheels, keyed ``wheels/<file>.whl``."""
    return {
        f"{_WHEELS_PREFIX}/{path.name}": path.read_bytes()
        for path in sorted(_OFFLINE_WHEELS_DIR.glob("*.whl"))
    }


def _gather_almamesh_wheel(wheel_path: Path) -> dict[str, bytes]:
    """The built almamesh wheel, keyed ``wheels/<file>.whl``."""
    return {f"{_WHEELS_PREFIX}/{wheel_path.name}": wheel_path.read_bytes()}


def _gather_skyfield_data(data_dir: Path) -> dict[str, bytes]:
    """DE421 ephemeris + finals2000A.all, keyed ``skyfield-data/<file>``."""
    return {
        f"{_SKYFIELD_DATA_PREFIX}/{name}": (data_dir / name).read_bytes()
        for name in _SKYFIELD_DATA_FILES
    }


def gather_offline_assets(almamesh_wheel: Path, skyfield_data_dir: Path) -> dict[str, bytes]:
    """All offline boot assets: skyfield wheels + almamesh wheel + skyfield data."""
    return {
        **gather_offline_wheels(),
        **_gather_almamesh_wheel(almamesh_wheel),
        **_gather_skyfield_data(skyfield_data_dir),
    }


def _read_staging_dir(staging_dir: Path) -> dict[str, bytes]:
    """Read a staging dir (ephemeris, wheels) recursively, keyed by POSIX relpath.

    Rejects symlinks and out-of-tree paths: staged bytes get signed and served
    publicly, so a symlink must never exfiltrate a file from outside the tree.
    """
    root = staging_dir.resolve()
    out: dict[str, bytes] = {}
    for path in sorted(staging_dir.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"refusing to stage symlink: {path}")
        if not path.is_file():
            continue
        if not path.resolve().is_relative_to(root):
            raise ValueError(f"staged path escapes staging dir: {path}")
        out[path.relative_to(staging_dir).as_posix()] = path.read_bytes()
    return out


def _merge_constructs(files: dict[str, bytes], staged: dict[str, bytes]) -> dict[str, bytes]:
    """Merge staged files over engine constructs, refusing to shadow either."""
    collisions = sorted(set(files) & set(staged))
    if collisions:
        raise ValueError(f"staged files collide with engine constructs: {collisions}")
    if _META_NAME in staged:
        raise ValueError(f"{_META_NAME!r} is reserved and cannot be staged")
    return {**files, **staged}


def publish_bundle(
    origin_dir: Path,
    signer: Signer,
    *,
    version: str,
    staging_dir: Path | None = None,
    ephemeris_file: str | None = None,
    sequence: int = 1,
) -> VersionPointer:
    """Gather constructs (+ optional staged binaries), stamp meta, sign, publish."""
    ephemeris_file = ephemeris_file or get_settings().EPHEMERIS_FILE
    files = gather_construct_files()
    if staging_dir is not None:
        files = _merge_constructs(files, _read_staging_dir(staging_dir))
    meta = build_meta(version, constructs=list(files), ephemeris_file=ephemeris_file)
    files[_META_NAME] = meta.model_dump_json(indent=2).encode()
    return publish_constructs(files, origin_dir, signer, version=version, sequence=sequence)


def _default_skyfield_data_dir() -> Path:
    """Skyfield's on-disk data home (where ``de421.bsp`` + finals are cached)."""
    return Path.home() / ".skyfield-data"


def _default_almamesh_wheel() -> Path:
    """The freshly built almamesh wheel under ``backend/dist`` (``uv build --wheel``)."""
    dist = _OFFLINE_WHEELS_DIR.parent / "dist"
    wheels = sorted(dist.glob("almamesh-*-py3-none-any.whl"))
    if not wheels:
        raise FileNotFoundError(f"no almamesh wheel in {dist} — run `uv build --wheel` first")
    return wheels[-1]


def publish_offline_bundle(
    origin_dir: Path,
    signer: Signer,
    *,
    version: str,
    almamesh_wheel: Path | None = None,
    skyfield_data_dir: Path | None = None,
    sequence: int = 1,
) -> VersionPointer:
    """Publish the full OFFLINE asset set: wheels + de421 ephemeris + meta.

    `lahiri_ayanamsa.txt` already travels compressed inside the `almamesh` wheel
    (read via `importlib.resources`), so offline bundles omit the duplicate 2.6 MB
    uncompressed standalone construct to shrink browser cold-start transfers.
    """
    almamesh_wheel = almamesh_wheel or _default_almamesh_wheel()
    skyfield_data_dir = skyfield_data_dir or _default_skyfield_data_dir()
    files = gather_offline_assets(almamesh_wheel, skyfield_data_dir)
    meta = build_meta(version, constructs=list(files), ephemeris_file="de421.bsp")
    files[_META_NAME] = meta.model_dump_json(indent=2).encode()
    return publish_constructs(files, origin_dir, signer, version=version, sequence=sequence)


def publish_constructs(
    files: Mapping[str, bytes],
    origin_dir: Path,
    signer: Signer,
    *,
    version: str,
    sequence: int = 1,
) -> VersionPointer:
    """Chunk, store, and sign constructs into a content-addressed origin."""
    store = FilesystemCacheStore(origin_dir)
    return build_bundle(
        files=files,
        store=store,
        chunker=GearCDC(),
        signer=signer,
        bundle_id=_BUNDLE_ID,
        version=version,
        bind_identity=True,
        channel="stable",
        sequence=sequence,
    )


def sync_constructs(
    base_url: str,
    cache_dir: Path,
    verifier: Verifier,
    *,
    over_http: bool = False,
) -> SyncResult:
    """Pull the signed pointer, fetch missing chunks, verify, and promote.

    Fail-closed: a bad signature or integrity check raises, never downgrades.
    """
    adapter = HttpAdapter() if over_http else FilesystemAdapter()
    store = FilesystemCacheStore(cache_dir)
    return sync_index(
        base_url=base_url,
        store=store,
        adapter=adapter,
        verifier=verifier,
        expected_bundle_id=_BUNDLE_ID,
        expected_channel="stable",
    )


def read_synced_file(cache_dir: Path, result: SyncResult, path: str) -> bytes:
    """Materialize one file from a synced bundle's cache, byte-for-byte."""
    store = FilesystemCacheStore(cache_dir)
    manifest = IndexManifest.model_validate_json(store.get_manifest(result.manifest_hash))
    return materialize_file(store, manifest, path)


def generate_keypair_files(
    private_path: Path, public_path: Path, *, overwrite: bool = False
) -> None:
    """Write a raw 32-byte ed25519 keypair: private.key (gitignore) + public.key (pin).

    The private key is written owner-only (0o600) and never silently overwritten —
    clobbering a signing key would orphan every device pinned to the old public key.
    """
    if private_path.exists() and not overwrite:
        raise FileExistsError(f"refusing to overwrite existing private key: {private_path}")
    private_key, public_key = generate_keypair()
    private_path.parent.mkdir(parents=True, exist_ok=True)
    public_path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(private_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(private_key.private_bytes_raw())
    public_path.write_bytes(public_key.public_bytes_raw())
