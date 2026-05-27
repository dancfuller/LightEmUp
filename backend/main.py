"""
LightEmUp - FastAPI backend for controlling Hue and Govee lights.
"""

import asyncio
import json
import logging
import os
import sys
import subprocess
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from typing import Optional

from discovery import (
    discover_hue_bridge,
    pair_hue_bridge,
    get_hue_lights,
    get_hue_groups,
    set_hue_light_state,
    discover_govee_lan,
    govee_lan_turn,
    govee_lan_brightness,
    govee_lan_color,
    govee_lan_color_temp,
    govee_lan_get_state,
    govee_cloud_get_devices,
    govee_get_segment_info,
    govee_v2_segment_color,
    govee_v2_segment_brightness,
    govee_razer_enable,
    govee_razer_set_segments,
    GOVEE_SEGMENT_INFO,
)
from scenes import scene_manager, LightningSettings
from razer_keeper import razer_keeper
import segment_state

# ─── Config ──────────────────────────────────────────────────────────────────

CONFIG_PATH = Path("config.json")
DEFAULT_CONFIG = {
    "hue_bridge_ip": None,
    "hue_username": None,
    "govee_api_key": None,
    "rooms": {},
    "nicknames": {},
    "room_layouts": {},
    "fixtures": {},  # fixture_id → { name, members: [device_key, ...] }
    "device_modes": {},  # device_key → "whole" | "segments" (LightCard preference)
}


def load_config() -> dict:
    if CONFIG_PATH.exists():
        with open(CONFIG_PATH) as f:
            return json.load(f)
    return DEFAULT_CONFIG.copy()


def save_config(config: dict):
    with open(CONFIG_PATH, "w") as f:
        json.dump(config, f, indent=2)


config = load_config()


# ─── Logging ────────────────────────────────────────────────────────────────
# Hourly rotating log file kept for 48 hours. Console output is preserved so
# `journalctl -u lightemup` still works under systemd. /api/logs serves the
# concatenated tail of these files to the web UI.

LOG_DIR = Path(__file__).parent / "logs"
LOG_DIR.mkdir(exist_ok=True)
LOG_FILE = LOG_DIR / "server.log"

_log_formatter = logging.Formatter(
    "%(asctime)s %(levelname)-7s %(name)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
_root_logger = logging.getLogger()
_root_logger.setLevel(logging.INFO)
if not any(isinstance(h, TimedRotatingFileHandler) for h in _root_logger.handlers):
    _fh = TimedRotatingFileHandler(LOG_FILE, when="H", interval=1, backupCount=48, encoding="utf-8")
    _fh.setFormatter(_log_formatter)
    _root_logger.addHandler(_fh)
if not any(isinstance(h, logging.StreamHandler) and not isinstance(h, TimedRotatingFileHandler)
           for h in _root_logger.handlers):
    _ch = logging.StreamHandler()
    _ch.setFormatter(_log_formatter)
    _root_logger.addHandler(_ch)

log = logging.getLogger("lightemup.main")


# ─── App ─────────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    print("🔆 LightEmUp starting up...")
    yield
    print("🔆 LightEmUp shutting down...")


app = FastAPI(title="LightEmUp", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── Pydantic Models ────────────────────────────────────────────────────────

class HuePairRequest(BaseModel):
    ip: str

class HueLightStateRequest(BaseModel):
    light_id: str
    on: Optional[bool] = None
    brightness: Optional[int] = None  # 1-254
    hue: Optional[int] = None  # 0-65535
    saturation: Optional[int] = None  # 0-254
    color_temp: Optional[int] = None  # 153-500 (mirek)
    r: Optional[int] = None  # 0-255, requires g and b
    g: Optional[int] = None
    b: Optional[int] = None

class GoveeCommandRequest(BaseModel):
    ip: str
    on: Optional[bool] = None
    brightness: Optional[int] = None  # 0-100
    r: Optional[int] = None
    g: Optional[int] = None
    b: Optional[int] = None
    color_temp_kelvin: Optional[int] = None

class RoomConfig(BaseModel):
    name: str
    hue_light_ids: list[str] = []
    govee_devices: list[str] = []  # list of IPs

class RoomStateRequest(BaseModel):
    room_name: str
    on: Optional[bool] = None
    brightness: Optional[int] = None
    r: Optional[int] = None
    g: Optional[int] = None
    b: Optional[int] = None

class LightningStartRequest(BaseModel):
    room_name: str

class LightningStopRequest(BaseModel):
    room_name: str

class LightningSettingsRequest(BaseModel):
    room_name: str
    color_temp_kelvin: Optional[int] = None
    use_color_temp: Optional[bool] = None
    color_r: Optional[int] = None
    color_g: Optional[int] = None
    color_b: Optional[int] = None
    background_brightness: Optional[int] = None
    background_color_temp_k: Optional[int] = None
    min_gap_ms: Optional[int] = None
    max_gap_ms: Optional[int] = None
    flash_duration_min_ms: Optional[int] = None
    flash_duration_max_ms: Optional[int] = None
    burst_count_min: Optional[int] = None
    burst_count_max: Optional[int] = None
    inter_burst_gap_ms: Optional[int] = None
    govee_flash: Optional[bool] = None
    storm_start_delay_s: Optional[int] = None
    thunder_enabled: Optional[bool] = None
    thunder_immediate: Optional[bool] = None
    thunder_funny: Optional[bool] = None

class GoveeSegmentModeRequest(BaseModel):
    room_name: str
    ip: str
    enabled: bool

class RoomLayoutRequest(BaseModel):
    room_name: str
    grid_size: int = 20
    mode: str = "2d"  # "2d" or "linear"
    boundary: dict = {}
    devices: dict = {}  # {"hue:1": {"x": 4, "y": 2}, ...}
    segments: dict = {}
    furniture: list = []  # [{id, type, label, x, y, w, h, rotation}, ...]
    landmarks: list = []  # [{x, label}, ...]


# ─── Discovery Endpoints ────────────────────────────────────────────────────

@app.get("/api/discover/hue")
async def discover_hue():
    """Discover Hue Bridges on the network."""
    bridges = await discover_hue_bridge()
    if bridges and not config.get("hue_bridge_ip"):
        config["hue_bridge_ip"] = bridges[0]["ip"]
        save_config(config)
    return {"bridges": bridges}


@app.post("/api/hue/pair")
async def pair_hue(req: HuePairRequest):
    """
    Pair with a Hue Bridge. Press the bridge button first, then call this.
    """
    try:
        username = await pair_hue_bridge(req.ip)
        if username:
            config["hue_bridge_ip"] = req.ip
            config["hue_username"] = username
            save_config(config)
            return {"success": True, "username": username}
        raise HTTPException(400, "Pairing failed - did you press the bridge button?")
    except Exception as e:
        raise HTTPException(400, str(e))


@app.get("/api/discover/govee")
async def discover_govee():
    """Discover Govee devices via LAN and fetch their current state."""
    devices = await discover_govee_lan()

    # Fetch state for each device sequentially (they all share port 4002)
    for dev in devices:
        try:
            state = await govee_lan_get_state(dev["ip"])
            if state:
                dev["state"] = {
                    "on": state.get("on", False),
                    "brightness": state.get("brightness", 0),
                    "color": state.get("color", {}),
                    "color_temp": state.get("color_temp", 0),
                    "reachable": True,
                }
            else:
                dev["state"] = {"on": False, "brightness": 0, "reachable": True}
        except Exception:
            dev["state"] = {"on": False, "brightness": 0, "reachable": False}

    return {"devices": devices}


@app.get("/api/discover/govee/cloud")
async def discover_govee_cloud():
    """Discover Govee devices via Cloud API (fallback)."""
    api_key = config.get("govee_api_key")
    if not api_key:
        raise HTTPException(400, "No Govee API key configured")
    devices = await govee_cloud_get_devices(api_key)
    return {"devices": devices}


@app.get("/api/discover/all")
async def discover_all():
    """Run full discovery for all device types."""
    hue_bridges = await discover_hue_bridge()
    govee_devices = await discover_govee_lan()

    hue_lights = []
    hue_groups = []
    ip = config.get("hue_bridge_ip") or (hue_bridges[0]["ip"] if hue_bridges else None)
    username = config.get("hue_username")

    if ip and username:
        hue_lights = await get_hue_lights(ip, username)
        hue_groups = await get_hue_groups(ip, username)

    return {
        "hue": {
            "bridges": hue_bridges,
            "lights": hue_lights,
            "groups": hue_groups,
            "paired": bool(username),
        },
        "govee": {
            "devices": govee_devices,
        },
    }


# ─── Hue Control Endpoints ──────────────────────────────────────────────────

@app.get("/api/hue/lights")
async def hue_lights():
    ip = config.get("hue_bridge_ip")
    username = config.get("hue_username")
    if not ip or not username:
        raise HTTPException(400, "Hue Bridge not paired")
    lights = await get_hue_lights(ip, username)
    return {"lights": lights}


@app.get("/api/hue/groups")
async def hue_groups():
    ip = config.get("hue_bridge_ip")
    username = config.get("hue_username")
    if not ip or not username:
        raise HTTPException(400, "Hue Bridge not paired")
    groups = await get_hue_groups(ip, username)
    return {"groups": groups}


@app.post("/api/hue/light")
async def control_hue_light(req: HueLightStateRequest):
    ip = config.get("hue_bridge_ip")
    username = config.get("hue_username")
    if not ip or not username:
        raise HTTPException(400, "Hue Bridge not paired")

    state = {}
    if req.on is not None:
        state["on"] = req.on
    if req.brightness is not None:
        state["bri"] = max(1, min(254, req.brightness))
    if req.hue is not None:
        state["hue"] = req.hue
    if req.saturation is not None:
        state["sat"] = req.saturation
    if req.color_temp is not None:
        state["ct"] = req.color_temp

    # RGB → Hue xy color space (wide gamut D65)
    if req.r is not None and req.g is not None and req.b is not None:
        # Gamma correction and wide RGB conversion
        def gamma(v):
            v = v / 255.0
            return pow(v, 2.2) if v > 0.04045 else v / 12.92
        rr, gg, bb = gamma(req.r), gamma(req.g), gamma(req.b)
        X = rr * 0.664511 + gg * 0.154324 + bb * 0.162028
        Y = rr * 0.283881 + gg * 0.668433 + bb * 0.047685
        Z = rr * 0.000088 + gg * 0.072310 + bb * 0.986039
        total = X + Y + Z
        if total > 0:
            state["xy"] = [round(X / total, 4), round(Y / total, 4)]
        else:
            state["xy"] = [0.3127, 0.3290]  # D65 white
        # Only derive brightness from color luminance if no explicit brightness was sent
        if req.brightness is None:
            state["bri"] = max(1, min(254, int(Y * 254)))

    success = await set_hue_light_state(ip, username, req.light_id, state)
    return {"success": success}


# ─── Govee Control Endpoints ────────────────────────────────────────────────

@app.post("/api/govee/control")
async def control_govee(req: GoveeCommandRequest):
    # Whole-device command on this IP overrides any razer segment state we
    # were keeping refreshed — cancel before sending so a stale refresh
    # doesn't fight the user's new command 45s from now. Also clear the
    # last-known segment colors so the UI stops showing the stale strip.
    razer_keeper.cancel(req.ip)
    if req.r is not None or req.color_temp_kelvin is not None or req.on is False:
        segment_state.clear(req.ip)
    results = {}

    if req.on is not None:
        results["turn"] = await govee_lan_turn(req.ip, req.on)

    if req.r is not None and req.g is not None and req.b is not None:
        results["color"] = await govee_lan_color(req.ip, req.r, req.g, req.b)

    if req.color_temp_kelvin is not None:
        results["color_temp"] = await govee_lan_color_temp(req.ip, req.color_temp_kelvin)

    # Send brightness after color — some Govee devices reset brightness on color change
    if req.brightness is not None:
        results["brightness"] = await govee_lan_brightness(req.ip, req.brightness)

    return {"results": results}


# ─── Room Endpoints ─────────────────────────────────────────────────────────

@app.get("/api/rooms")
async def get_rooms():
    return {"rooms": config.get("rooms", {})}


@app.post("/api/rooms")
async def update_room(room: RoomConfig):
    if "rooms" not in config:
        config["rooms"] = {}
    config["rooms"][room.name] = {
        "hue_light_ids": room.hue_light_ids,
        "govee_devices": room.govee_devices,
    }
    save_config(config)
    return {"success": True}


@app.post("/api/rooms/control")
async def control_room(req: RoomStateRequest):
    """Control all lights in a room at once."""
    rooms = config.get("rooms", {})
    room = rooms.get(req.room_name)
    if not room:
        raise HTTPException(404, f"Room '{req.room_name}' not found")

    ip = config.get("hue_bridge_ip")
    username = config.get("hue_username")
    results = {"hue": [], "govee": []}

    # Control Hue lights in the room
    if ip and username:
        for light_id in room.get("hue_light_ids", []):
            state = {}
            if req.on is not None:
                state["on"] = req.on
            if req.brightness is not None:
                state["bri"] = max(1, min(254, int(req.brightness * 254 / 100)))
            if req.r is not None and req.g is not None and req.b is not None:
                # Convert RGB to Hue's hue/sat (simplified)
                h, s = _rgb_to_hue_sat(req.r, req.g, req.b)
                state["hue"] = h
                state["sat"] = s
            success = await set_hue_light_state(ip, username, light_id, state)
            results["hue"].append({"light_id": light_id, "success": success})

    # Control Govee devices in the room
    for device_ip in room.get("govee_devices", []):
        razer_keeper.cancel(device_ip)
        if req.r is not None or req.on is False:
            segment_state.clear(device_ip)
        if req.on is not None:
            await govee_lan_turn(device_ip, req.on)
        if req.brightness is not None:
            await govee_lan_brightness(device_ip, req.brightness)
        if req.r is not None and req.g is not None and req.b is not None:
            await govee_lan_color(device_ip, req.r, req.g, req.b)
        results["govee"].append({"ip": device_ip, "success": True})

    return {"results": results}


def _rgb_to_hue_sat(r: int, g: int, b: int) -> tuple[int, int]:
    """Convert RGB (0-255) to Hue's hue (0-65535) and saturation (0-254)."""
    r_norm, g_norm, b_norm = r / 255.0, g / 255.0, b / 255.0
    max_c = max(r_norm, g_norm, b_norm)
    min_c = min(r_norm, g_norm, b_norm)
    diff = max_c - min_c

    if diff == 0:
        hue = 0
    elif max_c == r_norm:
        hue = (60 * ((g_norm - b_norm) / diff) + 360) % 360
    elif max_c == g_norm:
        hue = (60 * ((b_norm - r_norm) / diff) + 120) % 360
    else:
        hue = (60 * ((r_norm - g_norm) / diff) + 240) % 360

    sat = 0 if max_c == 0 else diff / max_c

    return int(hue / 360 * 65535), int(sat * 254)


# ─── Lightning Scene Endpoints ─────────────────────────────────────────────

@app.post("/api/scenes/lightning/start")
async def start_lightning(req: LightningStartRequest):
    """Start lightning scene for a room."""
    rooms = config.get("rooms", {})
    room = rooms.get(req.room_name)
    if not room:
        raise HTTPException(404, f"Room '{req.room_name}' not found")

    if scene_manager.is_active(req.room_name):
        raise HTTPException(409, f"Lightning already active for '{req.room_name}'")

    # Load saved settings or use defaults.
    saved = config.get("lightning_scenes", {}).get(req.room_name, {})
    settings = LightningSettings(**saved) if saved else LightningSettings()

    # Build room_config with segment info.
    room_config = dict(room)
    govee_segments = {}
    segment_mode = config.get("govee_segment_mode", {})
    segment_counts = config.get("govee_segment_counts", {})
    for ip in room.get("govee_devices", []):
        if segment_mode.get(ip):
            count = segment_counts.get(ip, 0)
            if count > 0:
                govee_segments[ip] = count
    room_config["govee_segments"] = govee_segments
    room_config["fixtures"] = config.get("fixtures", {})

    hue_ip = config.get("hue_bridge_ip")
    hue_username = config.get("hue_username")

    success = await scene_manager.start_lightning(
        req.room_name, room_config, hue_ip, hue_username, settings
    )
    return {"success": success}


@app.post("/api/scenes/lightning/stop")
async def stop_lightning(req: LightningStopRequest):
    """Stop lightning scene for a room, restore prior state."""
    await scene_manager.stop_lightning(req.room_name)
    return {"success": True}


@app.get("/api/scenes/lightning/status")
async def lightning_status():
    """Get list of rooms with active lightning scenes."""
    return {"active": scene_manager.get_active_rooms()}


@app.get("/api/scenes/lightning/settings/{room_name}")
async def get_lightning_settings(room_name: str):
    """Get saved lightning settings for a room."""
    saved = config.get("lightning_scenes", {}).get(room_name, {})
    settings = LightningSettings(**saved) if saved else LightningSettings()
    return settings.model_dump()


@app.post("/api/scenes/lightning/settings")
async def save_lightning_settings(req: LightningSettingsRequest):
    """Save lightning settings for a room."""
    if "lightning_scenes" not in config:
        config["lightning_scenes"] = {}

    # Merge with existing settings (only overwrite provided fields).
    existing = config["lightning_scenes"].get(req.room_name, {})
    updates = req.model_dump(exclude={"room_name"}, exclude_none=True)
    existing.update(updates)
    config["lightning_scenes"][req.room_name] = existing
    save_config(config)
    return {"success": True, "settings": existing}


@app.get("/api/scenes/lightning/events/{room_name}")
async def lightning_events(room_name: str):
    """SSE stream of flash events for thunder sound sync."""
    async def event_stream():
        queue = scene_manager.subscribe_flashes(room_name)
        try:
            while True:
                data = await queue.get()
                yield f"data: {json.dumps(data)}\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            scene_manager.unsubscribe_flashes(room_name, queue)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/govee/segment-mode")
async def set_govee_segment_mode(req: GoveeSegmentModeRequest):
    """Toggle per-segment mode for a Govee device in a room."""
    if "govee_segment_mode" not in config:
        config["govee_segment_mode"] = {}
    config["govee_segment_mode"][req.ip] = req.enabled

    # If enabling, try to look up segment count from SKU table if not already stored.
    if req.enabled and req.ip not in config.get("govee_segment_counts", {}):
        # Try to find the SKU for this IP from discovered devices.
        # The caller should supply the count separately, but we can try the SKU table.
        pass  # Count must be set via /api/govee/segment-count

    save_config(config)
    return {"success": True, "segment_mode": req.enabled}


class GoveeSegmentCountRequest(BaseModel):
    ip: str
    count: int

@app.post("/api/govee/segment-count")
async def set_govee_segment_count(req: GoveeSegmentCountRequest):
    """Manually set segment count for a Govee device."""
    if "govee_segment_counts" not in config:
        config["govee_segment_counts"] = {}
    config["govee_segment_counts"][req.ip] = req.count
    save_config(config)
    return {"success": True}


@app.get("/api/govee/segment-info")
async def get_segment_info():
    """Get segment info for all known SKUs and configured devices."""
    return {
        "sku_table": GOVEE_SEGMENT_INFO,
        "configured_counts": config.get("govee_segment_counts", {}),
        "segment_mode": config.get("govee_segment_mode", {}),
    }


class GoveeSegmentControlRequest(BaseModel):
    ip: str
    sku: str
    device_mac: str
    segment_idx: int
    r: Optional[int] = None
    g: Optional[int] = None
    b: Optional[int] = None
    brightness: Optional[int] = None


@app.post("/api/govee/segment-control")
async def control_govee_segment(req: GoveeSegmentControlRequest):
    """Control a single segment on a Govee device. Routes by protocol:
    cloud_v2 → V2 Platform API per-segment. razer → patch the segment in
    server-side state and re-send the full bulk packet (the razer protocol
    only accepts all segments at once)."""
    seg_info = GOVEE_SEGMENT_INFO.get(req.sku)
    if not seg_info:
        raise HTTPException(400, f"Unknown SKU {req.sku}")
    proto = seg_info.get("protocol")

    if proto == "razer":
        if req.r is None or req.g is None or req.b is None:
            raise HTTPException(400, "razer segment-control needs r,g,b")
        count = seg_info.get("count") or 0
        if count <= 0:
            raise HTTPException(400, f"razer SKU {req.sku} has no known segment count")
        if not (0 <= req.segment_idx < count):
            raise HTTPException(400, f"segment_idx out of range (0..{count-1})")
        existing = segment_state.get(req.ip)
        current_colors = list(existing["colors"].values()) if existing else []
        # Build full list at full brightness from current state, then patch.
        ordered = []
        for i in range(count):
            c = (existing["colors"].get(i) if existing else None) or (0, 0, 0)
            ordered.append(c)
        ordered[req.segment_idx] = (
            max(0, min(255, req.r)), max(0, min(255, req.g)), max(0, min(255, req.b))
        )
        brightness = existing["brightness"] if existing else 100
        scaled = _scale_colors(ordered, brightness)
        await govee_razer_enable(req.ip)
        await govee_razer_set_segments(req.ip, scaled)
        await razer_keeper.apply(req.ip, req.sku, scaled)
        segment_state.set_bulk(req.ip, ordered, brightness)
        return {"results": {"color": True}, "protocol": "razer"}

    if proto != "cloud_v2":
        raise HTTPException(400, f"SKU {req.sku} does not support per-segment control")

    api_key = config.get("govee_api_key")
    if not api_key:
        raise HTTPException(400, "No Govee API key configured")

    results = {}
    if req.r is not None and req.g is not None and req.b is not None:
        results["color"] = await govee_v2_segment_color(
            api_key, req.sku, req.device_mac, req.segment_idx, req.r, req.g, req.b
        )
        segment_state.set_one(req.ip, req.segment_idx, req.r, req.g, req.b)
    if req.brightness is not None:
        # Rate limit: wait before second call
        if results:
            await asyncio.sleep(1.0)
        results["brightness"] = await govee_v2_segment_brightness(
            api_key, req.sku, req.device_mac, req.segment_idx, req.brightness
        )
    return {"results": results, "protocol": "cloud_v2"}


# ─── Razer-protocol bulk segment apply (LAN) ────────────────────────────────
# H6061 ("Glide Hexa") and other razer-protocol Govee devices can't take
# per-segment commands — the wire protocol carries the full N-segment color
# array in a single packet. This endpoint takes one bulk request, enables
# razer mode (required after any V1 whole-device command), and sends the
# packed colors. Cloud V2 devices keep using /api/govee/segment-control.

class GoveeSegmentsBulkRequest(BaseModel):
    ip: str
    sku: str
    colors: list[list[int]]  # [[r,g,b], ...] at full brightness (100%), one per segment
    brightness: Optional[int] = 100  # device-level multiplier 0..100


def _scale_colors(colors: list[tuple[int, int, int]], brightness: int) -> list[tuple[int, int, int]]:
    f = max(0, min(100, brightness)) / 100.0
    return [(int(c[0] * f), int(c[1] * f), int(c[2] * f)) for c in colors]


@app.post("/api/govee/segments-bulk")
async def control_govee_segments_bulk(req: GoveeSegmentsBulkRequest):
    seg_info = GOVEE_SEGMENT_INFO.get(req.sku)
    if not seg_info or seg_info.get("protocol") != "razer":
        raise HTTPException(400, f"SKU {req.sku} is not a razer-protocol segmented device")
    expected = seg_info.get("count")
    if expected and len(req.colors) != expected:
        raise HTTPException(400, f"Expected {expected} segments, got {len(req.colors)}")
    colors_tuples = [(max(0, min(255, c[0])), max(0, min(255, c[1])), max(0, min(255, c[2])))
                     for c in req.colors]
    brightness = max(0, min(100, req.brightness if req.brightness is not None else 100))
    scaled = _scale_colors(colors_tuples, brightness)
    await govee_razer_enable(req.ip)
    await govee_razer_set_segments(req.ip, scaled)
    # Keep the SCALED state alive — razer mode auto-disables after ~60s of
    # no LED data, so we re-send the same packet every 45s until the user
    # issues a whole-device command or starts a scene.
    await razer_keeper.apply(req.ip, req.sku, scaled)
    # Store unscaled colors + brightness separately so a later brightness
    # change can re-scale without losing the per-segment palette.
    segment_state.set_bulk(req.ip, colors_tuples, brightness)
    return {"success": True}


class GoveeSegmentsBrightnessRequest(BaseModel):
    ip: str
    sku: str
    brightness: int
    device_mac: Optional[str] = None  # required for cloud_v2 devices


@app.post("/api/govee/segments-brightness")
async def control_govee_segments_brightness(req: GoveeSegmentsBrightnessRequest):
    """Change the device-level brightness of a segmented Govee device
    without losing the per-segment colors. Razer devices get a re-sent
    bulk packet with scaled colors. Cloud_v2 devices receive per-segment
    brightness commands."""
    entry = segment_state.get(req.ip)
    if not entry:
        raise HTTPException(400, "No segment state for this device")
    seg_info = GOVEE_SEGMENT_INFO.get(req.sku)
    if not seg_info:
        raise HTTPException(400, f"Unknown SKU {req.sku}")
    brightness = max(0, min(100, req.brightness))
    proto = seg_info.get("protocol")
    count = seg_info.get("count") or (max(entry["colors"].keys()) + 1 if entry["colors"] else 0)

    if proto == "razer":
        ordered = []
        for i in range(count):
            c = entry["colors"].get(i) or (0, 0, 0)
            ordered.append(c)
        scaled = _scale_colors(ordered, brightness)
        await govee_razer_enable(req.ip)
        await govee_razer_set_segments(req.ip, scaled)
        await razer_keeper.apply(req.ip, req.sku, scaled)
    elif proto == "cloud_v2":
        api_key = config.get("govee_api_key")
        if not api_key:
            raise HTTPException(400, "No Govee API key configured")
        if not req.device_mac:
            raise HTTPException(400, "device_mac required for cloud_v2 devices")
        # Cloud V2 brightness is per-segment. Send each (staggered slightly
        # — burst-bucket limited).
        for i in range(count):
            if i in entry["colors"]:
                await govee_v2_segment_brightness(api_key, req.sku, req.device_mac, i, brightness)
                await asyncio.sleep(1.5)
    else:
        raise HTTPException(400, f"SKU {req.sku} does not support segmented control")

    segment_state.set_brightness(req.ip, brightness)
    return {"success": True, "brightness": brightness}


@app.get("/api/govee/segment-state")
async def get_segment_state():
    """Return the last-known per-segment colors + brightness for every
    Govee device the server has set segments on."""
    return {"state": segment_state.snapshot()}


# ─── Config Endpoint ────────────────────────────────────────────────────────

@app.get("/api/config")
async def get_config():
    return {
        "hue_bridge_ip": config.get("hue_bridge_ip"),
        "hue_paired": bool(config.get("hue_username")),
        "govee_api_key_set": bool(config.get("govee_api_key")),
        "rooms": config.get("rooms", {}),
        "nicknames": config.get("nicknames", {}),
        "room_layouts": config.get("room_layouts", {}),
        "fixtures": config.get("fixtures", {}),
    }


# ─── Fixture Endpoints ──────────────────────────────────────────────────────
# A fixture groups multiple electronically-separate lights that share one
# physical housing (e.g. a triple-bulb sconce). The color-mode adjacency
# graph treats fixture-mates as mutually adjacent so they never share a
# color in palette/gradient/tonal scenes. Each device key may belong to at
# most one fixture; assigning a member to a new fixture removes it from any
# prior one.

class FixtureUpsertRequest(BaseModel):
    fixture_id: str
    name: str
    members: list[str]  # device keys, e.g. "hue:3" or "govee:192.168.1.5"


@app.get("/api/fixtures")
async def get_fixtures():
    return {"fixtures": config.get("fixtures", {})}


@app.post("/api/fixtures")
async def upsert_fixture(req: FixtureUpsertRequest):
    if "fixtures" not in config:
        config["fixtures"] = {}
    fixtures = config["fixtures"]
    incoming = set(req.members)
    # Strip incoming members out of any other fixture (one-fixture-per-device).
    for fid in list(fixtures.keys()):
        if fid == req.fixture_id:
            continue
        kept = [m for m in fixtures[fid].get("members", []) if m not in incoming]
        if not kept:
            del fixtures[fid]
        elif len(kept) != len(fixtures[fid].get("members", [])):
            fixtures[fid]["members"] = kept
    fixtures[req.fixture_id] = {"name": req.name, "members": req.members}
    save_config(config)
    return {"success": True, "fixtures": fixtures}


@app.delete("/api/fixtures/{fixture_id}")
async def delete_fixture(fixture_id: str):
    fixtures = config.get("fixtures", {})
    if fixture_id in fixtures:
        del fixtures[fixture_id]
        save_config(config)
    return {"success": True}


# ─── Nickname Endpoints ─────────────────────────────────────────────────────

class NicknameRequest(BaseModel):
    device_key: str  # e.g. "govee:192.168.0.141" or "hue:3"
    nickname: str

@app.post("/api/nicknames")
async def set_nickname(req: NicknameRequest):
    if "nicknames" not in config:
        config["nicknames"] = {}
    config["nicknames"][req.device_key] = req.nickname
    save_config(config)
    return {"success": True}

@app.get("/api/nicknames")
async def get_nicknames():
    return {"nicknames": config.get("nicknames", {})}


# ─── Device Mode Endpoints ─────────────────────────────────────────────────
# Per-device LightCard preference: "whole" (single color) or "segments"
# (per-panel control). Persisted in config.json so the toggle remembers
# what the user picked.

class DeviceModeRequest(BaseModel):
    device_key: str
    mode: str  # "whole" | "segments"


class DeviceModesBulkRequest(BaseModel):
    modes: dict  # { device_key: mode, ... }


@app.post("/api/device-modes")
async def set_device_mode(req: DeviceModeRequest):
    if req.mode not in ("whole", "segments"):
        raise HTTPException(400, "mode must be 'whole' or 'segments'")
    if "device_modes" not in config:
        config["device_modes"] = {}
    config["device_modes"][req.device_key] = req.mode
    save_config(config)
    return {"success": True}


@app.post("/api/device-modes/bulk")
async def set_device_modes_bulk(req: DeviceModesBulkRequest):
    if "device_modes" not in config:
        config["device_modes"] = {}
    for k, v in req.modes.items():
        if v in ("whole", "segments"):
            config["device_modes"][k] = v
    save_config(config)
    return {"success": True, "device_modes": config["device_modes"]}


# ─── Room Layout Endpoints ──────────────────────────────────────────────────

@app.get("/api/room-layouts/{room_name}")
async def get_room_layout(room_name: str):
    layouts = config.get("room_layouts", {})
    layout = layouts.get(room_name)
    if not layout:
        raise HTTPException(404, f"No layout for '{room_name}'")
    return layout


@app.post("/api/room-layouts")
async def save_room_layout(req: RoomLayoutRequest):
    if "room_layouts" not in config:
        config["room_layouts"] = {}
    config["room_layouts"][req.room_name] = {
        "grid_size": req.grid_size,
        "mode": req.mode,
        "boundary": req.boundary,
        "devices": req.devices,
        "segments": req.segments,
        "furniture": req.furniture,
        "landmarks": req.landmarks,
    }
    save_config(config)
    return {"success": True}


@app.delete("/api/room-layouts/{room_name}")
async def delete_room_layout(room_name: str):
    layouts = config.get("room_layouts", {})
    if room_name in layouts:
        del layouts[room_name]
        save_config(config)
    return {"success": True}


# ─── Room Scene Preset Endpoints ───────────────────────────────────────────

class RoomPresetsRequest(BaseModel):
    room_name: str
    presets: list  # list of {name, snapshot, created}


@app.get("/api/room-presets/{room_name}")
async def get_room_presets(room_name: str):
    presets = config.get("room_presets", {}).get(room_name, [])
    return {"presets": presets}


@app.post("/api/room-presets")
async def save_room_presets(req: RoomPresetsRequest):
    if "room_presets" not in config:
        config["room_presets"] = {}
    config["room_presets"][req.room_name] = req.presets
    save_config(config)
    return {"success": True}


# ─── Server Control Endpoints ────────────────────────────────────────────────

_server_ref = None  # Set by __main__ to allow clean shutdown


@app.post("/api/server/shutdown")
async def server_shutdown():
    """Shut down the LightEmUp server."""
    async def _do_shutdown():
        await asyncio.sleep(0.5)
        if _server_ref:
            _server_ref.should_exit = True
        else:
            os._exit(0)
    asyncio.create_task(_do_shutdown())
    return {"success": True, "message": "Server shutting down..."}


@app.post("/api/server/restart")
async def server_restart():
    """Restart the server. Under systemd we just exit cleanly and let the
    unit respawn us (requires Restart=always). Standalone we spawn a
    detached child before exiting — flags are platform-specific because
    subprocess.DETACHED_PROCESS only exists on Windows."""
    async def _do_restart():
        await asyncio.sleep(0.5)
        if not os.environ.get("INVOCATION_ID"):
            if sys.platform == "win32":
                subprocess.Popen(
                    [sys.executable, os.path.abspath(__file__)],
                    cwd=os.path.dirname(os.path.abspath(__file__)),
                    creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
                )
            else:
                subprocess.Popen(
                    [sys.executable, os.path.abspath(__file__)],
                    cwd=os.path.dirname(os.path.abspath(__file__)),
                    start_new_session=True,
                )
            await asyncio.sleep(0.3)
        if _server_ref:
            _server_ref.should_exit = True
        else:
            os._exit(0)
    asyncio.create_task(_do_restart())
    return {"success": True, "message": "Server restarting..."}


@app.get("/api/logs")
async def get_logs(lines: int = 500, level: Optional[str] = None):
    """Return the most recent log lines from the rotating file set.

    Reads all log files in chronological order (rotated backups + current),
    optionally filters by level (substring match on the level field), and
    returns the tail of *lines* entries — newest last.
    """
    if not LOG_DIR.exists():
        return {"lines": [], "available": 0}

    # Collect log files: current + rotated backups (named server.log.YYYY-...)
    files = sorted(LOG_DIR.glob("server.log*"), key=lambda p: p.stat().st_mtime)
    if not files:
        return {"lines": [], "available": 0}

    # Read everything (logs cap at ~48h of hourly files — small).
    all_lines: list[str] = []
    for f in files:
        try:
            with open(f, encoding="utf-8", errors="replace") as fh:
                all_lines.extend(fh.read().splitlines())
        except Exception as exc:
            log.warning("Failed to read log file %s: %s", f, exc)

    if level:
        wanted = level.upper()
        all_lines = [ln for ln in all_lines if f" {wanted}" in ln[:40]]

    tail = all_lines[-max(1, lines):]
    return {"lines": tail, "available": len(all_lines), "retention_hours": 48}


# ─── Static Files (frontend) ─────────────────────────────────────────────────

STATIC_DIR = Path(__file__).parent / "static"

@app.get("/")
async def serve_frontend():
    index = STATIC_DIR / "index.html"
    if index.exists():
        return FileResponse(str(index))
    return {"message": "Frontend not found. Place index.html in /static/"}

app.mount("/sounds", StaticFiles(directory=str(STATIC_DIR / "sounds")), name="sounds")
app.mount("/js", StaticFiles(directory=str(STATIC_DIR / "js")), name="js")


if __name__ == "__main__":
    import uvicorn
    uvi_config = uvicorn.Config(app, host="0.0.0.0", port=8420)
    server = uvicorn.Server(uvi_config)
    _server_ref = server
    server.run()
