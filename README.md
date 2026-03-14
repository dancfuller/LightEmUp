# LightEmUp

A unified web app for controlling Philips Hue (Zigbee) and Govee (LAN) smart lights from a single interface. Includes a lightning storm scene engine with per-segment Govee panel control.

## Features

- **Hue Bridge integration** — auto-discovery, pairing, per-light control (on/off, brightness, color)
- **Govee LAN control** — auto-discovery via UDP broadcast, on/off, brightness, RGB color
- **Room grouping** — assign lights to rooms, control entire rooms at once
- **Per-light controls** — brightness slider, color wheel, RGB sliders, favorite colors
- **Room-level overrides** — set brightness/color for all lights in a room
- **Lightning storm scene** — realistic lightning simulation with preset frequency modes (Realistic, Slow, Medium, Fast, Epilepsy) and advanced timing controls
- **Govee Razer per-segment control** — independent color control of individual panels/segments on compatible Govee devices (e.g. H6061 Hexa Panels)
- **Device nicknames** — editable nicknames persisted across sessions
- **Mobile-friendly** — responsive UI, tap-based room assignment (no drag-and-drop)
- **No cloud dependency** — all control is local (Hue via bridge API, Govee via LAN UDP)

## Requirements

- Python 3.10+
- Philips Hue Bridge on the same network (optional)
- Govee devices with LAN Control enabled in the Govee Home app (optional)

## Setup

### 1. Clone and install

```powershell
cd lightemup\backend
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

On Linux/macOS:
```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### 2. Configure (optional)

Copy the example config:
```
cp config.json.example config.json
```

Or just start the server — it will create a default `config.json` on first run.

If you have a Govee API key (for cloud features), add it to `config.json`:
```json
{
  "govee_api_key": "your-api-key-here"
}
```

### 3. Start the server

```powershell
python main.py
```

The server runs at `http://localhost:8420`.

### 4. Open the UI

Navigate to `http://localhost:8420` in your browser.

### 5. Pair Hue Bridge (optional)

Click the **Hue** badge in the header, press the physical button on your Hue Bridge, then click **Pair** in the UI.

### 6. Assign devices to rooms

Go to the **Assign Rooms** tab to organize your lights into rooms.

## Firewall

If accessing from another device on your network, allow the server port:

```powershell
New-NetFirewallRule -DisplayName "LightEmUp" -Direction Inbound -Protocol TCP -LocalPort 8420 -Action Allow
```

If Govee devices aren't discovered, allow the UDP discovery ports:

```powershell
New-NetFirewallRule -DisplayName "Govee LAN Discovery" -Direction Inbound -Protocol UDP -LocalPort 4001,4002 -Action Allow
```

## Lightning Storm Scene

The lightning scene simulates a realistic thunderstorm by flashing Hue lights in randomized bursts. It includes frequency presets:

| Preset      | Gap Between Flashes | Burst Size | Feel                    |
|-------------|---------------------|------------|-------------------------|
| Realistic   | 15–60 seconds       | 1–2        | Distant summer storm    |
| Slow        | 5–20 seconds        | 1–2        | Approaching storm       |
| Medium      | 1.5–6 seconds       | 1–3        | Active storm            |
| Fast        | 0.5–2 seconds       | 2–5        | Intense storm           |
| Epilepsy    | 80–400 ms           | 4–8        | Strobe (use with care)  |

An **Advanced** toggle reveals detailed sliders for fine-tuning gap timing, flash duration, burst count, and inter-burst gaps.

Govee lights can optionally participate in the flash effect, or hold a background glow while Hue lights handle the flashing (controlled via the "Govee Lights" toggle in settings).

## Govee Razer Protocol (Per-Segment Control)

Some Govee devices support an undocumented "Razer" protocol that allows per-segment/per-panel color control over LAN. This is used by the lightning scene to flash individual Hexa panels independently.

**Confirmed working:** H6061 Glide Hexa Light Panels (7 segments)
**Not working:** H7065/H7066 Outdoor Spotlights (no response to Razer commands)

See the [Test Scripts](#test-scripts) section for tools to verify Razer support on your devices.

## Architecture

- **Backend**: Python FastAPI server handling device discovery, control, and scene management
  - Hue: local HTTP API via the bridge
  - Govee: UDP broadcast (port 4001) for discovery, UDP unicast (port 4003) for commands
  - Scenes: async pattern generation and per-light playback (`scenes.py`)
- **Frontend**: Single-page React app served as static HTML (no build step needed)
- **Config**: `config.json` stores bridge credentials, room assignments, nicknames, lightning settings

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/discover/hue` | Discover Hue bridges |
| POST | `/api/hue/pair` | Pair with a Hue bridge |
| GET | `/api/hue/lights` | List Hue lights |
| POST | `/api/hue/light` | Control a Hue light |
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

## Test Scripts

Interactive test scripts for validating the Govee Razer per-segment protocol on physical hardware. These are manual, visual tests — they send commands to real devices and prompt you to confirm what you see.

### `govee_razer_test.py`

Tests per-segment color control on **H6061 Glide Hexa Light Panels** (7 panels). Walks through 9 steps: turning on the device, enabling the Razer protocol, testing discrete colors (one per panel), gradient mode, fewer-than-max colors, and probing with 21 colors to verify segment limits. Resets to white and disables Razer mode when done.

```powershell
cd backend
python govee_razer_test.py
```

### `govee_spots_razer_test.py`

Tests per-segment color control on **H7065 (2-pack)** and **H7066 (4-pack) outdoor spotlights**. Runs the same protocol sequence on each device: enable Razer, send distinct colors per spot, test gradient mode, then reset. Used to determine whether these devices support the Razer protocol (result: they do not).

```powershell
cd backend
python govee_spots_razer_test.py
```

## Known Limitations

- Govee Razer per-segment control only confirmed working on H6061 Hexa Panels; outdoor spotlights (H7065/H7066) do not respond
- Govee command responses are unreliable — the app uses fire-and-forget with optimistic UI updates
- The Govee SKU-to-name map in the frontend covers a limited set of devices; unknown SKUs show the model number
- Razer protocol has a 60-second timeout — the scene engine sends keepalive packets to prevent auto-disable

## License

MIT
