"""The value-level licence guard: what no published aggregate may carry, in any key or value."""

from __future__ import annotations

import re
from collections.abc import Iterator

# What a published aggregate may never carry, in any key or value (not only field names).
_ADB_ID = re.compile(r"adb[-_ ]?\d+|^\d{5,}$", re.IGNORECASE)
_TIMED_DATE = re.compile(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}")
_COORDINATE_PAIR = re.compile(
    r"(?<![\d.\[(])-?\d{1,3}\.\d{2,}\s*[,;/]\s*-?\d{1,3}\.\d{2,}(?![\d.\])])"
)
_PERSON_NAME = re.compile(r"\b[A-Z][a-z]{2,} [A-Z][a-z]{2,}\b")
_TEXT_RULES = {
    "an ADB-id-shaped value": _ADB_ID,
    "an ISO date with a time": _TIMED_DATE,
    "a latitude/longitude pair": _COORDINATE_PAIR,
    "a free-text name": _PERSON_NAME,
}


def _walk(node: object, path: str = "$") -> Iterator[tuple[str, str, str]]:
    """Every (path, role, text) for each key and string leaf; a float pair is also text."""
    if isinstance(node, dict):
        for key, value in node.items():
            yield path, "key", str(key)
            yield from _walk(value, f"{path}.{key}")
    elif isinstance(node, list | tuple):
        if len(node) == 2 and all(isinstance(v, float) for v in node):
            yield path, "value", f"{node[0]}, {node[1]}"
        for i, value in enumerate(node):
            yield from _walk(value, f"{path}[{i}]")
    elif isinstance(node, str):
        yield path, "value", node


def leaks(payload: object) -> list[str]:
    """Violations of the licence rules in one published aggregate (JSON data or markdown)."""
    texts = _walk(payload) if not isinstance(payload, str) else [("$", "markdown", payload)]
    return [
        f"{path} ({role}) holds {rule}: {text[:40]!r}"
        for path, role, text in texts
        for rule, pattern in _TEXT_RULES.items()
        if pattern.search(text)
    ]
