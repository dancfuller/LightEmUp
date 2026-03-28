"""
LightEmUp - FastAPI backend for controlling Hue and Govee lights.
"""

import asyncio
import json
import os
import sys
import subprocess
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
    GOVEE_SEGMENT_INFO,
)
from scenes import scene_manager, LightningSettings

# ─── Config ──────────────────────────────────────────────────────────────────

CONFIG_PATH = Path("config.json")
DEFAULT_CONFIG = {
    "hue_bridge_ip": None,
    "hue_username": None,
    "govee_api_key": None,
    "rooms": {},
    "nicknames": {},
    "room_layouts": {},
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

    success = await set_hue_light_state(ip, username, req.light_id, state)
    return {"success": success}


# ─── Govee Control Endpoints ────────────────────────────────────────────────

@app.post("/api/govee/control")
async def control_govee(req: GoveeCommandRequest):
    results = {}

    if req.on is not None:
        results["turn"] = await govee_lan_turn(req.ip, req.on)

    if req.brightness is not None:
        results["brightness"] = await govee_lan_brightness(req.ip, req.brightness)

    if req.r is not None and req.g is not None and req.b is not None:
        results["color"] = await govee_lan_color(req.ip, req.r, req.g, req.b)

    if req.color_temp_kelvin is not None:
        results["color_temp"] = await govee_lan_color_temp(req.ip, req.color_temp_kelvin)

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
    }


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
    """Restart the LightEmUp server by spawning a new process and exiting."""
    async def _do_restart():
        await asyncio.sleep(0.5)
        subprocess.Popen(
            [sys.executable, os.path.abspath(__file__)],
            cwd=os.path.dirname(os.path.abspath(__file__)),
            creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
        )
        await asyncio.sleep(0.3)
        if _server_ref:
            _server_ref.should_exit = True
        else:
            os._exit(0)
    asyncio.create_task(_do_restart())
    return {"success": True, "message": "Server restarting..."}


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
