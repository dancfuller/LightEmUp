#!/usr/bin/env python3
"""Regenerate backend/static/js/palette-library.js from backend/palette_library.json.

WHY THIS EXISTS
---------------
The 160-palette library used to live inline inside `color-mode.js`, which was
fine while palettes were a browser-only idea. v3.17.0 made them a *scheduler*
concept ("at sunset, pick a random Summer palette"), and the scheduler fires on
the Pi with no browser attached — so Python needs the same table.

Two copies of 808 colors would drift the first time someone adds a palette, so
the JSON is the single source of truth and the JS is generated from it. Add or
edit palettes in `backend/palette_library.json`, then re-run this script and
commit both files together.

Self-verifying: it refuses to write a file that fails the structural checks
below, so a malformed edit can't silently ship a broken palette picker.

    python tools/build-palette-library.py
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "backend" / "palette_library.json"
DEST = ROOT / "backend" / "static" / "js" / "palette-library.js"

# The re-cut in v3.13.0 fixed the length of no palette but did bound it: fewer
# than 4 real colors isn't a palette, more than 8 outruns most rooms.
MIN_COLORS, MAX_COLORS = 4, 8


def fail(msg: str):
    sys.stdout.flush()   # keep the failure below the summary it refers to
    print(f"FAIL: {msg}", file=sys.stderr)
    sys.exit(1)


def load() -> list:
    if not SRC.exists():
        fail(f"{SRC} not found")
    data = json.loads(SRC.read_text(encoding="utf-8"))
    if data.get("format") != 1:
        fail(f"unsupported format {data.get('format')!r}")
    palettes = data.get("palettes")
    if not isinstance(palettes, list) or not palettes:
        fail("no palettes in source")
    return palettes


def verify(palettes: list):
    """Structural checks. Every one of these has a plausible way to be violated
    by a hand edit, and every one would break the UI or the scheduler."""
    names, problems = set(), []
    for p in palettes:
        name = p.get("name")
        if not name:
            problems.append(f"palette with no name: {p!r}")
            continue
        if name in names:
            problems.append(f"duplicate name {name!r} — names are the key a "
                            f"schedule stores, so they must be unique")
        names.add(name)
        if not p.get("category"):
            problems.append(f"{name}: no category")
        colors = p.get("colors")
        if not isinstance(colors, list):
            problems.append(f"{name}: colors must be a list")
            continue
        if not MIN_COLORS <= len(colors) <= MAX_COLORS:
            problems.append(f"{name}: {len(colors)} colors "
                            f"(expected {MIN_COLORS}-{MAX_COLORS})")
        for c in colors:
            if (not isinstance(c, list) or len(c) != 3
                    or any(not isinstance(v, int) or not 0 <= v <= 255 for v in c)):
                problems.append(f"{name}: bad color {c!r} — want [r, g, b] 0-255")
    if problems:
        for pr in problems[:20]:
            print(f"  - {pr}", file=sys.stderr)
        fail(f"{len(problems)} problem(s) in {SRC.name} — nothing was written")

    cats = {}
    for p in palettes:
        cats.setdefault(p["category"], []).append(p["name"])
    print(f"OK  {len(palettes)} palettes in {len(cats)} categories, "
          f"{sum(len(p['colors']) for p in palettes)} colors total")
    for cat, members in cats.items():
        print(f"    {cat:<12} {len(members):>3}")
    featured = [p["name"] for p in palettes if p.get("featured")]
    print(f"    featured: {len(featured)}")

    # Spot-check a few known palettes so a mangled file is loud rather than
    # merely well-formed. These are the ones the v3.13.0 re-cut notes call out.
    by_name = {p["name"]: p for p in palettes}
    for name, want_len in (("Watermelon", 5), ("Rainbow", 8), ("Noir", 4)):
        got = by_name.get(name)
        if not got:
            fail(f"spot-check: {name!r} is missing")
        if len(got["colors"]) != want_len:
            fail(f"spot-check: {name!r} has {len(got['colors'])} colors, "
                 f"expected {want_len}")
    print("    spot-checks passed")
    return cats


def emit(palettes: list, cats: dict) -> str:
    rows = []
    last_cat = None
    for p in palettes:
        if p["category"] != last_cat:
            rows.append(f"  // {p['category']}")
            last_cat = p["category"]
        colors = ",".join("{r:%d,g:%d,b:%d}" % tuple(c) for c in p["colors"])
        feat = " featured: true," if p.get("featured") else ""
        rows.append('  { name: %s, category: %s,%s colors: [%s] },'
                    % (json.dumps(p["name"]), json.dumps(p["category"]), feat, colors))

    cat_list = ", ".join(json.dumps(c) for c in cats)
    return f"""// GENERATED FILE — do not edit by hand.
// Regenerate with:  python tools/build-palette-library.py
// Source of truth:  backend/palette_library.json
//
// The curated palette library, shared by the browser (the room color tool's
// palette picker) and the Pi (the scheduler's "random palette" action, which
// fires with no browser attached). It lived inline in color-mode.js until
// v3.17.0; two copies of {sum(len(p['colors']) for p in palettes)} colors would
// drift the first time someone added a palette, so both sides now read one file.
//
// Colors are VARIABLE length (4-8) and deliberately so — see the notes in
// color-mode.js: padding every palette to a fixed 8 was what produced "one light
// is just a paler version of that other one".
const PALETTE_LIBRARY = [
{chr(10).join(rows)}
];

// Category order as authored — the scheduler's "random from a category" picker
// and the color tool's filter chips both render in this order.
const PALETTE_CATEGORIES = [{cat_list}];
"""


def main():
    palettes = load()
    cats = verify(palettes)
    js = emit(palettes, cats)
    DEST.write_text(js, encoding="utf-8")
    print(f"\nWrote {DEST.relative_to(ROOT)} ({len(js):,} bytes)")


if __name__ == "__main__":
    main()
