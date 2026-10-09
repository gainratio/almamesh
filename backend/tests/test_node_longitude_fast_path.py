"""Rahu/Ketu longitudes: byte-identical to the position dict, without computing all nine grahas."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from almamesh.calculations import AyanamsaType, NodeType, SkyfieldAstronomy
from almamesh.constants.astrology import PlanetName
from almamesh.transits.positions import transit_longitude, transit_positions

_INSTANTS = (
    datetime(1990, 1, 15, 12, tzinfo=UTC),
    datetime(2026, 12, 3, tzinfo=UTC),
    datetime(2052, 12, 31, 23, tzinfo=UTC),
)


@pytest.mark.parametrize("node_type", [NodeType.MEAN, NodeType.TRUE])
@pytest.mark.parametrize("graha", [PlanetName.RAHU, PlanetName.KETU])
def test_node_longitude_matches_the_position_dict_exactly(
    graha: PlanetName, node_type: NodeType
) -> None:
    # Given the full nine-graha position dict as the oracle
    astro = SkyfieldAstronomy()
    for when in _INSTANTS:
        oracle = transit_positions(astro, when, AyanamsaType.LAHIRI, node_type)[graha]
        # When the scalar probe asks for one node / Then it is the same float, bit for bit
        assert (
            transit_longitude(astro, graha, when, AyanamsaType.LAHIRI, node_type)
            == oracle["longitude"]
        )


def test_node_longitude_does_not_compute_every_graha(monkeypatch: pytest.MonkeyPatch) -> None:
    # Given an engine whose full position dict refuses to run
    astro = SkyfieldAstronomy()

    def refuse(*_args: object, **_kwargs: object) -> object:
        raise AssertionError("a node longitude must not compute all nine grahas")

    monkeypatch.setattr(astro, "get_planetary_positions", refuse)
    # When Rahu and Ketu are probed / Then both answer without it
    for graha in (PlanetName.RAHU, PlanetName.KETU):
        assert 0.0 <= transit_longitude(astro, graha, _INSTANTS[1]) < 360.0
