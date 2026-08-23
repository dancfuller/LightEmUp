# tools/preview — see the web UI without deploying

Renders the **working-tree** frontend against the **Pi's real data** and takes a
headless screenshot, so a UI change can be verified visually *before* it's
committed/deployed. Read-only: it never writes to the Pi.

## How it works
- `serve.mjs` serves `backend/static/` locally and reverse-proxies `GET /api` +
  `/events` (SSE) to the Pi. Non-GET `/api` calls are stubbed with a success so
  the frontend's optimistic UI still reflects changes locally, but the Pi (the
  server of record) is never mutated.
- `shoot.mjs` drives the installed Edge/Chrome (Playwright `channel`, no browser
  download) to load the page, optionally click into a state, and write a PNG.

## Setup (once)
```
cd tools/preview
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install   # uses system Edge via channel
```

## Use
```
# 1. start the preview server (background); PI defaults to http://lightemup:8420
PI=http://lightemup:8420 PORT=8421 node serve.mjs

# 2. screenshot a state
URL=http://localhost:8421/ OUT=rooms.png W=1440 H=900 node shoot.mjs

# drive into a nested UI state (STEPS = JSON array of text to click; text@N = Nth match)
STEPS='["Controls@2","Map","Open layout editor"]' OUT=layout.png node shoot.mjs

# mobile viewport
W=390 H=844 OUT=layout-mobile.png STEPS='["Controls@2","Map","Open layout editor"]' node shoot.mjs
```

Notes:
- `channel` defaults to `msedge`; set `BROWSER_CHANNEL=chrome` if Edge isn't present.
- The version in the footer comes from the Pi's `/api/version`, so it reflects the
  Pi's build, not the working tree — that's expected.

## fixture-check.mjs — regression test for palette adjacency

`node fixture-check.mjs` (with `serve.mjs` running) sweeps palettes against the
real room and **exits non-zero** if a fixture — several bulbs in one housing —
ever shows fewer distinct colors than it has bulbs.

This exists because that property broke repeatedly and quietly. It broke on
*some* palettes while typical library ones passed, so hand-testing kept missing
it: before v3.37.0 the saved 4-color palette gave the Triple Lamp 2 colors
across 3 bulbs on every single shuffle, while Cotton Candy / Pop Art / Frostbite
/ Autumn all looked fine. **Run this after touching anything in
`computePalette` or `buildAdjacency`.**

```
ROOM_INDEX=1 SHUFFLES=6 node fixture-check.mjs
PALETTES='["Pop Art","Frostbite"]' node fixture-check.mjs
```

The room's own saved palette is always tested first, as `(saved)`.
