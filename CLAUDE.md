# LightEmUp — Claude Code Context

This file helps Claude Code (or any AI coding assistant) understand the project structure, conventions, and gotchas. If you're a developer using Claude Code on this repo, this context is loaded automatically.

## Project Overview

LightEmUp is a local-network web app for unified control of Philips Hue (Zigbee) and Govee (LAN/UDP) smart lights. FastAPI backend + React frontend, fully local with no cloud dependency.

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
    js/
      utils.js            # React hooks, API wrapper, color math, SKU names, favorites
      audio.js            # Thunder synth (WebAudio), fart sounds (preloaded MP3s)
      components-shared.js # ColorPicker, ColorWheel, Slider, StatusBadge, RgbSliderInput
      light-card.js       # LightCard — per-device control (toggle, brightness, color, nickname)
      lightning-panel.js  # LightningPanel — storm scene UI with presets and SSE sync
      room-map.js         # RoomMap — interactive SVG floor plan & linear layout editor
      room-section.js     # RoomSection — room grouping with controls, map, lightning toggles
      room-assignment.js  # RoomAssignment — device-to-room assignment UI
      setup-wizard.js     # SetupWizard — Hue Bridge discovery and pairing
      app.js              # App component — state management, routing, API orchestration
    sounds/farts/       # 20 MP3 files for "funny mode" thunder replacement
```

## Frontend Conventions

- **No build step**: All JS is in `backend/static/js/*.js` as JSX, transpiled by Babel standalone in the browser. Files share the global scope and must be loaded in dependency order (defined by script tags in `index.html`).
- **React hooks at top of utils.js**: `const { useState, useEffect, useCallback, useRef } = React;` — available to all files.
- **Global functions**: Components and utilities are plain `function` declarations at file top level (not `export`). They're global because Babel standalone executes each file in the same scope.
- **Optimistic UI**: All device control actions update local state immediately without waiting for API response. API calls are fire-and-forget with `.catch()` for logging.
- **Color spaces**: Hue devices report CIE `xy` coordinates — use `hueXYToRGB()` for accurate conversion. Govee devices use direct RGB. `getInitialColor()` handles both.
- **Device keys**: `hue:{light_id}` or `govee:{ip_address}` — used for nicknames, room layouts, and state tracking.

## Backend Conventions

- **Config persistence**: `config.json` is read at startup and written on every mutation (rooms, nicknames, layouts, settings). Use the helper pattern in `main.py`.
- **Govee UDP constraints**: Only one socket can bind port 4002 at a time. State queries (`devStatus`) must be sequential, not parallel. Control commands are fire-and-forget.
- **Static file serving**: `index.html` is served via a dedicated `GET /` route. The `js/` and `sounds/` directories are mounted as `StaticFiles`.

## Key Gotchas

1. **Govee port 4002 conflicts**: If the server holds a socket on 4002 (e.g. during discovery), concurrent requests will fail. The discovery code uses `SO_REUSEADDR` and falls back to a random port.
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
- `/api/scenes/lightning/*` — lightning storm scene start/stop/settings
- `/api/govee/segment-*` — per-segment mode and count config

## Room Map System

The room map (`room-map.js`) is the most complex frontend component:
- **Two modes**: "Floor Plan" (2D grid) and "Line" (linear strip). Each mode's layout is preserved independently when toggling.
- **SVG rendering**: Devices are pill-shaped nodes with color dots, draggable in edit mode with grid snapping.
- **Auto-save**: Layouts save to backend 600ms after any change (debounced).
- **Reference items**: Furniture/landmark items can be placed on the map for spatial context.
- **Tonal mode**: Generates harmonious color schemes across devices using HSL manipulation — supports random shade variation and spatial gradient modes.
