# LightEmUp — Claude Code Context

This file helps Claude Code (or any AI coding assistant) understand the project structure, conventions, and gotchas. If you're a developer using Claude Code on this repo, this context is loaded automatically.

## Project Overview

LightEmUp is a local-network web app for unified control of Philips Hue (Zigbee) and Govee (LAN/UDP) smart lights. FastAPI backend + React frontend, fully local with no cloud dependency.

## Workflow Rules (every session — not optional)

These conventions are already established. A fresh session must follow them without
being re-told. Nested `CLAUDE.md` files document subsystem internals:
`backend/CLAUDE.md` (server) and `backend/static/js/CLAUDE.md` (frontend). Read those
instead of spelunking, and **update them when you change how something works.**

### Versioning
- SemVer `X.Y.Z`. Single source of truth: `backend/version.py` (`__version__`).
- **Bump the version on every functional commit.** Claude decides the bump:
  - **Z (patch)**: bug fixes, small UI refinements, internal cleanup.
  - **Y (minor)**: meaningful new user-visible feature or capability.
  - **X (major)**: breaking config-schema change, removed/renamed endpoint, UX rework.
- Include the new version in the commit subject as a `(vX.Y.Z)` suffix.

### Commits
- Subject: imperative summary + ` (vX.Y.Z)`, e.g.
  `Batch cloud_v2 segment apply by color to stop dropped segments (v2.10.0)`.
- Body: explain the **why** (the problem) and the approach.
- Always end with this trailer exactly:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **Never commit**: `backend/config.json` (gitignored — local IPs/creds), the
  untracked `mockups/` directory, or any secret/.env. Stage only the files your change
  touched — don't `git add -A` blindly.
- **Push only when the user explicitly says to** ("push", "commit and push").

### Deploy / restart
- Runs on a Raspberry Pi as the `lightemup` systemd service.
- To deploy after pushing, the user runs (in their PowerShell):
  `ssh -t pi@lightemup '~/lightemup/deploy/update.sh'`
  (git pull --ff-only → pip install → reinstall unit if changed → restart service).
- **After every code change, state the deploy impact:** frontend `static/js/*` change
  = the running deploy just needs a normal page load; any backend `*.py` change = server
  restart required. Emit the ssh command only when a restart is needed, and only after
  pushing. (v2.19.8+: `GET /` cache-busts the `js/*.js` script tags with the build hash,
  so after a deploy — which restarts and bumps the hash — browsers auto-load fresh JS.
  No more manual hard-refresh. The one exception is the *first* load after upgrading
  from a pre-2.19.8 build, where the old cached shell must be hard-refreshed once.)

### Testing with physical lights
- Before running any debug/diagnostic test that drives real lights, **ask which room**
  it should run in. (Dan works in the living room at night; a stray test once lit the
  bedroom/study/stairs and woke the house.)

### Verifying UI changes (screenshot before you ship)
- **Don't declare a frontend/UI change done without looking at it.** There is no build
  step, so a change can transpile fine and still render wrong (this repo's room-map UI
  took several blind iterations before this was set up). Use `tools/preview/`:
  it serves the working-tree frontend and proxies `/api` to the Pi (read-only — it never
  writes to the Pi), so you render **your uncommitted changes against real data** and
  screenshot them headlessly (Edge via Playwright). Read the PNG, iterate, *then* hand
  it off to deploy. See `tools/preview/README.md`. Verify both desktop (~1440) and
  mobile (~390) widths for layout changes.
- The Pi stays the single server of record; the preview harness is a stateless local
  dev tool. Don't run the real backend on Windows just to look at the UI.

## Architecture

- **Backend**: Python FastAPI in `backend/main.py`, device layer in `backend/discovery.py`, scene engine in `backend/scenes.py`
- **Frontend**: Modular React app — `backend/static/index.html` is a thin shell that loads 10 component files from `backend/static/js/` via `<script type="text/babel" src="...">` tags. React 18 and Babel load from CDN; Babel transpiles JSX in-browser. No build step.
- **Config**: `backend/config.json` (gitignored) stores bridge credentials, room assignments, nicknames, room layouts, and scene settings. Copy `config.json.example` to get started.
- **Server**: Runs on port 8420 (`http://localhost:8420`)

## File Structure

```
backend/
  main.py              # FastAPI app — all API endpoints
  discovery.py         # Hue REST + Govee UDP discovery & control
  scenes.py            # Lightning storm scene engine
  config.json          # LOCAL ONLY (gitignored) — user config
  config.json.example  # Template for config.json
  static/
    index.html         # HTML shell — CSS, CDN imports, script tags
    js/                   # Load order is set by <script> tags in index.html (authoritative)
      utils.js            # React hooks, api() wrapper, color math, useIsMobile, useThrottledControl, seeded PRNG
      audio.js            # Thunder synth (WebAudio), fart sounds (preloaded MP3s)
      components-shared.js # ColorPicker, ColorWheel, Slider, ColorTempSlider, StatusBadge, RgbSliderInput
      light-card.js       # LightCard — per-device control (toggle, brightness, color, nickname)
      lightning-panel.js  # LightningPanel — storm scene UI with presets and SSE sync
      room-map.js         # RoomMap — interactive SVG floor plan & linear layout editor
      palette-data.js     # Static color datasets for Teams/NCAA/Flags modes (PRESET_TEAMS/NCAA/FLAGS)
      color-mode.js       # Room color tool — palette/gradient/beacon/custom/teams/ncaa/flags + apply pipeline
      segment-reset-debug.js # Debug panel for segment reset behavior
      room-section.js     # RoomSection — room grouping with controls, map, lightning toggles
      room-assignment.js  # RoomAssignment — device-to-room assignment UI
      setup-wizard.js     # SetupWizard — Hue Bridge discovery and pairing
      server-logs.js      # ServerLogs — live server log viewer
      ct-calibration.js   # CTCalibrationPanel — RGB-space white calibration UI
      app.js              # App component — state, routing, SSE client, API orchestration
    sounds/farts/       # 20 MP3 files for "funny mode" thunder replacement
tools/
  preview/             # Read-only harness to SEE the web UI without deploying:
                       # serves the working-tree frontend + proxies /api to the Pi,
                       # then screenshots it headlessly (Edge via Playwright). See
                       # tools/preview/README.md.
```

## Frontend Conventions

- **No build step**: All JS is in `backend/static/js/*.js` as JSX, transpiled by Babel standalone in the browser. Files share the global scope and must be loaded in dependency order (defined by script tags in `index.html`).
- **React hooks at top of utils.js**: `const { useState, useEffect, useCallback, useRef } = React;` — available to all files.
- **Global functions**: Components and utilities are plain `function` declarations at file top level (not `export`). They're global because Babel standalone executes each file in the same scope.
- **Optimistic UI**: All device control actions update local state immediately without waiting for API response. API calls are fire-and-forget with `.catch()` for logging.
- **Color spaces**: Hue devices report CIE `xy` coordinates — use `hueXYToRGB()` for accurate conversion. Govee devices use direct RGB. `getInitialColor()` handles both.
- **Device keys**: `hue:{light_id}` or `govee:{ip_address}` — used for nicknames, room layouts, and state tracking.

## UI/UX: Mobile + Desktop Responsive Design (REQUIRED)

Every UI change must work well on both desktop (16:9) and modern phones in portrait mode (iPhone 17 ~402px wide, Galaxy S26 ~384px wide — targeting 18:9/19:9 aspect ratios).

**Rules — apply to every UI change:**

1. **Always use `useIsMobile()`** from `utils.js` for width-conditional styling. The breakpoint is 640px. Never hardcode pixel widths for layout — always fork on `isMobile`.

2. **Padding**: Use `isMobile ? 12 : 20` or `isMobile ? 14 : 20` for card/panel padding. Never a fixed 20-24px on all screens.

3. **Button rows**: Always add `flexWrap: "wrap"` so buttons reflow onto a second line rather than overflow. Shorten labels on mobile (e.g. `isMobile ? "Controls" : "Room Controls"`).

4. **Grids**: Use `gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fill, minmax(260px, 1fr))"` — single column on phones.

5. **Font sizes**: Reduce on mobile (e.g. `isMobile ? 17 : 20` for section headers, `isMobile ? 11 : 12` for buttons).

6. **Avoid fixed widths/minWidths on flex children**: Use `flex: "1 1 auto"` or `flex: "1 1 120px"` instead of `minWidth: 140` on narrow screens.

7. **Top-level containers**: Reduce outer margin/padding on mobile (e.g. wizard container uses `margin: isMobile ? "20px auto" : "80px auto"`).

8. **Test both viewports mentally before finishing**: Would this render correctly at 390px wide (portrait phone)? At 1280px wide (desktop)?

## Backend Conventions

- **Config persistence**: `config.json` is read at startup and written on every mutation (rooms, nicknames, layouts, settings). Use the helper pattern in `main.py`.
- **Govee UDP constraints**: Only one socket can bind port 4002 at a time. State queries (`devStatus`) must be sequential, not parallel. Control commands are fire-and-forget.
- **Static file serving**: `index.html` is served via a dedicated `GET /` route. The `js/` and `sounds/` directories are mounted as `StaticFiles`.

## Key Gotchas

1. **Govee port 4002 conflicts**: If the server holds a socket on 4002 (e.g. during discovery), concurrent requests will fail. The discovery code uses `SO_REUSEADDR` and falls back to a random port.
1b. **Govee discovery is lossy; presence is assumed (v2.16.0)**: a Govee device's identity is its stable device id, not its IP (which is DHCP). One rescan re-broadcasts several times and known-but-silent devices still surface (badged offline) and stay controllable. `GET /api/discover/govee` returns each device with a `responding` flag. NOTE: storage is still keyed by IP, so a DHCP IP change orphans associations until the planned MAC-keying migration — see `backend/CLAUDE.md`. Mitigation today: DHCP reservations.
2. **Razer protocol 60s timeout**: Per-segment control via the Razer protocol auto-disables after 60 seconds with no LED data. The scene engine sends keepalive packets.
3. **Babel script order matters**: The `<script>` tags in `index.html` must be in dependency order. `utils.js` first (defines hooks, API, color utils), `app.js` last (uses everything).
4. **config.json is gitignored**: It contains local network IPs and credentials. Always use `config.json.example` as the template.
5. **Hue bridge pairing**: Requires physical button press on the bridge within 30 seconds of the pair API call.

## Running Locally

```bash
cd backend
python -m venv venv
# Windows: .\venv\Scripts\Activate.ps1
# Linux/Mac: source venv/bin/activate
pip install -r requirements.txt
python main.py
```

Open `http://localhost:8420`. Internet required on first load only (CDN scripts).

## API Structure

All endpoints are under `/api/`. Key groups:
- `/api/config` — full config read
- `/api/discover/govee`, `/api/discover/hue` — device discovery
- `/api/hue/light`, `/api/govee/control` — individual device control
- `/api/rooms`, `/api/rooms/control` — room CRUD and bulk control
- `/api/room-layouts` — floor plan / line layout CRUD (auto-saved from frontend)
- `/api/nicknames` — device nickname CRUD
- `/api/identify` — flash a device to locate it (Hue native `alert`; Govee on/off blink then restore)
- `/api/favorites` — favorite colors (stored in config, synced across sessions)
- `/api/scenes/lightning/*` — lightning storm scene start/stop/settings
- `/api/scenes/room-apply` — backend-driven room color-scene apply (staggered in a
  background task so the browser can close); `/cancel` to stop. Progress via SSE.
- `/api/govee/segment-*` — per-segment mode and count config

## Room Map System

The room map (`room-map.js`) is the most complex frontend component:
- **Two modes**: "Floor Plan" (2D grid) and "Line" (linear strip). Each mode's layout is preserved independently when toggling.
- **Full-window editor + numbered dots + legend (v2.19.0)**: the map no longer lives
  crushed inside the ~416px controls drawer. `RoomMap` has an `expanded` state:
  collapsed, the drawer shows a readable numbered **legend** (color swatch + number +
  name) and an "Open layout editor" launcher; expanded, the whole editor renders in a
  fixed full-window overlay (all devices, view + edit) with a sticky header + Done. On
  the canvas, every device/segment is a **numbered colored dot** (`compact` prop on
  `DeviceNode`/`SegmentNode`) sized as a fraction of the grid cell (`gridSize*0.36`) so
  it renders large under the overlay's fixed on-screen cell size (`FS_CELL`/`fsScale`);
  the number is the identifier, the color lets you glance-match a dot to its legend row.
  Both Line and Floor Plan use this (named pills got unwieldy with long names). The
  viewBox stays in user units so `getScreenCTM()` drag math is unaffected by scale.
- **Auto-save**: Layouts save to backend 600ms after any change (debounced).
- **Reference items**: Furniture/landmark items can be placed on the map for spatial context.
- **Tonal mode**: Generates harmonious color schemes across devices using HSL manipulation — supports random shade variation and spatial gradient modes.
