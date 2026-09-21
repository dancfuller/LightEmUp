"""Room lightshows — the pattern math, with no idea what a light is.

A lightshow is a slow, ambient re-arrangement of a room's colors: not synced to
anything, just "the last time I looked at the house, these lights were different
colors". Segment addressing is what sets the tempo — a cloud_v2 device takes
~1.8s per distinct color, so a step that repaints a hexa costs seconds, and the
interesting cadence is 20s–1h rather than 20–60ms. Every pattern here is
therefore designed to look deliberate at a standstill, not to animate.

This module is deliberately pure, like `palettes.py`: it maps
(pattern, cell positions, color pool, step) → a color and a level for each cell.
It knows nothing about rooms, devices, segments or config — turning cells into
Hue/Govee calls is `main.py`'s job, because that needs the device layer.

`ColorDealer` lives here rather than in main.py because two features now need
the same "shuffle so no two neighbors match" rule: the scheduler's palette
action and the Shuffle/Palette-hop patterns. One copy, one behavior.

GEOMETRY (v3.40.0) — the load-bearing idea
------------------------------------------
A room laid out as a LINE and a room laid out as a FLOOR PLAN are not the same
space, and the patterns that read well in one are not the ones that read well in
the other. A line has ends, a direction and a well-defined "next light along";
a floor plan has a middle, two axes and no meaningful reading order. So
`plan_frame` takes each cell's POSITION, not just its index, and every pattern
declares which layouts it belongs to:

- **line**  — index IS position, so the striping patterns count cells (the same
  decision `color-mode.js` made for linear palettes: on a strip people expect
  color 1 on the leftmost light, not a color derived from raw coordinates with
  the physical gaps baked in). Wipe and Comet live here: both need an end to
  start from and a direction to travel.
- **plan**  — striping reads the actual coordinate, so a Walk marches real
  stripes across the room instead of rotating an arbitrary reading order, and
  Alternate becomes a true checkerboard on `(x+y)` parity rather than index
  parity. Ripple and Sweep live here: a center to radiate from and an axis to
  cross are both 2D ideas.
- **none**  — the room has no layout at all. Only the geometry-neutral patterns
  are offered, because the rest would be reading coordinates that don't exist.
  This is why `layouts` never contains "none": that set is exactly the patterns
  which never look at a position.
"""

import random
from typing import Optional

# ─── The pattern catalog ─────────────────────────────────────────────────────
# Served by GET /api/lightshow so the browser renders labels, blurbs and the
# layout filter from the same table the Pi validates against — the two can't
# drift into describing a pattern differently, or into offering one the math
# would refuse. `opts` names the extra controls the editor shows; `layouts` is
# which room geometries it's offered for (see the module docstring).

PATTERNS = [
    {
        "key": "walk",
        "name": "Walk",
        "blurb": "The palette repeats along the room (A B C A B C) and slides one place "
                 "each step. Inside a segmented light it slides segment by segment.",
        "opts": ["direction"],
    },
    {
        "key": "alternate",
        "name": "Alternate",
        "blurb": "Every other light takes its turn lit; the ones in between rest — dimmed, or off.",
        "opts": ["groups", "rest"],
    },
    {
        "key": "shuffle",
        "name": "Shuffle",
        "blurb": "The same palette, re-dealt across the room each step. Never two neighbors alike.",
        "opts": [],
    },
    {
        "key": "swap",
        "name": "Swap",
        "blurb": "A couple of lights trade colors each step. The subtlest one — the room barely moves.",
        "opts": ["swaps"],
    },
    {
        "key": "hop",
        "name": "Palette hop",
        "blurb": "A different palette from your set each step. The biggest change per step — give it room.",
        "opts": [],
        "needs_set": True,       # only interesting with 2+ palettes to draw from
    },
    {
        "key": "accent",
        "name": "Accent",
        "blurb": "The room holds one color while a single accent travels from light to light.",
        "opts": [],
        "roles": ["background", "accent"],
    },
    {
        "key": "wipe",
        "name": "Wipe",
        "blurb": "A new color creeps in from one end, covering the last one. Only one light changes "
                 "per step, so it's the cheapest pattern there is — and the slowest-looking.",
        "opts": ["direction"],
    },
    {
        "key": "comet",
        "name": "Comet",
        "blurb": "A bright head travels the run with a fading tail behind it, over a dim base.",
        "opts": ["tail", "rest_pct"],
        "roles": ["background", "comet"],
    },
]

PATTERN_KEYS = {p["key"] for p in PATTERNS}
DEFAULT_PATTERN = "walk"
GEOMETRIES = ("line", "plan", "none")


def patterns_for(geometry: str = "none") -> list:
    """The catalog — every room is offered every pattern (v3.54.0).

    Patterns used to be gated by layout, and two of them (Ripple, Sweep) existed
    only as 2D map effects. Judged against what an animation is FOR — colors
    changing places, with no two neighbors alike — a stripe that is geometrically
    a stripe in the room buys nothing anybody perceives, and the coordinate math
    it needed is what broke segmented strips (see `_ranks`). Ripple and Sweep are
    gone; a room still holding one falls back through `fallback_pattern`.

    `geometry` is kept in the signature because every caller passes it, and
    because the room's ORDER still comes from its layout — see `_lightshow_order`
    in main.py. Nothing here reads it any more, and `layouts` is gone from the
    catalog entries."""
    return list(PATTERNS)


def pattern_ok(pattern: str, geometry: str) -> bool:
    return any(p["key"] == pattern for p in patterns_for(geometry))


def fallback_pattern(geometry: str = "none") -> str:
    """What to run when the stored pattern isn't one we have. Since v3.54.0 that
    means a room still holding the removed Ripple or Sweep; it used to mean a
    layout change had invalidated a geometry-only pattern."""
    return DEFAULT_PATTERN if pattern_ok(DEFAULT_PATTERN, geometry) else patterns_for(geometry)[0]["key"]


class ColorDealer:
    """Hands out palette colors so that consecutive calls never repeat.

    Reshuffles at each cycle boundary (and re-rolls if the new cycle would open
    with the color the last one closed on), so a long strip doesn't show the
    same repeating ABCABC pattern down its whole length."""

    def __init__(self, colors: list, rng=None):
        self.colors = list(colors)
        self.rng = rng or random
        self.queue: list = []
        self.last = None

    def _refill(self):
        pool = list(self.colors)
        self.rng.shuffle(pool)
        if len(pool) > 1 and pool[0] == self.last:
            pool.append(pool.pop(0))
        self.queue = pool

    def next(self):
        if not self.colors:
            return (255, 255, 255)
        if not self.queue:
            self._refill()
        self.last = self.queue.pop(0)
        return self.last


def has_roles(pattern: str) -> bool:
    """Does this pattern treat colors[0] as a distinguished BACKGROUND?

    Accent and Comet both hold the room at one color and move a second one
    across it. That makes them the patterns where "which color is which" is a
    real question — and where a six-color palette can look like a two-color one,
    because only colors[0] and the current traveller are ever on screen at once."""
    return any(p["key"] == pattern and p.get("roles") for p in PATTERNS)


def apply_color_order(colors: list, order) -> list:
    """Reorder and/or narrow the pool to the roles the user picked.

    `order` is a list of indices into `colors`. Index 0 becomes the pool's first
    color, which is the BACKGROUND for every pattern that has one. Leaving
    indices out narrows the palette — which is how you get a deliberate
    two-color Accent out of a six-color palette instead of whichever two the
    shuffle happened to land on.

    Anything unusable is ignored rather than fatal: the palette behind an order
    can change under it (a different palette chosen, a custom color deleted), and
    a show must never stop because a stored index no longer resolves."""
    if not order:
        return colors
    picked, seen = [], set()
    for i in order:
        if isinstance(i, int) and 0 <= i < len(colors) and i not in seen:
            seen.add(i)
            picked.append(colors[i])
    return picked if len(picked) >= 2 else colors


def deal(colors: list, n: int, rng=None) -> list:
    """`n` colors dealt from the pool, no two adjacent alike."""
    d = ColorDealer(colors, rng)
    return [d.next() for _ in range(n)]


def _clamp(v, lo, hi, default):
    try:
        return max(lo, min(hi, int(v)))
    except (TypeError, ValueError):
        return default


def _ranks(cells: list, geometry: str = "none", axis=None) -> list:
    """The integer 'position' each cell occupies — its INDEX in the room's cell
    sequence, for every room (v3.54.0).

    A floor plan used to rank by rounded coordinate, and that is the bug that made
    segmented strips useless. A segment inherits its parent device's position
    unless someone has individually dragged it onto the map — so every segment of
    a strip rounded to the SAME rank, took the SAME color, and the whole device
    flipped as a unit instead of the palette sliding along it. Eleven of the
    twelve devices in the reporting room had no segment positions placed.

    Indexing instead makes a strip its own line, which is the premise
    `light-scene.js` has always used (segment index IS position): the room's cells
    are already ordered so a device's segments are consecutive and in index order,
    so A B C A B C A becomes B C A B C A B along the strip and across the room in
    one continuous sequence. `cells` (the positions) is unused now and kept only
    so the signature stays stable for callers."""
    return list(range(len(cells)))


def _walk_offset(step: int, k: int, direction: str) -> int:
    """How far the repeating pattern has slid by `step`.

    Bounce reflects over [0, k-1] with period 2(k-1) — the standard ping-pong.
    Reflecting over [0, k] instead would hold for one step at each end, which
    reads as a stutter rather than a turn."""
    if direction == "backward":
        return -step
    if direction == "bounce" and k > 2:
        period = 2 * (k - 1)
        t = step % period
        return t if t < k else period - t
    return step


def plan_frame(pattern: str, cells: list, colors: list, step: int,
               opts: Optional[dict] = None, prev: Optional[list] = None,
               rng=None, geometry: str = "line") -> list:
    """One frame: `(r, g, b, level)` per cell, in room order.

    `cells` is a list of `(x, y)` positions — the same length and order as the
    room's cells. A line puts everything on y=0; a room with no layout passes
    zeros and only ever reaches the geometry-neutral patterns.

    `level` is a 0..1 multiplier the painter applies in whichever way the cell
    supports — Hue and whole Govee devices get it as brightness, a segment gets
    its RGB scaled, because a cloud_v2 segment call carries no brightness. A
    level of 0 means "rest": off for a whole device, black for a segment.

    `prev` is the previous frame (levels included, ignored) and is only read by
    Swap, which mutates an arrangement rather than generating one. Passing None
    makes Swap deal a fresh arrangement, which is exactly what a show that has
    just (re)started should do."""
    opts = opts or {}
    rng = rng or random
    n = len(cells)
    if n <= 0 or not colors:
        return []
    k = len(colors)
    if pattern == "walk":
        off = _walk_offset(step, k, opts.get("direction") or "forward")
        ranks = _ranks(cells)
        return [(*colors[(r + off) % k], 1.0) for r in ranks]

    if pattern == "alternate":
        groups = _clamp(opts.get("groups"), 2, 4, 2)
        rest = _rest_level(opts)
        # "Every other one" along the room's own sequence — which inside a
        # segmented light means every other SEGMENT.
        ranks = _ranks(cells)
        lit = step % groups
        return [(*colors[i % k], 1.0 if ranks[i] % groups == lit else rest)
                for i in range(n)]

    if pattern in ("shuffle", "hop"):
        # Hop differs only in that the CALLER hands us a different palette each
        # step; the arrangement logic is the same deal.
        return [(*c, 1.0) for c in deal(colors, n, rng)]

    if pattern == "swap":
        base = [tuple(c[:3]) for c in (prev or [])]
        if len(base) != n:
            base = deal(colors, n, rng)
        arr = list(base)
        if n >= 2:
            pairs = max(1, min(n // 2, _clamp(opts.get("swaps"), 1, 8, 2)))
            for _ in range(pairs):
                i, j = rng.sample(range(n), 2)
                arr[i], arr[j] = arr[j], arr[i]
        return [(*c, 1.0) for c in arr]

    if pattern == "accent":
        base = colors[0]
        pos = step % n
        # The accent color changes once per lap, so a five-color palette is
        # actually used rather than reduced to two.
        accent = _accent_color(colors, step // n)
        return [(*(accent if i == pos else base), 1.0) for i in range(n)]

    if pattern == "wipe":
        # One end to the other, laying the next palette color over the last one.
        # Exactly ONE cell changes per step — including across the wrap, which is
        # why the pass counter drives both colors rather than restarting a fresh
        # sweep (that would repaint the whole run in a single step).
        pos = step % n
        laid = colors[((step // n) + 1) % k]
        under = colors[(step // n) % k]
        backward = (opts.get("direction") == "backward")
        return [(*(laid if ((n - 1 - i) if backward else i) <= pos else under), 1.0)
                for i in range(n)]

    if pattern == "comet":
        tail = max(1, min(max(1, n - 1), _clamp(opts.get("tail"), 1, 8, 3)))
        rest = _rest_level(opts)
        base = colors[0]
        head = step % n
        accent = _accent_color(colors, step // n)
        out = []
        for i in range(n):
            d = (head - i) % n                # cells behind the head
            if d <= tail:
                # 1.0 at the head down to a quarter at the tail's last cell.
                out.append((*accent, round(1.0 - (d / (tail + 1)) * 0.75, 3)))
            else:
                out.append((*base, rest))
        return out

    # Unknown pattern (a config written by a newer build, or a typo): deal
    # something valid rather than leaving the room mid-frame.
    return [(*c, 1.0) for c in deal(colors, n, rng)]


def _rest_level(opts: dict) -> float:
    """How dim a "resting" cell sits. 0 means genuinely off."""
    if opts.get("rest") == "off":
        return 0.0
    return max(0.0, min(0.9, _clamp(opts.get("rest_pct"), 0, 90, 15) / 100))


def _accent_color(colors: list, lap: int):
    """The travelling color for Comet / Accent: colors[0] is the base,
    and the accent walks the rest of the palette one lap at a time so a
    five-color palette is used rather than reduced to two."""
    k = len(colors)
    return colors[1 + (lap % (k - 1))] if k > 1 else colors[0]
