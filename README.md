# LightEmUp

A unified web app for controlling Philips Hue (Zigbee) and Govee (LAN) smart lights from a single interface.

## Features

- **Hue Bridge integration** — auto-discovery, pairing, per-light control (on/off, brightness, color)
- **Govee LAN control** — auto-discovery via UDP broadcast, on/off, brightness, RGB color
- **Room grouping** — assign lights to rooms, control entire rooms at once
- **Per-light controls** — brightness slider, color wheel, RGB sliders, favorite colors
- **Room-level overrides** — set brightness/color for all lights in a room
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
cd C:\tools\lightemup
cd backend
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

If Govee devices aren't discovered, allow these UDP ports through your firewall:

```powershell
New-NetFirewallRule -DisplayName "Govee LAN Discovery" -Direction Inbound -Protocol UDP -LocalPort 4001,4002 -Action Allow
```

## Architecture

- **Backend**: Python FastAPI server handling device discovery and control
  - Hue: local HTTP API via the bridge
  - Govee: UDP broadcast (port 4001) for discovery, UDP unicast (port 4003) for commands
- **Frontend**: Single-page React app served as static HTML (no build step needed)
- **Config**: `config.json` stores bridge credentials, room assignments, nicknames

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

## Known Limitations

- Govee segment control (per-panel, per-spotlight) is not supported via the LAN API
- Govee command responses are unreliable — the app uses fire-and-forget with optimistic UI updates
- The Govee SKU-to-name map in the frontend covers a limited set of devices; unknown SKUs show the model number

## License

MIT
