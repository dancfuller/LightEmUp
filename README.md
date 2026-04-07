# LightEmUp

A local-network web app for controlling Philips Hue and Govee smart lights from a single interface. No cloud, no accounts — everything runs on your LAN.

![Python](https://img.shields.io/badge/Python-3.10+-blue) ![FastAPI](https://img.shields.io/badge/FastAPI-latest-009688) ![License](https://img.shields.io/badge/License-MIT-green)

## What It Does

LightEmUp discovers and controls Philips Hue (Zigbee via bridge) and Govee (LAN/UDP) smart lights through one unified web UI. Group lights into rooms, set colors and brightness, save favorites, and run scene effects — all without leaving your local network.

### Key Features

- **Unified control** — Hue and Govee devices in one UI with room grouping
- **Per-light controls** — on/off, brightness slider, color wheel, RGB sliders, favorite colors
- **Room-level overrides** — set brightness/color for all lights in a room at once
- **Interactive room maps** — drag-and-drop 2D floor plan and linear layout modes with live device state, per-device controls, reference furniture items, and auto-save
- **Lightning storm scene** — realistic thunderstorm simulation with Hue light flashes, configurable timing presets, optional thunder sound effects, and a "funny mode" that replaces thunder with fart sounds
- **Color Mode** — room-level color schemes with layout awareness: Gradient mode distributes shades along a direction, Palette mode assigns distinct colors so adjacent lights never match. Includes brightness control and 16 preset palettes across 4 rows (Spring/Easter, Warm, Cool, Nature/Bold)
- **Per-segment color control** — independent color control of individual panels/spotlights on compatible Govee devices. Hexa Panels (H6061) use the Razer LAN protocol; Outdoor Spotlights (H7065/H7066) use the Govee Platform API v2. Segments appear as separate nodes on the room map and integrate fully with Color Mode gradients and palettes.
- **Layout Identify mode** — one-click button assigns each light/segment a unique color based on physical proximity, making it easy to match map nodes to real-world lights
- **Device nicknames** — custom names persisted across sessions
- **Desktop shortcut launcher** — one-click launch with auto-server-start and browser open (Windows)
- **Server management** — restart or shut down the server from the Settings tab in the UI
- **280+ Govee SKU names** — automatic product name resolution for most Govee devices
- **Mobile-friendly** — responsive design, tap-based room assignment
- **Fully local** — no cloud dependency, no internet required after first load

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/dancfuller/LightEmUp.git
cd LightEmUp/backend
python -m venv venv
```

**Windows (PowerShell):**
```powershell
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

**Linux/macOS:**
```bash
source venv/bin/activate
pip install -r requirements.txt
```

### 2. Start the server

```bash
python main.py
```

Open `http://localhost:8420` in your browser. That's it.

### 3. Connect your lights

- **Hue**: Click the Hue badge in the header, press the physical button on your bridge, then click Pair
- **Govee**: Devices are auto-discovered if LAN Control is enabled in the Govee Home app

### Desktop Shortcut (Windows)

Run the shortcut installer for a one-click launcher on your Desktop and Start Menu:

```powershell
powershell -ExecutionPolicy Bypass -File install-shortcut.ps1
```

This creates a shortcut that silently starts the server (if not already running) and opens the browser — no console window.

## Lightning Storm Scene

A scene engine that simulates realistic thunderstorms by flashing lights in randomized bursts with synced thunder audio.

| Preset      | Gap Between Flashes | Burst Size | Feel                    |
|-------------|---------------------|------------|-------------------------|
| Realistic   | 15–60 seconds       | 1–2        | Distant summer storm    |
| Slow        | 5–20 seconds        | 1–2        | Approaching storm       |
| Medium      | 1.5–6 seconds       | 1–3        | Active storm            |
| Fast        | 0.5–2 seconds       | 2–5        | Intense storm           |
| Epilepsy    | 80–400 ms           | 4–8        | Strobe (use with care)  |

Features:
- **Thunder sound effects** — browser-synthesized thunder synced to flashes via Server-Sent Events
- **Funny mode** — replaces thunder with 20 real fart sound effects
- **Immediate vs. delayed** thunder timing toggle
- **Govee flash participation** — Govee lights can flash alongside Hue, or hold a background glow
- **Per-segment flashing** — on compatible Govee devices (e.g. Hexa Panels), individual panels flash independently
- **Advanced controls** — fine-tune gap timing, flash duration, burst count, and inter-burst gaps

## Architecture

```
backend/
  main.py           # FastAPI server — endpoints, room/nickname management
  discovery.py      # Device discovery & control (Hue REST, Govee UDP)
  scenes.py         # Lightning scene engine with async pattern generation
  requirements.txt  # Python deps (fastapi, uvicorn, httpx)
  start.ps1         # PowerShell launcher
  config.json       # LOCAL ONLY (gitignored) — IPs, credentials, rooms
  static/
    index.html      # HTML shell — loads React/Babel CDN + component scripts
    js/
      utils.js          # React hooks, API wrapper, color utilities, SKU names
      audio.js          # Thunder synth, fart sounds
      components-shared.js  # ColorPicker, ColorWheel, Slider, StatusBadge
      light-card.js     # Per-device control card
      lightning-panel.js # Lightning storm scene UI
      room-map.js       # Interactive 2D floor plan & linear layout
      color-mode.js     # Room-level color schemes (gradient & palette)
      room-section.js   # Room grouping with controls
      room-assignment.js # Drag-based room assignment UI
      setup-wizard.js   # Hue Bridge pairing wizard
      app.js            # Main App component + render
    sounds/         # Audio assets (fart sound effects for funny mode)
launch.ps1          # Silent launcher (starts server + opens browser)
launch.vbs          # VBScript wrapper for no-console-window launch
install-shortcut.ps1 # Desktop/Start Menu shortcut installer
```

- **Backend**: Python FastAPI with Hue (local REST API) and Govee (UDP broadcast/unicast) control
- **Frontend**: Modular React app split across 11 component files — React and Babel load from CDN, no build step, Babel transpiles in-browser
- **Config**: `config.json` stores bridge credentials, room assignments, nicknames, room layouts, scene settings (gitignored)

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/discover/hue` | Discover Hue bridges |
| POST | `/api/hue/pair` | Pair with a Hue bridge |
| GET | `/api/hue/lights` | List Hue lights |
| POST | `/api/hue/light` | Control a Hue light (supports RGB) |
| GET | `/api/discover/govee` | Discover Govee LAN devices |
| POST | `/api/govee/control` | Control a Govee device |
| GET | `/api/rooms` | Get room assignments |
| POST | `/api/rooms` | Save room assignments |
| POST | `/api/rooms/control` | Control all lights in a room |
| GET | `/api/config` | Get current configuration |
| POST | `/api/nicknames` | Set a device nickname |
| GET | `/api/nicknames` | Get all nicknames |
| POST | `/api/scenes/lightning/start` | Start lightning scene for a room |
| POST | `/api/scenes/lightning/stop` | Stop lightning scene for a room |
| GET | `/api/scenes/lightning/status` | Get rooms with active lightning |
| GET | `/api/scenes/lightning/settings/{room}` | Get saved lightning settings |
| POST | `/api/scenes/lightning/settings` | Save lightning settings |
| POST | `/api/govee/segment-mode` | Toggle per-segment mode for a device |
| POST | `/api/govee/segment-count` | Set segment count for a device |
| GET | `/api/govee/segment-info` | Get segment capabilities for all SKUs |
| POST | `/api/govee/segment-control` | Control a single segment via Govee Platform API v2 |
| GET | `/api/room-layouts/{room}` | Get room layout |
| POST | `/api/room-layouts` | Save/update room layout |
| DELETE | `/api/room-layouts/{room}` | Delete room layout |
| POST | `/api/server/shutdown` | Shut down the server |
| POST | `/api/server/restart` | Restart the server |

## Govee Per-Segment Control

Two protocols are used for per-segment color control depending on the device:

### Razer Protocol (LAN, H6061 Hexa Panels)
An undocumented binary protocol sent over the local UDP port. Used by the lightning scene to flash individual Hexa panels independently.

**Confirmed working:** H6061 Glide Hexa Light Panels (7 segments)

### Govee Platform API v2 (Cloud, H7065/H7066 Outdoor Spotlights)
The Outdoor Spotlights 2-Pack and 4-Pack do not respond to the Razer protocol. Per-segment control is only available via the Govee Platform API v2. A Govee Developer API key is required — set `govee_api_key` in `config.json`.

**Confirmed working:** H7065 Outdoor Spotlights 2-Pack (2 segments), H7066 4-Pack (4 segments)

The V2 API enforces a ~1 req/sec rate limit, so applying a color gradient to multiple segments takes a few seconds.

To enable per-segment control on a device, open the room map, enter Edit Layout, and click the expand toggle on any segment-capable device node.

## Firewall

If accessing from another device on your network, allow the server port:

```powershell
New-NetFirewallRule -DisplayName "LightEmUp" -Direction Inbound -Protocol TCP -LocalPort 8420 -Action Allow
```

If Govee devices aren't discovered, allow the UDP discovery ports:

```powershell
New-NetFirewallRule -DisplayName "Govee LAN Discovery" -Direction Inbound -Protocol UDP -LocalPort 4001,4002 -Action Allow
```

## Requirements

- **Python 3.10+** — must be on your system PATH
- **Internet connection** — required on first launch only (React/Babel load from CDN)
- Philips Hue Bridge on the same network (optional)
- Govee devices with LAN Control enabled in the Govee Home app (optional)

### Windows Notes

- **PowerShell execution policy**: If you get "running scripts is disabled", run once in an admin PowerShell:
  ```powershell
  Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
  ```
- **Python on PATH**: When installing from [python.org](https://www.python.org/downloads/), check "Add python.exe to PATH"

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `python` not recognized | Install Python and ensure it's on PATH. Restart your terminal. |
| Scripts disabled on this system | Run `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser` in admin PowerShell |
| UI is blank | Frontend needs internet on first load (CDN). Check your connection and refresh. |
| Port 8420 in use | Check with `netstat -ano \| findstr :8420` and close the conflicting process |
| Govee devices not found | Enable LAN Control in Govee Home app. Allow UDP 4001/4002 through firewall. |
| Can't access UI from phone | Allow TCP 8420 through firewall (see [Firewall](#firewall)) |

## Known Limitations

- Govee Razer per-segment control only confirmed on H6061 Hexa Panels
- Govee commands are fire-and-forget — the app uses optimistic UI updates
- Razer protocol has a 60-second timeout; the scene engine sends keepalive packets
- Unknown Govee SKUs fall back to showing the model number

## License

MIT
