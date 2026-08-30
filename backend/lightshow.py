"""Room lightshows — the pattern math, with no idea what a light is.

A lightshow is a slow, ambient re-arrangement of a room's colors: not synced to
anything, just "the last time I looked at the house, these lights were different
colors". Segment addressing is what sets the tempo — a cloud_v2 device takes
~1.8s per distinct color, so a step that repaints a hexa costs seconds, and the
interesting cadence is 20–60s rather than 20–60ms. Every pattern here is
therefore designed to look deliberate at a standstill, not to animate.

This module is deliberately pure, like `palettes.py`: it maps
(pattern, cell count, color pool, step) → a color and a level for each cell.
It knows nothing about rooms, devices, segments or config — turning cells into
Hue/Govee calls is `main.py`'s job, because that needs the device layer.

`ColorDealer` lives here rather than in main.py because two features now need
the same "shuffle so no two neighbors match" rule: the scheduler's palette
action and the Shuffle/Palette-hop patterns. One copy, one behavior.
"""

import random
from typing import Optional

# ─── The pattern catalog ─────────────────────────────────────────────────────
# Served by GET /api/lightshow so the browser renders labels and blurbs from
# the same table the Pi validates against — the two can't drift into describing
# a pattern differently. `opts` names the extra controls the editor shows.

PATTERNS = [
    {
        "key": "walk",
        "name": "Walk",
        "blurb": "The palette repeats along the room (A B C A B C) and slides one place each step.",
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
        "needs_set": True,       # only meaningful with 2+ palettes to draw from
    },
    {
        "key": "accent",
        "name": "Accent",
        "blurb": "The room holds one color while a single accent travels from light to light.",
        "opts": [],
    },
]

PATTERN_KEYS = {p["key"] for p in PATTERNS}
DEFAULT_PATTERN = "walk"


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


def deal(colors: list, n: int, rng=None) -> list:
    """`n` colors dealt from the pool, no two adjacent alike."""
    d = ColorDealer(colors, rng)
    return [d.next() for _ in range(n)]


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


def plan_frame(pattern: str, n: int, colors: list, step: int,
               opts: Optional[dict] = None, prev: Optional[list] = None,
               rng=None) -> list:
    """One frame: `(r, g, b, level)` per cell, in room order.

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
    if n <= 0 or not colors:
        return []
    k = len(colors)

    if pattern == "walk":
        off = _walk_offset(step, k, opts.get("direction") or "forward")
        return [(*colors[(i + off) % k], 1.0) for i in range(n)]

    if pattern == "alternate":
        groups = max(2, min(4, int(opts.get("groups") or 2)))
        if opts.get("rest") == "off":
            rest = 0.0
        else:
            rest = max(0.0, min(0.9, int(opts.get("rest_pct") or 15) / 100))
        lit = step % groups
        return [(*colors[i % k], 1.0 if i % groups == lit else rest)
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
            pairs = max(1, min(n // 2, int(opts.get("swaps") or 2)))
            for _ in range(pairs):
                i, j = rng.sample(range(n), 2)
                arr[i], arr[j] = arr[j], arr[i]
        return [(*c, 1.0) for c in arr]

    if pattern == "accent":
        base = colors[0]
        pos = step % n
        # The accent color changes once per lap, so a five-color palette is
        # actually used rather than reduced to two.
        accent = colors[1 + ((step // n) % (k - 1))] if k > 1 else base
        return [(*(accent if i == pos else base), 1.0) for i in range(n)]

    # Unknown pattern (a config written by a newer build, or a typo): deal
    # something valid rather than leaving the room mid-frame.
    return [(*c, 1.0) for c in deal(colors, n, rng)]
