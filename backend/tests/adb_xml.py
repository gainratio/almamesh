"""Hand-written Astro-Databank export fixtures (FAKE natives, made-up ids, no ADB records).

The shapes copy the export format 260911: ``rrc`` rating codes, ``iday``/``imonth`` = "00"
for an unknown day or month, ``stmerid`` such as ``h5w`` or ``m2e2015``, ``time_unknown``.
``zipcrypto_zip`` writes a password-protected member the way ``zip -P`` does, so the
importer's streaming decrypt path runs without any real export.
"""

from __future__ import annotations

import io
import struct
import zipfile
import zlib
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Final

_J2000: Final = datetime(2000, 1, 1, 12, tzinfo=UTC)
_J2000_JD: Final = 2451545.0


@dataclass(frozen=True)
class FakeEvent:
    """One ``<event>``: an ADB event type and a (year, month, day) with 0 for unknown."""

    evn_id: int = 822
    sevcode: str = "Work : New Job"
    ymd: tuple[int, int, int] = (1990, 5, 12)
    calendar: str = "g"

    def xml(self, adb_id: int) -> str:
        y, m, d = self.ymd
        return (
            f'<event sevcode="{self.sevcode}" evn_id="{self.evn_id}" adb_id="{adb_id}" '
            f'evnotes="fake"><event_data><sbdate ccalendar="{self.calendar}" iyear="{y}" '
            f'imonth="{m:02d}" iday="{d:02d}">{y}/{m:02d}/{d:02d}</sbdate><sbdate_dmy>x'
            "</sbdate_dmy></event_data></event>"
        )


@dataclass(frozen=True)
class FakeEntry:
    """One ``<adb_entry>`` for a made-up native."""

    adb_id: int = 900001
    rrc: str = "1"
    rating: str = "AA"
    dtc: str = "1"
    csex: str = "m"
    calendar: str = "g"
    birth: tuple[int, int, int, int, int] = (1950, 6, 15, 14, 30)
    stmerid: str = "h1e"
    offset_seconds: int = 3600
    time_unknown: str | None = None
    jd_shift_minutes: float = 0.0
    lat: str = "48n52"
    lon: str = "2e2015"
    clock: str | None = None
    with_place: bool = True
    events: tuple[FakeEvent, ...] = field(default_factory=lambda: (FakeEvent(),))

    def jd_ut(self) -> float:
        y, mo, d, h, mi = self.birth
        local = datetime(y, mo, d, h, mi, tzinfo=UTC) - timedelta(seconds=self.offset_seconds)
        return (local - _J2000).total_seconds() / 86400 + _J2000_JD + self.jd_shift_minutes / 1440

    def _sbtime(self) -> str:
        unknown = f' time_unknown="{self.time_unknown}"' if self.time_unknown else ""
        h, mi = self.birth[3:]
        clock = self.clock if self.clock is not None else f"{h:02d}:{mi:02d}"
        return (
            f'<sbtime ctimetype="s" stimetype="standard time" stmerid="{self.stmerid}" '
            f'jd_ut="{self.jd_ut():.6f}"{unknown}>{clock}</sbtime>'
        )

    def _bdata(self) -> str:
        y, mo, d = self.birth[:3]
        place = f'<place slati="{self.lat}" slong="{self.lon}">Nowhere</place>'
        return (
            f'<bdata><sbdate ccalendar="{self.calendar}" iyear="{y}" imonth="{mo}" iday="{d}">'
            f"x</sbdate>{self._sbtime()}{place if self.with_place else ''}</bdata>"
        )

    def xml(self) -> str:
        events = "".join(e.xml(self.adb_id) for e in self.events)
        return (
            f'<adb_entry adb_id="{self.adb_id}"><public_data><name>Fake</name>'
            f'<gender csex="{self.csex}">M</gender>'
            f'<roddenrating rrc="{self.rrc}">{self.rating}</roddenrating>'
            f'<datatype sdatatype="Public Figure" dtc="{self.dtc}" />{self._bdata()}'
            f'</public_data><research_data><events count="{len(self.events)}">{events}'
            "</events></research_data></adb_entry>"
        )


def export_xml(
    entries: tuple[FakeEntry, ...], *, deleted: str = "", prologue: str = "", licensed: bool = True
) -> str:
    """A whole export document around ``entries``."""
    license_data = (
        '<license_data order="1" order_item="1" usage_until="2099-01-01" user_email="x@y.z" />'
        if licensed
        else ""
    )
    body = "".join(e.xml() for e in entries)
    return (
        f'<?xml version="1.0" encoding="utf-8"?>\n{prologue}'
        '<astrodatabank_export export_format="260911" filename="fake_export.xml">'
        f"{license_data}<timestamp>2026-10-14T00:00:00Z</timestamp>"
        f"<important_notice>fake</important_notice>{body}"
        f'<adb_entry_count count="{len(entries)}" del_count="0" />'
        f"<deleted_records>{deleted}</deleted_records></astrodatabank_export>"
    )


def plain_zip(path: Path, members: dict[str, str]) -> Path:
    """An unencrypted zip holding ``members`` (name -> text)."""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, text in members.items():
            archive.writestr(name, text)
    return path


def _crc_table() -> tuple[int, ...]:
    def entry(n: int) -> int:
        for _ in range(8):
            n = (n >> 1) ^ 0xEDB88320 if n & 1 else n >> 1
        return n

    return tuple(entry(i) for i in range(256))


_CRC: Final = _crc_table()


class _ZipCryptoKeys:
    def __init__(self, password: bytes) -> None:
        self.keys = [0x12345678, 0x23456789, 0x34567890]
        for byte in password:
            self.update(byte)

    def update(self, byte: int) -> None:
        k0, k1, k2 = self.keys
        k0 = (k0 >> 8) ^ _CRC[(k0 ^ byte) & 0xFF]
        k1 = ((k1 + (k0 & 0xFF)) * 134775813 + 1) & 0xFFFFFFFF
        k2 = (k2 >> 8) ^ _CRC[(k2 ^ (k1 >> 24)) & 0xFF]
        self.keys = [k0, k1, k2]

    def encrypt(self, data: bytes) -> bytes:
        out = bytearray()
        for byte in data:
            temp = self.keys[2] | 2
            out.append(byte ^ (((temp * (temp ^ 1)) >> 8) & 0xFF))
            self.update(byte)
        return bytes(out)


def zipcrypto_zip(path: Path, name: str, text: str, password: bytes) -> Path:
    """One STORED member encrypted with traditional PKWARE (ZipCrypto) encryption."""
    data = text.encode()
    crc = zlib.crc32(data)
    header = bytes(11) + bytes([crc >> 24])
    payload = _ZipCryptoKeys(password).encrypt(header + data)
    raw_name = name.encode()
    common = struct.pack("<HHHHHIII", 20, 1, 0, 0, 0, crc, len(payload), len(data))
    local = b"PK\x03\x04" + common + struct.pack("<HH", len(raw_name), 0) + raw_name
    central = (
        b"PK\x01\x02"
        + struct.pack("<H", 20)
        + common
        + struct.pack("<HHHHHII", len(raw_name), 0, 0, 0, 0, 0, 0)
        + raw_name
    )
    offset = len(local) + len(payload)
    end = b"PK\x05\x06" + struct.pack("<HHHHIIH", 0, 0, 1, 1, len(central), offset, 0)
    path.write_bytes(local + payload + central + end)
    return path


def aes_marked_zip(path: Path, name: str, text: str) -> Path:
    """A zip whose member claims WinZip AES (method 99), which stdlib cannot decrypt."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_STORED) as archive:
        archive.writestr(name, text)
    raw = bytearray(buffer.getvalue())
    local = raw.find(b"PK\x03\x04")
    central = raw.find(b"PK\x01\x02")
    struct.pack_into("<HH", raw, local + 6, 1, 99)
    struct.pack_into("<HH", raw, central + 8, 1, 99)
    path.write_bytes(bytes(raw))
    return path
