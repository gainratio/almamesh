"""The rules the reading states, one short sentence each, so a model may cite them."""

from __future__ import annotations

from typing import Final

READING_RULES: Final[tuple[str, ...]] = (
    "functional nature (BPHS): yogakaraka; lord of 1/5/9 benefic; else of 3/6/8/11 malefic;"
    " else of 2/7 maraka; else neutral",
    "agreement: vimshottari = a running dasha lord, yogini = the Yogini lord, rules a domain"
    " house or is its karaka; transit = Jupiter/Saturn in a domain house from lagna or Moon",
    "confidence = agreeing techniques: 3 high, 2 medium, 0-1 low",
    "direction = domain transit severity + its window severities, neutral ignored: all"
    " supportive, all challenging, else mixed",
    "whole-sign houses; Saturn 12th/1st/2nd from Moon = sade_sati_phase_1/2/3, 1/4/7/10 ="
    " kantaka_shani, 8th = ashtama_shani",
    "double_transit = houses from lagna Jupiter and Saturn both occupy or aspect now",
    "sookshma and panchang are for the reference instant; vara is the UTC weekday",
)

__all__ = ["READING_RULES"]
