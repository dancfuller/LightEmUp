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
- **Non-functional commits don't bump and carry no suffix** — a docs-only edit, a
  comment fix, or a workflow-rule change ships as e.g. `Update commit trailer rule…`
  with no `(vX.Y.Z)`. Only a change to shipped behavior earns a version.

### Adding a setting — the config-key checklist (every session)
Any feature that persists something new writes a key into `backend/config.json`, and
that key is now part of the user's **backup**. Run this checklist in the *same commit*
that starts writing the key. It exists because six keys (`favorites`,
`lightning_scenes`, `govee_segment_counts`, `govee_segment_mode`, `room_presets`,
`schema_version`) were being written for months while `DEFAULT_CONFIG` never mentioned
them, and the restore preview couldn't see half the settings in the app.

1. **Declare it in `DEFAULT_CONFIG`** (`backend/main.py`) with a one-line comment.
   That dict is the registry of what settings exist — not just a defaults table.
   Import merges a backup over it, so an undeclared key is *absent* after restoring a
   backup that predates the feature.
2. **Give it a label in `_SETTING_LABELS`** so the restore preview names it in
   English. This is cosmetic only: the preview derives its rows from the config keys,
   so an unlabelled key still appears — it just reads as `Govee scene address`
   instead of `Segments-or-whole per device`. Add a `_render_setting` case if a raw
   count would be meaningless (see `location`, `power_recovery`).
3. **Is it derived/runtime state rather than a setting?** Then add it to
   `_SETTING_INTERNAL` instead, so the preview doesn't list churn nobody would miss.
4. **Room- or zone-name-keyed?** Add it to `rename_room`, `delete_room` and
   `rename_zone` too, or a rename silently orphans it.
5. **Needs a migration?** Only if existing configs must be rewritten; guard it on the
   key's presence, not its contents.

**The export itself needs nothing** — `_export_envelope` deep-copies the whole live
config, so every key ships automatically. **Keep it that way.** If you ever find
yourself hand-listing keys to export, that's the bug this checklist exists to prevent.

### Commits
- Subject: imperative summary + ` (vX.Y.Z)`, e.g.
  `Batch cloud_v2 segment apply by color to stop dropped segments (v2.10.0)`.
- Body: explain the **why** (the problem) and the approach.
- Always end with exactly one co-author trailer, naming **the model actually writing
  the commit** — this varies by session, so use the current one rather than copying
  the previous commit's:
  `Co-Authored-By: Claude <model name> <noreply@anthropic.com>`
  e.g. `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. The history is
  therefore intentionally mixed (Opus 4.8 through v3.10.0, Opus 5 from v3.10.1) — an
  accurate attribution beats a uniform one. Nothing else goes in the trailer block.
- **Never commit**: `backend/config.json` (gitignored — local IPs/creds), the
  untracked `mockups/` directory, or any secret/.env. Stage only the files your change
  touched — don't `git add -A` blindly.
- **Push only when the user explicitly says to** ("push", "commit and push").

### Deploy / restart
- Runs on a Raspberry Pi as the `lightemup` systemd service.
- To deploy after pushing, the user runs (in their PowerShell):
  `ssh -t pi@lightemup '~/lightemup/deploy/update.sh'`
  (git pull --ff-only → pip install → reinstall unit if changed → restart → verify).
- **The restart needs sudo, and that has bitten twice.** Run it from a real terminal;
  the `!` prefix in Claude Code is NOT a terminal, so `ssh -t` can't allocate a PTY and
  sudo has nothing to prompt on. One-time fix so it works unattended:
  `ssh -t pi@lightemup 'sudo ~/lightemup/deploy/install-sudoers.sh'` — installs a
  narrowly-scoped `/etc/sudoers.d/lightemup` (restart / daemon-reload / status only;
  writing the unit file still needs a password, since that's equivalent to root).
  **Once that's installed, deploys run unattended** — no `-t`, no terminal:
  `ssh pi@lightemup '~/lightemup/deploy/update.sh'`. (v3.17.1: the script's
  can-I-finish probe asks `sudo -l` about the *restart command specifically*. It used
  to ask `sudo -n true`, which the narrow rule correctly denies — so a correctly
  configured box was refused its own deploy.)
- `update.sh` **checks it can finish before it changes anything** (v3.15.1). A deploy
  that pulls new files and then can't restart leaves the worst state — new frontend on
  disk, old backend running, so the browser calls endpoints that don't exist yet. It
  also ends by printing `/api/version` next to the expected git hash, so a stale process
  is obvious rather than silent. **Always confirm the deployed version afterwards** —
  a deploy has raced a push and landed a commit short before.
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
  palettes.py          # Palette library loader + candidate resolution / random pick
                       # for the scheduler's "random palette" action (v3.17.0)
  palette_library.json # SOURCE OF TRUTH for the 160 curated palettes, shared by the
                       # server and (via a generated JS file) the browser
  config.json          # LOCAL ONLY (gitignored) — user config
  config.json.example  # Template for config.json
  static/
    index.html         # HTML shell — CSS, CDN imports, script tags
    js/                   # Load order is set by <script> tags in index.html (authoritative)
      utils.js            # React hooks, api() wrapper, color math, useIsMobile, useThrottledControl,
                          # seeded PRNG, goveeSlug/goveeSegmentCount (mirror of the backend's
                          # gv_slug/gv_segment_count — keep them in step)
      audio.js            # Thunder synth (WebAudio), fart sounds (preloaded MP3s)
      components-shared.js # ColorPicker, ColorWheel, Slider, ColorTempSlider, StatusBadge, RgbSliderInput
      light-card.js       # LightCard — per-device control (toggle, brightness, color, nickname)
      lightning-panel.js  # LightningPanel — storm scene UI with presets and SSE sync
      room-map.js         # RoomMap — interactive SVG floor plan & linear layout editor
      palette-data.js     # Static color datasets for Teams/NCAA/Flags modes (PRESET_TEAMS/NCAA/FLAGS)
      palette-library.js  # GENERATED (tools/build-palette-library.py) — PALETTE_LIBRARY +
                          # PALETTE_CATEGORIES, the 160 curated palettes. Never hand-edit;
                          # edit backend/palette_library.json and regenerate.
      color-mode.js       # Room color tool — palette/gradient/beacon/custom/teams/ncaa/flags + apply pipeline
      location-data.js    # GENERATED (tools/build-location-data.py) — ZIP3 + world city
                          # coordinates for offline location entry. Never hand-edit.
      schedules.js        # SchedulesTab (time-based automation, incl. the random-palette
                          # action + its swatch previews) + Settings LocationCard
      zones.js            # ZoneBar (live On/Off per zone, in the global bar on every
                          # tab) + ZoneManager (create/edit, in Assign Rooms)
      segment-reset-debug.js # Debug panel for segment reset behavior
      room-section.js     # RoomSection — room grouping with controls, map, lightning toggles
      room-assignment.js  # RoomAssignment — device-to-room assignment UI
      setup-wizard.js     # SetupWizard — Hue Bridge discovery and pairing
      server-logs.js      # ServerLogs — live server log viewer
      ct-calibration.js   # CTCalibrationPanel — RGB-space white calibration UI
      backup-restore.js   # BackupRestoreCard — Settings export/import of every setting
                          # (downloads to the browser; import previews then replaces)
      app.js              # App component — state, routing, SSE client, API orchestration
    sounds/farts/       # 20 MP3 files for "funny mode" thunder replacement
deploy/
  update.sh            # Pull → pip → reinstall unit if changed → restart → verify.
                       # Aborts BEFORE pulling if it can't sudo (no TTY), so a deploy
                       # never half-lands.
  install-sudoers.sh   # One-time: narrow NOPASSWD rule so deploys need no terminal.
  lightemup.service    # systemd unit
tools/
  build-palette-library.py # Regenerates backend/static/js/palette-library.js from
                       # backend/palette_library.json (the single source of truth for
                       # palettes, shared by the browser and the scheduler on the Pi).
                       # Self-verifying: structural checks + spot-checks, exits non-zero.
  build-location-data.py # Regenerates backend/static/js/location-data.js from the
                       # public-domain US Census ZCTA gazetteer (+ a curated city list).
                       # Self-verifying: sanity/spot checks, exits non-zero on bad data.
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
1b. **Govee discovery is lossy; presence is assumed (v2.16.0)**: a Govee device's identity is its stable device id, not its IP (which is DHCP). One rescan re-broadcasts several times and known-but-silent devices still surface (badged offline) and stay controllable. `GET /api/discover/govee` returns each device with a `responding` flag. **Identity is now MAC-keyed (v3.0.0):** every Govee association is stored under a colon-free slug of the device's stable mac and the IP is resolved at send time, so a DHCP IP change no longer orphans associations. A one-time `schema_version`→2 migration re-keyed the config (backed up to `config.json.pre-mac-migration.bak`). See `backend/CLAUDE.md` for the helpers and the identity-vs-address boundary.
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
- `/api/config/export` — download EVERY setting as one JSON envelope (browser attachment,
  so the backup leaves the Pi — its SD card is the thing you're insuring against);
  `?include_credentials=false` strips the bridge token. `/api/config/import` replaces all
  settings from such a file (`dry_run` previews; writes a `config.json.pre-import-*.bak`
  first; no restart needed). See `backend/CLAUDE.md` "Backup / restore"
- `/api/discover/govee`, `/api/discover/hue` — device discovery (live LAN/network scan)
- `/api/hue/phantoms` — rooms listing Hue ids the bridge no longer has (a re-paired light
  comes back with a new id and the old one lingers forever). `POST /api/hue/phantoms/remove`
  purges one from every room/layout/nickname/record. **Both refuse if the bridge can't be
  read or returns no lights** — that would look like "everything is a phantom". Detection
  is automatic, removal is always an explicit click. See `backend/CLAUDE.md` "Phantom Hue lights"
- `/api/devices/stale` — Hue + Govee devices missing 5+ days (config key `hue_missing_since`
  for Hue; Govee reuses `last_seen`). Drives the header's third badge, which is a
  deliberately different claim from "not responding" — see `backend/CLAUDE.md` "Gone N days"
- `/api/discover/govee/cached` — instant Govee list from `known_devices` + last-known
  `device_state`, **no LAN scan** (used for the fast initial paint; the client then
  refreshes with the live `/api/discover/govee` in the background)
- `/api/hue/light`, `/api/govee/control` — individual device control
- `/api/rooms`, `/api/rooms/control` — room CRUD and bulk control
- `/api/rooms/last-applied` — record what a room is "Now showing" (the strip in each room
  header). The backend records this itself on every whole-room path incl. schedule fires;
  this endpoint is only for looks the frontend fans out client-side. Config key
  `room_last_applied`. See `backend/CLAUDE.md` "Now showing"
- `/api/rooms/status` — has anything ELSE changed each room since LightEmUp set it? (The
  Hue/Govee apps and Google Home routines all drive these lights, so the record goes
  stale.) Proves divergence where it can, reports `unknown` where it can't, and **never
  certifies a match**. `/api/rooms/reapply` is the "Set here" button that puts the stored
  look back. See `backend/CLAUDE.md` "Detecting that something ELSE changed a room"
- `/api/room-layouts` — floor plan / line layout CRUD (auto-saved from frontend)
- `/api/nicknames` — device nickname CRUD
- `/api/identify` — flash a device to locate it (Hue native `alert`; Govee on/off blink then restore)
- `/api/favorites` — favorite colors (stored in config, synced across sessions)
- `/api/power-recovery` — how a fresh boot after a power outage treats the lights
  (resume last state / stay off overnight); applied on the Pi's next boot only
- `/api/schedules` — time-based schedules CRUD (GET list, POST upsert-by-id,
  `DELETE /{id}`); `/api/location` — lat/lng for sunrise/sunset triggers. Config keys
  `schedules` + `location` are additive. The hub fires these on its own via a
  once-a-minute background loop — see `backend/CLAUDE.md` "Time-based schedules"
- `/api/palettes` — the shared palette library as the *Pi* sees it (the browser has the
  same data statically in `palette-library.js`; this endpoint exists so the two copies
  can be checked for drift). `POST /api/palettes/apply` — resolve a palette action's
  candidates, pick one at random, and apply it to a room/zone right now; it's the
  scheduler editor's "Try one now", and the same path a `palette` schedule fires. See
  `backend/CLAUDE.md` "Random palettes in the scheduler"
- `/api/zones` — zone CRUD (GET list, POST upsert-by-name, `DELETE /{name}`). A zone is a
  named group of rooms (config key `zones`, additive) that fans a white/color/power action
  over every member room (scenes stay room-only). `POST /api/zones/control` drives one
  live — the "all downstairs off" button in the global bar — via the same
  `_apply_action_to_room` path a zone schedule uses. `POST /api/zones/rename` migrates the
  key plus every reference (schedules + "Now showing" attribution); a plain upsert would
  orphan them.
- `/api/rooms/rename` — safe room rename that migrates every room-name-keyed structure +
  schedule/zone references (a plain `POST /api/rooms` upsert would orphan them). See
  `backend/CLAUDE.md` "Zones + safe room rename + Power action"
- `/api/scenes/lightning/*` — lightning storm scene start/stop/settings
- `/api/scenes/room-apply` — backend-driven room color-scene apply (staggered in a
  background task so the browser can close); `/cancel` to stop. Progress via SSE.
- `/api/govee/segment-*` — per-segment mode and count config (the `segment-mode` one is
  the **lightning** scene's switch, not the colour tool's)
- `/api/govee/scene-address` — per-device "do room scenes paint this as segments or as
  one colour?" (config key `govee_scene_address`). Read by BOTH the browser's scene apply
  and the scheduler's palette action, so a schedule matches a hand-applied look. Replaced
  the room-level toggle in v3.18.0. See `backend/CLAUDE.md` "Scene addressing"

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
