"""The rules the reading states, one short sentence each, so a model may cite them."""

from __future__ import annotations

from typing import Final

READING_RULES: Final[tuple[str, ...]] = (
    "functional nature (BPHS): yogakaraka; lord of 1/5/9 benefic; else of 3/6/8/11 malefic;"
    " else of 2/7 maraka; else neutral. A 12th lord takes its other house's nature, alone neutral",
    "dasha score 0-100: a lord sitting in or ruling a domain house counts 1, a karaka only 0.5;"
    " times strength (strong 1, ordinary 0.75, weak 0.5), maha 3 antar 2 pratyantar 1, by time",
    "agreement: vimshottari / yogini = that dasha score is 50 or more (Yogini maha 2, antar 1);"
    " transit = Jupiter/Saturn in a domain house from the lagna or the Moon",
    "strength: combust weak; retrograde strong; exalted or own strong; debilitated weak; friend's"
    " sign strong and enemy's weak by the Shadbala minimum; else ordinary. Nodes ordinary",
    "relation: a sub-lord counted from its parent lord; 1/4/5/7/9/10/11 support, 6/8/12 from"
    " it friction, 2/3 neutral (BPHS antardasha chapters)",
    "dasha tone: per tied lord, functional nature + strength + relation; all positive"
    " supportive, all negative challenging, else mixed",
    "confidence = agreeing techniques: 3 high, 2 medium, 0-1 low",
    "obstacles (6th/8th/12th): karakas Saturn/Mars/Rahu are context only; strength = agreeing"
    " techniques + a dated window: 3-4 with the window strong, 2+ moderate, 0-1 weak",
    "direction = domain transit severity + its window severities, neutral ignored: all"
    " supportive, all challenging, else mixed",
    "whole-sign houses; Saturn 12th/1st/2nd from Moon = sade_sati_phase_1/2/3, 1/4/7/10 ="
    " kantaka_shani, 8th = ashtama_shani",
    "rahu/ketu tags = their 6th/8th/12th from the lagna or Moon (rahu_from_moon_6);"
    " obstacles windows date Mars entering a 6th/8th/12th or the natal Moon/lagna sign",
    "double_transit = houses from lagna Jupiter and Saturn both occupy or aspect now",
    "sookshma and panchang are for the reference instant; vara is the UTC weekday",
)

__all__ = ["READING_RULES"]
