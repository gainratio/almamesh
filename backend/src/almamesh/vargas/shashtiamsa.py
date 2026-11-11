"""BPHS Chapter 6 Shashtiamsa (D60) 60-part amsa names and natures.

Each 30° zodiac sign splits into sixty 0°30' amsas (``1..60``). Odd signs
(Aries, Gemini, Leo, Libra, Sagittarius, Aquarius) count forward ``0..59``;
even signs reverse the order (``59 - k``). Every amsa carries its classical
Parashari name and nature (``"saumya"`` benefic or ``"krura"`` malefic).
"""

from __future__ import annotations

from typing import Final, Literal

from pydantic import BaseModel, ConfigDict

ShashtiamsaNature = Literal["saumya", "krura"]

_SIGN_WIDTH: Final[float] = 30.0
_AMSAS_PER_SIGN: Final[int] = 60

# BPHS Ch. 6 Shashtiamsa table (1..60 in odd-sign forward order): 33 saumya, 27 krura.
_SHASHTIAMSA_TABLE: Final[tuple[tuple[str, ShashtiamsaNature], ...]] = (
    ("Ghora", "krura"),
    ("Rakshasa", "krura"),
    ("Deva", "saumya"),
    ("Kubera", "saumya"),
    ("Yaksha", "saumya"),
    ("Kinnara", "saumya"),
    ("Bhrashta", "krura"),
    ("Kulaghna", "krura"),
    ("Garala", "krura"),
    ("Vahni", "krura"),
    ("Maya", "krura"),
    ("Purishaka", "krura"),
    ("Apampati", "saumya"),
    ("Marutwan", "saumya"),
    ("Kaala", "krura"),
    ("Sarpa", "krura"),
    ("Amrita", "saumya"),
    ("Indu", "saumya"),
    ("Mridu", "saumya"),
    ("Komala", "saumya"),
    ("Heramba", "saumya"),
    ("Brahma", "saumya"),
    ("Vishnu", "saumya"),
    ("Maheshwara", "saumya"),
    ("Deva", "saumya"),
    ("Ardra", "saumya"),
    ("Kalinasha", "saumya"),
    ("Kshiteesha", "saumya"),
    ("Kamalakara", "saumya"),
    ("Gulika", "krura"),
    ("Mrityu", "krura"),
    ("Kaala", "krura"),
    ("Davagni", "krura"),
    ("Ghora", "krura"),
    ("Yama", "krura"),
    ("Kantaka", "krura"),
    ("Sudha", "saumya"),
    ("Amrita", "saumya"),
    ("Purnachandra", "saumya"),
    ("Vishadagdha", "krura"),
    ("Kulanasha", "krura"),
    ("Vamshakshaya", "krura"),
    ("Utpata", "krura"),
    ("Kaala", "krura"),
    ("Saumya", "saumya"),
    ("Komala", "saumya"),
    ("Sheetala", "saumya"),
    ("Karaladamshtra", "krura"),
    ("Chandramukhi", "saumya"),
    ("Praveena", "saumya"),
    ("Kaalapavaka", "krura"),
    ("Dandayudha", "krura"),
    ("Nirmala", "saumya"),
    ("Saumya", "saumya"),
    ("Krura", "krura"),
    ("Atisheetala", "saumya"),
    ("Amrita", "saumya"),
    ("Payodhi", "saumya"),
    ("Bhramana", "krura"),
    ("Chandrarekha", "saumya"),
)


class ShashtiamsaAmsa(BaseModel):
    """One BPHS Shashtiamsa (D60) subdivision: 1..60 index, deity name, nature."""

    model_config = ConfigDict(frozen=True)
    number: int
    name: str
    nature: ShashtiamsaNature


def shashtiamsa_amsa(longitude: float) -> ShashtiamsaAmsa:
    """Resolve an absolute sidereal longitude to its BPHS D60 Shashtiamsa amsa."""
    long_mod = longitude % 360.0
    sign_index = int(long_mod // _SIGN_WIDTH)
    deg_in_sign = long_mod - sign_index * _SIGN_WIDTH
    part = min(int(deg_in_sign * 2.0), _AMSAS_PER_SIGN - 1)
    index = part if sign_index % 2 == 0 else (_AMSAS_PER_SIGN - 1 - part)
    name, nature = _SHASHTIAMSA_TABLE[index]
    return ShashtiamsaAmsa(number=index + 1, name=name, nature=nature)
