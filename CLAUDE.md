# LightEmUp — Project Context for Claude Code

## Overview

LightEmUp is a local-network web app that unifies control of Philips Hue (Zigbee) and Govee (LAN/UDP) smart lights from a single interface. It runs as a FastAPI backend serving a React frontend (single HTML file, no build step). The goal is full local control with no cloud dependency.

## Repository

- Location: `C:\repos\lightemup`
- Branch strategy: Direct commits to `main` (no pull requests)
- Server runs from: `C:\repos\lightemup\backend` with a local Python venv

## Architecture

- **Backend**: Python FastAPI (`main.py`) + device layer (`discovery.py`)
- **Frontend**: Single-page React app in `backend/static/index.html` (React via CDN, Babel in-browser)
- **Config**: `config.json` (gitignored) stores bridge IP, API key, room assignments, nicknames
- **Server**: `http://localhost:8420`

## File Structure

```
backend/
  main.py           # FastAPI app, endpoints, room/nickname management
  discovery.py      # Device discovery & control (Hue REST, Govee UDP)
  requirements.txt  # Python deps (fastapi, uvicorn, httpx)
  start.ps1         # PowerShell launcher
  config.json       # LOCAL ONLY — gitignored, contains IPs, API key, rooms
  config.json.example
  static/
    index.html      # Full React frontend (~1750 lines)
.gitignore
README.md
```

## Device Inventory

### Hue (Zigbee via Hue Bridge)
- Bridge IP: 192.168.0.52
- 2 Philips Hue bulbs (white)
- 7 Innr bulbs (RGB) — third-party Zigbee, no firmware updates via Hue Bridge
- Total: 9 Hue-controlled lights

### Govee (LAN UDP)
| SKU   | Name                      | IP            | Segments | Notes |
|-------|---------------------------|---------------|----------|-------|
| H70C1 | Christmas String Lights 2 | 192.168.0.141 | Unknown  | Segment control via colorwc `segment` param did NOT work (whole strand changes) |
| H7065 | Outdoor Spotlights 2-Pack | 192.168.0.229 | 2        | Razer protocol did NOT work. ptReal testing deferred. |
| H7066 | Outdoor Spotlights 4-Pack | 192.168.0.209 | 4        | Razer protocol did NOT work. ptReal testing deferred. |
| H6061 | Glide Hexa Light Panels   | 192.168.0.129 | 7        | **Razer protocol WORKS** for per-panel control |
| H61D3 | Neon Rope Light 2         | 192.168.0.61  | Unknown  | Not yet tested for segments |

### Luxor (Landscape Lighting)
- FX Luminaire Luxor ZDC/DERA controller (supports color)
- 4 fixtures, all soft-white dimmable (not RGB)
- Low priority — would need ZDC-compatible RGB fixtures to enable color

## Room Layout

- **Bedroom**: 2 white Hue bulbs
- **Living Room**: 9 RGB Hue + Hexa Panels + Neon Rope + Christmas Lights
- **Outside**: 2 Hue + Spots 2pk + Spots 4pk

## Protocol Details

### Hue Bridge
- Local REST API v1: `http://{bridge_ip}/api/{username}/lights`
- Pairing: POST to `/api` with `{"devicetype":"lightemup#server"}` while bridge button is pressed
- Color: Returns `xy` (CIE coordinates), `hue` (0-65535), `sat` (0-254), `bri` (0-254), `ct` (mirek)
- Color accuracy: Use `xy` coordinates with Wide RGB D65 matrix for best RGB conversion; hue/sat as fallback
- Innr bulbs: Work on Hue Bridge, cannot receive firmware updates through it

### Govee LAN Protocol
- **Discovery**: UDP broadcast to `255.255.255.255:4001` with `{"msg":{"cmd":"scan","data":{"account_topic":"reserve"}}}`
- **Responses**: Always on port 4002 regardless of sender port
- **Commands**: Send to device IP on port 4003
- **State query**: `devStatus` command — MUST use Method B (send to 4003, listen on separate socket bound to 4002)
- **Single socket constraint**: Only one socket can bind to UDP 4002 at a time, so state queries must be sequential (not parallel)
- **Commands**: `turn`, `brightness`, `colorwc`, `devStatus`
- **Fire-and-forget**: Control commands (turn, brightness, colorwc) don't reliably return responses; use optimistic UI updates

### Govee Razer Protocol (Undocumented)
Used for per-LED/per-segment control over LAN. Works on Dreamview/Razer-compatible devices.

```
{"msg":{"cmd":"razer","data":{"pt":"<base64 encoded binary>"}}}
```

Binary packet format: `{0xBB, 0x00, <data_size>, <command>, <data...>, <checksum>}`
- Checksum: XOR all bytes
- **0xB1**: Enable/disable (1 byte: 0=off, 1=on). 1-minute timeout if no LED data sent.
- **0xB0**: LED data. Byte 0=gradient (bool), Byte 1=color count, then RGB triplets.

**Test results:**
- ✅ H6061 Hexa Panels: Works perfectly. 7 segments (one per physical panel). Discrete mode, gradient mode, and 2-color mode all work. Sending >7 colors (e.g. 21) does NOT work.
- ❌ H7065 Outdoor Spots 2pk: No response to Razer protocol. Lights unchanged.
- ❌ H7066 Outdoor Spots 4pk: No response to Razer protocol. Lights unchanged.
- ❓ H70C1 Christmas Lights: Not tested with Razer.
- ❓ H61D3 Neon Rope Light: Not tested with Razer.

### Govee ptReal Protocol (Undocumented)
BLE-over-LAN bridge. Sends Bluetooth commands over the LAN API.

```
{"msg":{"cmd":"ptReal","data":{"command":["<base64>",...]}}}
```

Each command is a 20-byte BLE packet: 19 data bytes (zero-padded) + 1 XOR checksum byte, then base64-encoded.

Packet byte 0 = command type (0x33 = standard BLE command).
- `33 01 01` = Turn on
- `33 01 00` = Turn off
- `33 05 13 ID1 ID2 R G B ...` = Segment color (H70C4 format, bitmask addressing)

Segment addressing uses bitmask: segment 0=0x01, 1=0x02, 2=0x04, 3=0x08 (powers of 2), split across ID1 (low byte) and ID2 (high byte).

**Status**: ptReal testing on H7065/H7066 outdoor spots was deferred. A test script exists (`govee_ptreal_spots_test.py`) that tries 4 different byte formats (A through D). The Govee app DOES support per-spotlight color control, confirming the BLE protocol supports it — we just need the right byte format.

### Govee colorwc `segment` Parameter
The official LAN API `colorwc` command accepts a `segment` array parameter, but in testing it did NOT produce per-segment behavior on any device tested:
- H70C1: Entire strand changed to one solid color regardless of segment value
- H6061: Same — whole device changed color

This parameter appears to be non-functional or meant for a different purpose.

## Frontend Details

### UI Structure
- **Header**: App title, refresh button (↻ with spin animation), Hue connection badge, Govee device count badge
- **Tabs**: Rooms, All Lights, Assign Rooms, Settings
- **Room controls**: Brightness slider, color wheel, RGB sliders (0-255), favorites
- **Per-light controls**: Same as room + on/off toggle, nickname edit
- **Assign Rooms tab**: Tap-based room assignment (no drag-and-drop, mobile-friendly)

### State Management
- Optimistic UI updates for all control actions (no await on API calls, no loadAll after control)
- `loadAll()` fetches config, Govee discovery+state, Hue lights+groups
- Refresh button calls `loadAll()` with spinner
- Color initialization: `getInitialColor()` converts Hue xy/hue-sat or Govee RGB to display color
- `useEffect` syncs LightCard brightness/color when light prop changes (after refresh)

### Favorites System
- Stored in `localStorage` under key `lightemup_fav_colors`
- Save/edit/delete per color swatch
- Available on both per-light and room-level color pickers

### Nickname System
- Backend: `/api/nicknames` GET/POST, stored in `config.json` under `nicknames` key
- Device keys: `hue:{id}` or `govee:{ip}`
- Frontend: Shows nickname (bold, larger) above friendly name (smaller, muted). "Add nickname" button when unset.

## Key Learnings & Gotchas

1. **Govee UDP port binding**: Only one socket can bind to port 4002 at a time. State queries MUST be sequential.
2. **Govee fire-and-forget**: Control commands rarely return responses. Don't await them.
3. **Hue color accuracy**: Use CIE `xy` → RGB via Wide RGB D65 matrix. Hue/sat fallback is less accurate.
4. **Optimistic UI is essential**: The original loadAll-after-every-control caused 90-second blocking delays.
5. **Razer protocol timeout**: 1-minute auto-disable if no LED data packet sent. Need keepalive for sustained use.
6. **Innr firmware**: Cannot be updated via Hue Bridge. Would need Innr Bridge.
7. **config.json is gitignored**: Contains local IPs, Hue username, Govee API key, room assignments.
8. **Govee API key**: `7cbbb09f-ab2e-4287-a441-a7be6490a173` (Dan's key — do NOT commit to repo)

## User Preferences

- Commits directly to `main` (no PRs)
- Prefers PowerShell
- Prefers single-step instructions (not multi-step with what-ifs)
- Windows 11 Pro, Ryzen 5950x, 32GB RAM
- Server runs from `C:\repos\lightemup\backend` with local venv

## Pending / Next Steps

- [ ] ptReal BLE-over-LAN testing on H7065/H7066 outdoor spots (test script ready)
- [ ] Test Razer protocol on H70C1 Christmas Lights and H61D3 Neon Rope
- [ ] Build segment control UI for H6061 Hexa Panels (Razer protocol confirmed working)
- [ ] Integrate segment control into the app for supported devices
- [ ] Android APK (WebView wrapper)
- [ ] Investigate Govee Cloud Platform API v2 as fallback for segment control on non-Razer devices
