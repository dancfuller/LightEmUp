"""The curated palette library, on the server side.

Palettes started as a browser-only idea: you opened a room's colour tool, picked
"Tropical", and the browser worked out which light got which colour. v3.17.0 made
them a SCHEDULER idea too — "10 minutes before sunset, put the living room on a
random Summer palette" — and the scheduler fires on the Pi at sunset with nobody
watching and no browser attached. So the Pi needs the table.

`palette_library.json` is the single source of truth for both sides;
`backend/static/js/palette-library.js` is generated from it by
`tools/build-palette-library.py`. Never hand-edit the JS, and never add a
palette to only one of them.

This module is deliberately pure data + selection: it knows nothing about rooms,
devices or config. Turning a palette into per-device colours is `main.py`'s
`_build_palette_scene`, because that needs the device layer.
"""

import json
import logging
import random
from pathlib import Path
from typing import Optional

log = logging.getLogger("lightemup")

_LIBRARY_PATH = Path(__file__).parent / "palette_library.json"

PALETTES: list[dict] = []
CATEGORIES: list[str] = []
_BY_NAME: dict[str, dict] = {}


def _load():
    """Read the shared library. A missing or broken file must not stop the hub
    from booting — every other feature still works without palettes, so log it
    loudly and carry on with an empty library (schedules then skip with a clear
    "no candidates" warning rather than crashing the scheduler loop)."""
    global PALETTES, CATEGORIES, _BY_NAME
    try:
        data = json.loads(_LIBRARY_PATH.read_text(encoding="utf-8"))
        palettes = data.get("palettes") or []
    except Exception:
        log.exception("Palette library couldn't be loaded from %s", _LIBRARY_PATH)
        palettes = []

    clean = []
    for p in palettes:
        colors = [tuple(int(v) for v in c) for c in (p.get("colors") or [])
                  if isinstance(c, (list, tuple)) and len(c) == 3]
        if p.get("name") and colors:
            clean.append({
                "name": p["name"],
                "category": p.get("category") or "Other",
                "featured": bool(p.get("featured")),
                "colors": colors,
            })

    PALETTES = clean
    _BY_NAME = {p["name"]: p for p in clean}
    seen, ordered = set(), []
    for p in clean:
        if p["category"] not in seen:
            seen.add(p["category"])
            ordered.append(p["category"])
    CATEGORIES = ordered
    log.info("Palette library: %d palettes in %d categories", len(clean), len(ordered))


_load()


def by_name(name: str) -> Optional[dict]:
    return _BY_NAME.get(name)


def in_category(category: str) -> list[dict]:
    """Palettes in a category. 'Featured' and 'All' are the two virtual
    categories the colour tool's filter chips offer, so accept them here too —
    otherwise a schedule authored from those chips would resolve to nothing."""
    if not category or category == "All":
        return list(PALETTES)
    if category == "Featured":
        return [p for p in PALETTES if p["featured"]]
    return [p for p in PALETTES if p["category"] == category]


def resolve_candidates(action: dict) -> list[dict]:
    """The set a palette action draws from. `source: "category"` takes a whole
    category; `source: "list"` takes named palettes, in the order given.

    Names that no longer exist are dropped rather than fatal — someone can
    rename a palette in the JSON, and a schedule that silently loses one entry
    is far better than a schedule that stops firing."""
    if (action or {}).get("source") == "list":
        names = action.get("palettes") or []
        found = [_BY_NAME[n] for n in names if n in _BY_NAME]
        missing = [n for n in names if n not in _BY_NAME]
        if missing:
            log.warning("Palette action references unknown palette(s): %s",
                        ", ".join(missing))
        return found
    return in_category((action or {}).get("category") or "All")


def pick(candidates: list[dict], avoid: Optional[str] = None,
         rng: Optional[random.Random] = None) -> Optional[dict]:
    """Choose one palette at random, avoiding an immediate repeat.

    Without the avoid rule a 10-palette category shows the same look twice in a
    row about once a week, which reads as "the random thing is broken" even
    though it isn't. With only one candidate, repeating IS the correct answer."""
    if not candidates:
        return None
    r = rng or random
    pool = [p for p in candidates if p["name"] != avoid] or list(candidates)
    return r.choice(pool)
