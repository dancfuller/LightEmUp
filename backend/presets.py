"""Team, college and flag colors for the Pi (v3.60.0).

The Scenes panel's Teams / College / Flags modes read `PRESET_TEAMS`,
`PRESET_NCAA` and `PRESET_FLAGS` from `static/js/palette-data.js`, which was a
browser-only file. Ask ("Eagles colors outside") needs the same data on the Pi.
Rather than keep a second copy that would drift, this reads THAT file: every
entry sits on one line as

    { name: "Philadelphia Eagles", group: "NFL", colors: ["#004C54", "#A5ACAF"] },

and `_ENTRY` parses exactly that shape. If someone reformats the file, `load()`
finds nothing and logs it loudly rather than serving a partial list.

Colors are filtered the way color-mode.js's `presetColors()` does: near-black
(brightest channel < 40) is dropped, because a light can't show black — unless
that would leave nothing."""

import logging
import re
from pathlib import Path
from typing import Optional

log = logging.getLogger("lightemup.presets")

SRC = Path(__file__).resolve().parent / "static" / "js" / "palette-data.js"
_ARRAYS = (("teams", "PRESET_TEAMS"), ("ncaa", "PRESET_NCAA"), ("flags", "PRESET_FLAGS"))
_ENTRY = re.compile(
    r'\{\s*name:\s*"((?:[^"\\]|\\.)*)"\s*,\s*(?:group:\s*"([^"]*)"\s*,\s*)?'
    r'colors:\s*\[([^\]]*)\]\s*\}')
_HEX = re.compile(r'"#?([0-9A-Fa-f]{6})"')

PRESETS: dict = {}          # kind → [ {name, group, colors: [(r,g,b), …]} ]
_BY_NAME: dict = {}         # lowercased name → (kind, entry)


def _rgb(h: str) -> tuple:
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def usable_colors(hexes_rgb: list) -> list:
    """Drop near-black (a light can't show black), unless nothing would be left."""
    kept = [c for c in hexes_rgb if max(c) >= 40]
    return kept or list(hexes_rgb)


def load(src: Path = SRC) -> dict:
    global PRESETS, _BY_NAME
    try:
        text = src.read_text(encoding="utf-8")
    except OSError as e:
        log.warning("Presets: cannot read %s (%s) — team/college/flag colors unavailable", src, e)
        PRESETS, _BY_NAME = {}, {}
        return PRESETS
    out, by_name = {}, {}
    for kind, const in _ARRAYS:
        start = text.find(f"const {const} = [")
        end = text.find("];", start) if start >= 0 else -1
        if start < 0 or end < 0:
            log.warning("Presets: %s not found in %s", const, src.name)
            out[kind] = []
            continue
        entries = []
        for m in _ENTRY.finditer(text[start:end]):
            name = m.group(1).replace('\\"', '"')
            colors = [_rgb(h) for h in _HEX.findall(m.group(3))]
            if not colors:
                continue
            entry = {"name": name, "group": m.group(2), "colors": usable_colors(colors)}
            entries.append(entry)
            by_name.setdefault(name.lower(), (kind, entry))
        out[kind] = entries
    PRESETS, _BY_NAME = out, by_name
    log.info("Presets: %s", ", ".join(f"{len(v)} {k}" for k, v in out.items()))
    return PRESETS


def find(name: str) -> Optional[tuple]:
    """(kind, entry) for an exact (case-insensitive) preset name, else None."""
    return _BY_NAME.get((name or "").strip().lower())


load()
