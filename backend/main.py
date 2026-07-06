"""
LightEmUp - FastAPI backend for controlling Hue and Govee lights.
"""

import asyncio
import json
import logging
import math
import os
import sys
import subprocess
import time
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, StreamingResponse, HTMLResponse
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
    govee_v2_segments_color,
    govee_v2_segment_brightness,
    govee_razer_enable,
    govee_razer_set_segments,
    GOVEE_SEGMENT_INFO,
)
from scenes import scene_manager, LightningSettings
from razer_keeper import razer_keeper
from version import __version__ as APP_VERSION, GIT_HASH, GIT_DATE, version_string
import segment_state

# Module logger, defined early: config load + the one-time Govee MAC migration run
# at import (below), before the fuller handler setup further down — and both call
# `log`. getLogger is idempotent by name, so the handlers attached later flow
# through this same object. (Without this, migrate_govee_to_mac's log.warning
# raised NameError at import and crash-looped the service.)
log = logging.getLogger("lightemup.main")

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
    "segment_fill_modes": {},  # device_key → "follow" | "solid" | "shades"
                                # how the device's segments are filled by room scenes
    "known_devices": {  # devices we've seen before; surface as "missing" when absent
        "govee": {},    # keyed by MAC: { mac: { ip, sku, name, last_seen } }
    },
    "device_state": {},  # "govee:<ip>" → last state set via LightEmUp:
                          # { on, brightness, r, g, b, color_temp_kelvin, updated_at }
                          # Display-only: lets a second browser show accurate Govee
                          # status (Govee LAN devStatus reports color unreliably).
    "room_color_state": {},  # room name → last color-tool selection applied, so
                              # every scene MODE rehydrates a fresh UI (not just
                              # palette). See RoomColorStateRequest for the full
                              # field set (mode/palette/base_color + per-mode:
                              # custom_colors, custom_shade_mode, beacon_source_key,
                              # max_kelvin, ct_preset, selected_team/ncaa/flag, …).
    "segment_state": {},  # "govee:<ip>" → { colors: {idx:[r,g,b]}, brightness }
                           # config-backed mirror of segment_state.py for restart
                           # durability (in-memory module is the live source).
    "ct_correction": {},  # "govee:<ip>" → [{ in: requestedK, out: correctedK }, ...]
                           # Per-device white-balance calibration: Govee CT renders
                           # bluer than Hue, so we send a warmer corrected Kelvin to
                           # match a Hue reference. Interpolated in mired space.
    "ct_rgb": {},         # "govee:<ip>" → [{ in: requestedK, out: effectiveK }, ...]
                           # RGB-space white calibration. Govee's *native* CT can't go
                           # warm enough (still blue at its warmest), so instead of a
                           # CT command we send kelvin_to_rgb(out) as an RGB color —
                           # not bounded by the device's white LEDs. Takes precedence
                           # over ct_correction when present. Same {in,out} shape /
                           # mired interpolation; out is an *effective* warm Kelvin.
    "ui_prefs": {       # UI-only preferences shared across browsers
        "color_picker_style": "huebar",  # "huebar" | "wheel"
        "min_saturation_enabled": True,  # clamp generated colors to a floor
        "min_saturation_pct": 35,        # 0..100; saturation in HSL terms
    },
}


def _config_backups() -> list[Path]:
    """All backup files for config.json, newest first (rolling .bak + any manual
    .recovered-*.bak safety copies), so we can restore the freshest good one."""
    parent = CONFIG_PATH.parent
    baks = list(parent.glob(CONFIG_PATH.name + "*.bak"))
    return sorted(baks, key=lambda p: p.stat().st_mtime, reverse=True)


def load_config() -> dict:
    """Load config.json, tolerating a truncated/corrupt file.

    A power loss during save could leave config.json empty or half-written. In
    that case DON'T silently fall back to DEFAULT_CONFIG — that would wipe the
    user's rooms/nicknames the moment the next mutation persisted. Instead restore
    from the most recent valid backup; only use defaults if there is genuinely
    nothing to load (fresh install)."""
    if CONFIG_PATH.exists():
        try:
            with open(CONFIG_PATH) as f:
                return json.load(f)
        except (json.JSONDecodeError, ValueError, OSError):
            log.error("config.json is unreadable/corrupt (power loss?); trying backups")
    for bak in _config_backups():
        try:
            with open(bak) as f:
                data = json.load(f)
            log.warning("Restored config from backup %s", bak.name)
            return data
        except Exception:
            continue
    if CONFIG_PATH.exists():
        log.error("config.json corrupt and no valid backup found; using defaults")
    return DEFAULT_CONFIG.copy()


def save_config(config: dict):
    """Atomically persist config so a power loss can never truncate config.json.

    The old path opened the real file in "w" mode, which truncates it to zero
    *before* writing — a crash mid-write left an empty/corrupt config. Instead:
    write a temp file in the same directory, fsync it, keep the prior good file
    as a rolling .bak, then os.replace() (atomic rename) over config.json, and
    fsync the directory so the rename itself survives a power cut."""
    import tempfile, shutil
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp_fd, tmp_path = tempfile.mkstemp(
        dir=str(CONFIG_PATH.parent) or ".",
        prefix=CONFIG_PATH.name + ".", suffix=".tmp",
    )
    try:
        with os.fdopen(tmp_fd, "w") as f:
            json.dump(config, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        # Keep the last good file as a rolling backup before replacing it.
        if CONFIG_PATH.exists():
            try:
                shutil.copy2(CONFIG_PATH, CONFIG_PATH.parent / (CONFIG_PATH.name + ".bak"))
            except Exception:
                log.exception("Could not refresh config backup")
        os.replace(tmp_path, CONFIG_PATH)  # atomic on POSIX & Windows
        tmp_path = None
        # Durably commit the directory entry (the rename) too.
        try:
            dir_fd = os.open(str(CONFIG_PATH.parent) or ".", os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        except (OSError, AttributeError):
            pass  # unsupported on some platforms (e.g. Windows) — rename is still atomic
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass


# ─── Govee identity: MAC-keyed associations, IP resolved at send time ─────────
# Govee's LAN "device id" (stored as `mac`) is the stable identity; the IP is a
# DHCP lease that a router reboot can reassign. So every association (rooms,
# nicknames, layouts, segment config, calibration, last-known state) is keyed by a
# colon-free *slug* of the mac, and the current IP is resolved from
# known_devices.govee at send time. See backend/CLAUDE.md.

def gv_slug(mac: str) -> str:
    """Colon/dash-free lowercase device identity — safe as a JSON key / URL seg
    (no ':' to collide with key.split(':') or the seg regex)."""
    return (mac or "").replace(":", "").replace("-", "").lower()


def gv_key(mac: str) -> str:
    """Canonical prefixed association key, e.g. 'govee:2d3acc323233095a'."""
    return "govee:" + gv_slug(mac)


def _known_govee() -> dict:
    return config.get("known_devices", {}).get("govee", {})


def gv_mac_for_ip(ip: str):
    """Reverse-lookup a live IP to its stored mac via known_devices (or None)."""
    if not ip:
        return None
    for m, info in _known_govee().items():
        if info.get("ip") == ip:
            return m
    return None


def gv_key_for_ip(ip: str, mac: str = None) -> str:
    """Prefixed key for a device we're addressing by IP. Prefer an explicit mac;
    else reverse-lookup the IP; else fall back to the raw IP (unknown device)."""
    mac = mac or gv_mac_for_ip(ip)
    return gv_key(mac) if mac else f"govee:{ip}"


def gv_slug_for_ip(ip: str, mac: str = None) -> str:
    """Bare slug (no 'govee:' prefix) for a device addressed by IP — for the
    bare-keyed maps (room membership, segment mode/counts)."""
    mac = mac or gv_mac_for_ip(ip)
    return gv_slug(mac) if mac else ip


def gv_ip_for_slug(slug: str):
    """Current IP for a stored device slug (room membership / segment config).
    Resolves via known_devices; a slug that is itself an IP (legacy/unknown)
    resolves to itself. Returns None when unresolvable (device never seen)."""
    if not slug:
        return None
    for m, info in _known_govee().items():
        if gv_slug(m) == slug:
            return info.get("ip")
    return slug if slug.count(".") == 3 else None


def migrate_govee_to_mac(cfg: dict) -> bool:
    """One-time: re-key every Govee association from IP to the stable mac slug.

    Guarded by `schema_version` so it runs exactly once. Resolves each IP via
    known_devices.govee (mac→last-seen-IP); associations whose IP can't be
    resolved (device offline / IP changed at migration time) are dropped and
    logged — so power on all Govee lights + rescan before deploying. Returns True
    if it migrated (caller persists)."""
    if cfg.get("schema_version", 1) >= 2:
        return False

    known = cfg.get("known_devices", {}).get("govee", {})
    ip_to_slug = {info.get("ip"): gv_slug(m) for m, info in known.items() if info.get("ip")}
    dropped = set()

    # Safety: if we have no IP→mac map at all but the config clearly holds IP-keyed
    # Govee associations, migrating now would drop ALL of them. Defer (don't set
    # schema_version) so a later boot — after a scan repopulates known_devices —
    # migrates for real, instead of wiping the user's rooms/nicknames.
    has_assoc = any(r.get("govee_devices") for r in cfg.get("rooms", {}).values()) or \
        any(str(k).startswith("govee:") for k in cfg.get("nicknames", {}))
    if not ip_to_slug and has_assoc:
        log.warning("Govee MAC migration deferred: known_devices is empty but IP-keyed "
                    "associations exist. Run a Govee scan, then restart to migrate.")
        return False

    def slug_for_ip(ip):
        s = ip_to_slug.get(ip)
        if not s:
            dropped.add(ip)
        return s

    def rekey_prefixed(d):
        """Re-key a { 'govee:<ip>'|'hue:<id>': v } dict to mac slugs."""
        if not isinstance(d, dict):
            return d
        out = {}
        for k, v in d.items():
            if k.startswith("govee:"):
                s = slug_for_ip(k[len("govee:"):])
                if s:
                    out["govee:" + s] = v
            else:
                out[k] = v  # hue: keys untouched
        return out

    def rekey_member(k):
        if not isinstance(k, str) or not k.startswith("govee:"):
            return k
        s = slug_for_ip(k[len("govee:"):])
        return "govee:" + s if s else None

    # Back up the pre-migration file (belt-and-suspenders on top of the .bak the
    # atomic save keeps) so a bad migration is fully recoverable.
    try:
        if CONFIG_PATH.exists():
            import shutil
            shutil.copy2(CONFIG_PATH, CONFIG_PATH.parent / (CONFIG_PATH.name + ".pre-mac-migration.bak"))
    except Exception:
        log.exception("Could not write pre-migration backup")

    # 1) Prefixed 'govee:<ip>' dicts
    for key in ("nicknames", "device_state", "segment_state", "ct_correction",
                "ct_rgb", "device_modes", "segment_fill_modes"):
        if key in cfg:
            cfg[key] = rekey_prefixed(cfg[key])

    # 2) Bare-IP lists (room membership)
    for room in cfg.get("rooms", {}).values():
        gd = room.get("govee_devices")
        if isinstance(gd, list):
            room["govee_devices"] = [s for ip in gd for s in (slug_for_ip(ip),) if s]

    # 3) Bare-IP dicts (segment mode / counts)
    for key in ("govee_segment_mode", "govee_segment_counts"):
        d = cfg.get(key)
        if isinstance(d, dict):
            cfg[key] = {s: v for ip, v in d.items() for s in (slug_for_ip(ip),) if s}

    # 4) Room layouts: devices + segments are 'govee:<ip>'/'hue:<id>' keyed
    for layout in cfg.get("room_layouts", {}).values():
        for sub in ("devices", "segments"):
            if sub in layout:
                layout[sub] = rekey_prefixed(layout[sub])

    # 5) Fixtures: members is a list of device keys
    for fx in cfg.get("fixtures", {}).values():
        members = fx.get("members")
        if isinstance(members, list):
            fx["members"] = [m for k in members for m in (rekey_member(k),) if m]

    cfg["schema_version"] = 2
    if dropped:
        log.warning("Govee MAC migration: dropped %d unresolvable IP(s) (offline / "
                    "IP changed): %s", len(dropped), ", ".join(sorted(dropped)))
    log.warning("Govee MAC migration complete (schema_version=2)")
    return True


config = load_config()
if migrate_govee_to_mac(config):
    save_config(config)


# ─── Debounced config persistence ─────────────────────────────────────────────
# Device/room state can be written on every brightness drag or palette apply.
# Writing config.json synchronously on each would hammer the Pi's SD card, so
# coalesce rapid mutations into one disk write ~2s after the last change.

_SAVE_DEBOUNCE_S = 2.0
_save_handle: "asyncio.TimerHandle | None" = None
_save_pending = False


def _flush_save():
    global _save_handle, _save_pending
    _save_handle = None
    _save_pending = False
    try:
        save_config(config)
    except Exception:
        log.exception("Debounced config save failed")


def schedule_save():
    """Persist config soon, coalescing bursts. Falls back to an immediate
    synchronous save when no event loop is running (e.g. at import time)."""
    global _save_handle, _save_pending
    _save_pending = True
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        _flush_save()
        return
    if _save_handle is not None:
        _save_handle.cancel()
    _save_handle = loop.call_later(_SAVE_DEBOUNCE_S, _flush_save)


def flush_save_now():
    """Force any pending debounced save to disk immediately (shutdown hook)."""
    global _save_handle
    if _save_handle is not None:
        _save_handle.cancel()
        _save_handle = None
    if _save_pending:
        _flush_save()


def record_govee_state(ip: str, mac: str = None, **fields):
    """Record the last state set on a Govee device via LightEmUp so a second
    browser can render accurate status. Display-only — never issues commands.
    A whole-device color clears any prior color_temp_kelvin and vice-versa.
    Keyed by the stable mac slug (resolved from the IP when not passed)."""
    store = config.setdefault("device_state", {})
    key = gv_key_for_ip(ip, mac)
    entry = store.get(key, {})
    if fields.get("r") is not None:
        entry.pop("color_temp_kelvin", None)
    if fields.get("color_temp_kelvin") is not None:
        for k in ("r", "g", "b"):
            entry.pop(k, None)
    for k, v in fields.items():
        if v is not None:
            entry[k] = v
    entry["updated_at"] = _now_iso()
    store[key] = entry
    schedule_save()
    publish_event("govee", key=key)


def persist_segments():
    """Mirror the in-memory segment_state into config for restart durability.
    snapshot() is keyed by bare IP; config uses the "govee:<ip>" key form."""
    snap = segment_state.snapshot()
    config["segment_state"] = {gv_key_for_ip(ip): e for ip, e in snap.items()}
    schedule_save()
    publish_event("segments")


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def correct_kelvin(ip: str, kelvin: int) -> int:
    """Map a requested Kelvin to this device's calibrated output Kelvin.

    Govee LAN devices render the same Kelvin bluer than Hue; the calibration
    panel records {in, out} sample points (out is warmer/lower). We interpolate
    piecewise-linearly in mired space (1e6/K) — the same perceptual spacing the
    palette generator uses — and clamp outside the sampled range. Identity when
    the device has no calibration."""
    pts = config.get("ct_correction", {}).get(gv_key_for_ip(ip))
    if not pts or kelvin is None:
        return kelvin
    samples = sorted(
        ({"m_in": 1e6 / p["in"], "m_out": 1e6 / p["out"]} for p in pts if p.get("in") and p.get("out")),
        key=lambda s: s["m_in"],
    )
    if not samples:
        return kelvin
    m = 1e6 / kelvin
    if m <= samples[0]["m_in"]:
        return int(round(1e6 / samples[0]["m_out"]))
    if m >= samples[-1]["m_in"]:
        return int(round(1e6 / samples[-1]["m_out"]))
    for a, b in zip(samples, samples[1:]):
        if a["m_in"] <= m <= b["m_in"]:
            span = b["m_in"] - a["m_in"]
            f = 0 if span == 0 else (m - a["m_in"]) / span
            m_out = a["m_out"] + (b["m_out"] - a["m_out"]) * f
            return int(round(1e6 / m_out))
    return kelvin


def kelvin_to_rgb(kelvin: int):
    """Kelvin → approximate RGB (Tanner Helland). Mirror of utils.js kelvinToRGB
    so the device shows the same warm tint the UI previews."""
    t = max(1000, min(40000, kelvin)) / 100.0
    if t <= 66:
        r = 255.0
        g = 99.4708025861 * math.log(t) - 161.1195681661
        b = 0.0 if t <= 19 else 138.5177312231 * math.log(t - 10) - 305.0447927307
    else:
        r = 329.698727446 * ((t - 60) ** -0.1332047592)
        g = 288.1221695283 * ((t - 60) ** -0.0755148492)
        b = 255.0
    clamp = lambda v: max(0, min(255, int(round(v))))
    return clamp(r), clamp(g), clamp(b)


def ct_rgb_color(ip: str, kelvin):
    """If this device has an RGB-space white calibration, return the RGB tuple to
    send for a requested Kelvin (interpolated effective-K, then kelvin_to_rgb).
    Returns None when the device has no ct_rgb calibration — caller falls back to
    the native CT path. Same mired-space interpolation as correct_kelvin."""
    pts = config.get("ct_rgb", {}).get(gv_key_for_ip(ip))
    if not pts or kelvin is None:
        return None
    samples = sorted(
        ({"m_in": 1e6 / p["in"], "m_out": 1e6 / p["out"]} for p in pts if p.get("in") and p.get("out")),
        key=lambda s: s["m_in"],
    )
    if not samples:
        return None
    m = 1e6 / kelvin
    if m <= samples[0]["m_in"]:
        eff = 1e6 / samples[0]["m_out"]
    elif m >= samples[-1]["m_in"]:
        eff = 1e6 / samples[-1]["m_out"]
    else:
        eff = None
        for a, b in zip(samples, samples[1:]):
            if a["m_in"] <= m <= b["m_in"]:
                span = b["m_in"] - a["m_in"]
                f = 0 if span == 0 else (m - a["m_in"]) / span
                m_out = a["m_out"] + (b["m_out"] - a["m_out"]) * f
                eff = 1e6 / m_out
                break
        if eff is None:
            return None
    return kelvin_to_rgb(int(round(eff)))


# ─── Live-sync event bus ──────────────────────────────────────────────────────
# A global pub/sub so every open session stays in sync. Mutating endpoints
# publish a lightweight "what changed" signal; each client's EventSource (see
# /api/events) reacts by re-fetching the affected slice. We send the change
# kind plus the originating client id so a client can ignore its own echoes.

from contextvars import ContextVar

_event_subscribers: "list[asyncio.Queue]" = []
# Per-request client id (from the X-Client-Id header), so an event carries the
# id of the session that caused it and that session can ignore its own echo.
_current_client_id: ContextVar[str] = ContextVar("client_id", default="")
# Set inside a background scene-apply task to suppress the per-call device
# events it would otherwise emit on every step (one refresh is sent at the end).
# scene_apply progress events are exempt by type. Per-task ContextVar, so it
# never affects normal concurrent requests.
_suppress_publish: ContextVar[bool] = ContextVar("suppress_publish", default=False)


def publish_event(event_type: str, **fields):
    """Broadcast a change signal to all connected sessions. Best-effort:
    a full subscriber queue is skipped rather than blocking the request."""
    if _suppress_publish.get() and event_type != "scene_apply":
        return
    evt = {"type": event_type, "source": _current_client_id.get(), **fields}
    for q in list(_event_subscribers):
        try:
            q.put_nowait(evt)
        except asyncio.QueueFull:
            pass


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
    # config's segment_state is mac-slug keyed; the in-memory store is IP-keyed
    # (that's the live address). Resolve slug→current IP on load (persist maps back).
    _seg_raw = config.get("segment_state", {})
    _seg_resolved = {}
    for _k, _v in _seg_raw.items():
        if _k.startswith("govee:"):
            _ip = gv_ip_for_slug(_k[len("govee:"):])
            if _ip:
                _seg_resolved[f"govee:{_ip}"] = _v
        else:
            _seg_resolved[_k] = _v
    segment_state.load(_seg_resolved)
    yield
    flush_save_now()
    print("🔆 LightEmUp shutting down...")


app = FastAPI(title="LightEmUp", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def capture_client_id(request: Request, call_next):
    """Stash the caller's X-Client-Id so publish_event can stamp the source
    of a change, letting the originating session ignore its own echo."""
    token = _current_client_id.set(request.headers.get("X-Client-Id", ""))
    try:
        return await call_next(request)
    finally:
        _current_client_id.reset(token)


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
    mac: Optional[str] = None  # stable identity; state is persisted under it (IP is
                               # just the UDP address). Falls back to IP reverse-lookup.
    on: Optional[bool] = None
    brightness: Optional[int] = None  # 0-100
    r: Optional[int] = None
    g: Optional[int] = None
    b: Optional[int] = None
    color_temp_kelvin: Optional[int] = None
    raw_ct: Optional[bool] = None  # skip per-device CT calibration (used by the
                                   # calibration panel so it previews native output)

class FlashRequest(BaseModel):
    """Identify a single device by flashing it. Exactly one of light_id (Hue)
    or ip (Govee) is set."""
    light_id: Optional[str] = None
    ip: Optional[str] = None
    mac: Optional[str] = None  # Govee identity for state read (falls back to IP)

class RoomConfig(BaseModel):
    name: str
    hue_light_ids: list[str] = []
    govee_devices: list[str] = []  # list of Govee mac slugs (see gv_slug)

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
    background_rain: Optional[bool] = None

class GoveeSegmentModeRequest(BaseModel):
    room_name: str
    ip: str
    mac: Optional[str] = None  # identity for the config key (falls back to IP)
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
    """Discover Govee devices via LAN and fetch their current state.

    Also tracks every device we've ever seen in config.known_devices.govee
    (keyed by MAC) and reports any known devices that are currently absent
    so the UI can flag them. Removing a device from the known list is via
    DELETE /api/govee/known/{mac}.
    """
    from datetime import date
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

    # Overlay the last color/temp/on/brightness we set via LightEmUp so the
    # returned devices are render-ready (Govee LAN devStatus doesn't report color
    # reliably). The frontend no longer merges this itself — it just paints what
    # the backend returns.
    device_state = config.get("device_state", {})
    for dev in devices:
        stored = device_state.get(gv_key_for_ip(dev.get("ip"), dev.get("mac")))
        if not stored:
            continue
        st = dev.setdefault("state", {})
        if stored.get("r") is not None and stored.get("g") is not None and stored.get("b") is not None:
            st["color"] = {"r": stored["r"], "g": stored["g"], "b": stored["b"]}
            st["color_temp"] = None
        elif stored.get("color_temp_kelvin") is not None:
            st["color_temp"] = stored["color_temp_kelvin"]
            st["color"] = None
        if st.get("on") is None and stored.get("on") is not None:
            st["on"] = stored["on"]
        if st.get("brightness") is None and stored.get("brightness") is not None:
            st["brightness"] = stored["brightness"]

    # Upsert seen devices into the known set and compute the missing list.
    if "known_devices" not in config:
        config["known_devices"] = {"govee": {}}
    if "govee" not in config["known_devices"]:
        config["known_devices"]["govee"] = {}
    known = config["known_devices"]["govee"]
    today = date.today().isoformat()
    seen_macs = set()
    config_changed = False
    for dev in devices:
        mac = dev.get("mac") or dev.get("ip")
        if not mac:
            continue
        seen_macs.add(mac)
        prior = known.get(mac, {})
        new_entry = {
            "mac": mac,
            "ip": dev.get("ip"),
            "sku": dev.get("sku"),
            "name": dev.get("name"),
            "last_seen": today,
        }
        if prior != new_entry:
            known[mac] = new_entry
            config_changed = True

    # Assume-presence: a Govee LAN scan is lossy, so a device that didn't reply
    # to THIS scan isn't necessarily gone. Every device that did reply is marked
    # responding; every known device that didn't is appended as a non-responding
    # entry, rendered from its last-known state (device_state). Control is
    # fire-and-forget UDP to the stored IP, so these stay fully controllable —
    # the UI just badges them "not responding now". `missing` is still returned
    # for the Settings forget/re-scan affordance.
    for dev in devices:
        dev["responding"] = True

    missing = []
    for mac, entry in known.items():
        if mac in seen_macs:
            continue
        ip = entry.get("ip")
        sku = entry.get("sku")
        absent = {
            "ip": ip,
            "device": mac,
            "mac": mac,
            "sku": sku,
            "type": "govee",
            "name": entry.get("name") or sku or "Govee Device",
            "capabilities": {"has_color": True, "has_brightness": True, "has_segments": False},
            "responding": False,
            "last_seen": entry.get("last_seen"),
            "state": {"on": None, "brightness": None, "reachable": False},
        }
        stored = device_state.get(gv_key(mac))
        if stored:
            st = absent["state"]
            if stored.get("r") is not None and stored.get("g") is not None and stored.get("b") is not None:
                st["color"] = {"r": stored["r"], "g": stored["g"], "b": stored["b"]}
            elif stored.get("color_temp_kelvin") is not None:
                st["color_temp"] = stored["color_temp_kelvin"]
            if stored.get("on") is not None:
                st["on"] = stored["on"]
            if stored.get("brightness") is not None:
                st["brightness"] = stored["brightness"]
        devices.append(absent)
        missing.append(entry)

    if config_changed:
        save_config(config)

    return {"devices": devices, "missing": missing}


@app.delete("/api/govee/known/{mac:path}")
async def remove_known_govee(mac: str):
    """Forget a known Govee device so it no longer surfaces as missing."""
    known = config.get("known_devices", {}).get("govee", {})
    if mac in known:
        del known[mac]
        save_config(config)
        return {"success": True, "removed": mac}
    return {"success": False, "reason": "not found"}


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

def _hue_xy_to_rgb(xy, bri):
    """Hue CIE xy + brightness → display RGB (wide-gamut D65). Mirror of the old
    frontend hueXYToRGB so the backend serves render-ready colors."""
    if not xy or len(xy) < 2:
        return None
    x, y = xy[0], xy[1]
    if not y:
        return None
    z = 1.0 - x - y
    Y = (bri or 254) / 254
    X = (Y / y) * x
    Z = (Y / y) * z
    r = X * 1.656492 - Y * 0.354851 - Z * 0.255038
    g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152
    b = X * 0.051713 - Y * 0.121364 + Z * 1.011530

    def gamma(v):
        return 12.92 * v if v <= 0.0031308 else 1.055 * (v ** (1.0 / 2.4)) - 0.055

    return {
        "r": max(0, min(255, round(gamma(r) * 255))),
        "g": max(0, min(255, round(gamma(g) * 255))),
        "b": max(0, min(255, round(gamma(b) * 255))),
    }


@app.get("/api/hue/lights")
async def hue_lights():
    ip = config.get("hue_bridge_ip")
    username = config.get("hue_username")
    if not ip or not username:
        raise HTTPException(400, "Hue Bridge not paired")
    lights = await get_hue_lights(ip, username)
    # Attach a render-ready RGB derived from the reported xy so the frontend
    # paints the current color from backend data instead of converting itself.
    for light in lights:
        st = light.get("state") or {}
        if st.get("color") is None and st.get("xy"):
            rgb = _hue_xy_to_rgb(st.get("xy"), st.get("brightness"))
            if rgb:
                st["color"] = rgb
                light["state"] = st
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
    publish_event("hue", key=f"hue:{req.light_id}")
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
        persist_segments()
    results = {}

    if req.on is not None:
        results["turn"] = await govee_lan_turn(req.ip, req.on)

    if req.r is not None and req.g is not None and req.b is not None:
        results["color"] = await govee_lan_color(req.ip, req.r, req.g, req.b)

    # Track what we actually sent so device_state reflects reality: an RGB-space
    # calibrated CT request goes out as an RGB color, not a CT command.
    applied_rgb = None
    if req.color_temp_kelvin is not None:
        rgb = None if req.raw_ct else ct_rgb_color(req.ip, req.color_temp_kelvin)
        if rgb is not None:
            applied_rgb = rgb
            results["color"] = await govee_lan_color(req.ip, *rgb)
        else:
            out_k = req.color_temp_kelvin if req.raw_ct else correct_kelvin(req.ip, req.color_temp_kelvin)
            results["color_temp"] = await govee_lan_color_temp(req.ip, out_k)

    # Send brightness after color — some Govee devices reset brightness on color change
    if req.brightness is not None:
        results["brightness"] = await govee_lan_brightness(req.ip, req.brightness)

    record_govee_state(
        req.ip, mac=req.mac, on=req.on, brightness=req.brightness,
        r=applied_rgb[0] if applied_rgb else req.r,
        g=applied_rgb[1] if applied_rgb else req.g,
        b=applied_rgb[2] if applied_rgb else req.b,
        color_temp_kelvin=None if applied_rgb else req.color_temp_kelvin,
    )
    return {"results": results}


@app.post("/api/identify")
async def identify_device(req: FlashRequest):
    """Flash a device so the user can physically locate it.

    Hue: use the bridge's native ``alert: lselect`` (a ~15s breathe) — it's
    temporary and the bridge restores the prior state automatically, so we
    don't touch our recorded state.

    Govee: there's no native identify, so blink the device on/off a few times
    (on/off is digital, unlike the slow color/brightness animation) and then
    restore its last-known state from ``device_state``. Runs inline; the call
    returns once the blink sequence finishes (~4s)."""
    if req.light_id:
        ip = config.get("hue_bridge_ip")
        username = config.get("hue_username")
        if not ip or not username:
            raise HTTPException(400, "Hue Bridge not paired")
        ok = await set_hue_light_state(ip, username, req.light_id, {"alert": "lselect"})
        return {"success": ok}

    if req.ip:
        prior = config.get("device_state", {}).get(gv_key_for_ip(req.ip, req.mac), {})
        for _ in range(3):
            await govee_lan_turn(req.ip, True)
            await govee_lan_brightness(req.ip, 100)
            await asyncio.sleep(0.5)
            await govee_lan_turn(req.ip, False)
            await asyncio.sleep(0.5)
        # Restore last-known state (default: leave it on if we never tracked it).
        restore_on = prior.get("on", True)
        await govee_lan_turn(req.ip, bool(restore_on))
        if restore_on:
            if prior.get("brightness") is not None:
                await govee_lan_brightness(req.ip, prior["brightness"])
            if prior.get("r") is not None and prior.get("g") is not None and prior.get("b") is not None:
                await govee_lan_color(req.ip, prior["r"], prior["g"], prior["b"])
        return {"success": True}

    raise HTTPException(400, "Provide light_id (Hue) or ip (Govee)")


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


@app.delete("/api/rooms/{room_name}")
async def delete_room(room_name: str):
    """Delete a room. Its devices simply become unassigned (nicknames / state /
    calibration are keyed by device, not room, so they survive). Also drop the
    room-scoped sidecar config so a later room of the same name doesn't inherit
    stale layout / saved scene / lightning settings."""
    removed = room_name in config.get("rooms", {})
    if removed:
        del config["rooms"][room_name]
    for key in ("room_layouts", "room_color_state", "lightning_scenes"):
        d = config.get(key)
        if isinstance(d, dict) and room_name in d:
            del d[room_name]
            removed = True
    if removed:
        save_config(config)
        publish_event("config")
    return {"success": removed}


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

    # Control Govee devices in the room (membership is by mac slug; resolve the
    # current IP to actually address the device over LAN).
    for slug in room.get("govee_devices", []):
        device_ip = gv_ip_for_slug(slug)
        if not device_ip:
            results["govee"].append({"slug": slug, "success": False, "reason": "unresolved (offline?)"})
            continue
        razer_keeper.cancel(device_ip)
        if req.r is not None or req.on is False:
            segment_state.clear(device_ip)
            persist_segments()
        if req.on is not None:
            await govee_lan_turn(device_ip, req.on)
        if req.brightness is not None:
            await govee_lan_brightness(device_ip, req.brightness)
        if req.r is not None and req.g is not None and req.b is not None:
            await govee_lan_color(device_ip, req.r, req.g, req.b)
        record_govee_state(
            device_ip, on=req.on, brightness=req.brightness,
            r=req.r, g=req.g, b=req.b,
        )
        results["govee"].append({"ip": device_ip, "slug": slug, "success": True})

    publish_event("room", room=req.room_name)
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

    # Build room_config with segment info. Membership + fixtures are stored by mac
    # slug; the scene engine addresses devices by IP, so resolve slug→IP here and
    # hand the engine an IP-based view (keeps scenes.py identity-agnostic).
    room_config = dict(room)
    govee_segments = {}
    resolved_ips = []
    segment_mode = config.get("govee_segment_mode", {})
    segment_counts = config.get("govee_segment_counts", {})
    for slug in room.get("govee_devices", []):
        ip = gv_ip_for_slug(slug)
        if not ip:
            continue
        resolved_ips.append(ip)
        if segment_mode.get(slug):
            count = segment_counts.get(slug, 0)
            if count > 0:
                govee_segments[ip] = count
    room_config["govee_devices"] = resolved_ips
    room_config["govee_segments"] = govee_segments
    resolved_fixtures = {}
    for fid, fix in config.get("fixtures", {}).items():
        members = []
        for m in fix.get("members", []):
            if isinstance(m, str) and m.startswith("govee:"):
                ip = gv_ip_for_slug(m[len("govee:"):])
                if ip:
                    members.append(f"govee:{ip}")
            else:
                members.append(m)
        resolved_fixtures[fid] = {**fix, "members": members}
    room_config["fixtures"] = resolved_fixtures

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


@app.get("/api/events")
async def state_events():
    """SSE stream of state-change signals so every open session stays in sync.
    Quiet bus, so we emit a heartbeat comment every 20s to keep idle phone
    connections alive through proxies; EventSource auto-reconnects on drop."""
    async def event_stream():
        queue: asyncio.Queue = asyncio.Queue(maxsize=128)
        _event_subscribers.append(queue)
        try:
            while True:
                try:
                    evt = await asyncio.wait_for(queue.get(), timeout=20)
                    yield f"data: {json.dumps(evt)}\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            if queue in _event_subscribers:
                _event_subscribers.remove(queue)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/govee/segment-mode")
async def set_govee_segment_mode(req: GoveeSegmentModeRequest):
    """Toggle per-segment mode for a Govee device in a room."""
    slug = gv_slug_for_ip(req.ip, req.mac)
    if "govee_segment_mode" not in config:
        config["govee_segment_mode"] = {}
    config["govee_segment_mode"][slug] = req.enabled

    # If enabling, try to look up segment count from SKU table if not already stored.
    if req.enabled and slug not in config.get("govee_segment_counts", {}):
        # Try to find the SKU for this IP from discovered devices.
        # The caller should supply the count separately, but we can try the SKU table.
        pass  # Count must be set via /api/govee/segment-count

    save_config(config)
    return {"success": True, "segment_mode": req.enabled}


class GoveeSegmentCountRequest(BaseModel):
    ip: str
    mac: Optional[str] = None  # identity for the config key (falls back to IP)
    count: int

@app.post("/api/govee/segment-count")
async def set_govee_segment_count(req: GoveeSegmentCountRequest):
    """Manually set segment count for a Govee device."""
    if "govee_segment_counts" not in config:
        config["govee_segment_counts"] = {}
    config["govee_segment_counts"][gv_slug_for_ip(req.ip, req.mac)] = req.count
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
    color_temp_kelvin: Optional[int] = None  # white scenes: if the device has an
                                             # ct_rgb calibration, this is converted
                                             # to a calibrated RGB for the segment.


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

    # White scenes send a per-segment CT. If this device has an RGB-space white
    # calibration, render that segment as the calibrated warm RGB instead.
    if req.color_temp_kelvin is not None:
        rgb = ct_rgb_color(req.ip, req.color_temp_kelvin)
        if rgb is not None:
            req.r, req.g, req.b = rgb

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
        persist_segments()
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
        persist_segments()
    if req.brightness is not None:
        # Rate limit: wait before second call
        if results:
            await asyncio.sleep(1.0)
        results["brightness"] = await govee_v2_segment_brightness(
            api_key, req.sku, req.device_mac, req.segment_idx, req.brightness
        )
    return {"results": results, "protocol": "cloud_v2"}


class GoveeSegmentsMultiRequest(BaseModel):
    ip: str
    sku: str
    device_mac: str
    segments: list  # segment indices that share this one color
    r: Optional[int] = None
    g: Optional[int] = None
    b: Optional[int] = None
    color_temp_kelvin: Optional[int] = None  # white scenes: resolved via ct_rgb


@app.post("/api/govee/segments-multi")
async def control_govee_segments_multi(req: GoveeSegmentsMultiRequest):
    """Set a whole group of cloud_v2 segments to one color in a single V2 call.
    Scene applies share colors across many segments; one call per color (instead
    of one per segment, plus a separate brightness call) keeps us under the rate
    limit so segments stop getting dropped. Brightness is handled whole-device."""
    seg_info = GOVEE_SEGMENT_INFO.get(req.sku)
    if not seg_info:
        raise HTTPException(400, f"Unknown SKU {req.sku}")
    if seg_info.get("protocol") != "cloud_v2":
        raise HTTPException(400, f"SKU {req.sku} is not a cloud_v2 segment device")
    api_key = config.get("govee_api_key")
    if not api_key:
        raise HTTPException(400, "No Govee API key configured")

    # Resolve the color: white scenes send a Kelvin → calibrated RGB (ct_rgb),
    # falling back to the RGB approximation the client also sent.
    rgb = None
    if req.color_temp_kelvin is not None:
        rgb = ct_rgb_color(req.ip, req.color_temp_kelvin)
    if rgb is None and req.r is not None and req.g is not None and req.b is not None:
        rgb = (req.r, req.g, req.b)
    if rgb is None and req.color_temp_kelvin is not None:
        rgb = kelvin_to_rgb(req.color_temp_kelvin)
    if rgb is None:
        raise HTTPException(400, "segments-multi needs r,g,b or color_temp_kelvin")

    count = seg_info.get("count") or 0
    segs = [int(s) for s in req.segments if isinstance(s, int) and 0 <= s < count]
    if not segs:
        raise HTTPException(400, "no valid segment indices")

    ok = await govee_v2_segments_color(api_key, req.sku, req.device_mac, segs, *rgb)
    for idx in segs:
        segment_state.set_one(req.ip, idx, rgb[0], rgb[1], rgb[2])
    persist_segments()
    return {"success": ok, "segments": len(segs), "protocol": "cloud_v2"}


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


def _scale_colors(colors: list[tuple[int, int, int]], brightness: int,
                  gamma: float = 2.2) -> list[tuple[int, int, int]]:
    # Razer carries no brightness channel, so we fold brightness into RGB.
    # A linear multiply crushes low percentages to near-black (the hexa would
    # vanish at ~7%), unlike Hue/Govee firmware dimming which is perceptual.
    # Lift via gamma so the slider tracks perceived brightness: a 7% setting
    # maps to ~29% luminance at gamma 2.2.
    pct = max(0, min(100, brightness)) / 100.0
    f = pct ** (1.0 / gamma)
    return [(round(c[0] * f), round(c[1] * f), round(c[2] * f)) for c in colors]


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
    persist_segments()
    return {"success": True}


# ─── Backend-driven room scene apply ────────────────────────────────────────
# The frontend posts a fully-resolved scene once; the backend owns all the
# timing (fast whole-device base color, a short hold, then staggered Govee
# whole-device LAN commands and cloud_v2 segment-group calls under the V2 rate
# limit) in a background task. So the user can close the browser right after
# pressing Apply — the lights keep filling in server-side. Progress and
# cancellation flow over the SSE bus (type "scene_apply"); the per-call device
# events are suppressed during the run so other sessions don't refetch on every
# step — one "config" refresh is emitted at the end.

SCENE_SEG_STAGGER_S = 1.8     # between cloud_v2 segment-group calls (V2 rate limit)
SCENE_GOVEE_STAGGER_S = 0.15  # between Govee whole-device LAN commands
SCENE_HOLD_S = 2.0            # let the base color settle before segments fill in


class SceneHueTarget(BaseModel):
    light_id: str
    on: bool = True
    r: Optional[int] = None
    g: Optional[int] = None
    b: Optional[int] = None
    color_temp: Optional[int] = None   # mireds
    brightness: Optional[int] = None   # 1..254
    label: Optional[str] = None


class SceneGoveeWhole(BaseModel):
    ip: str
    on: bool = True
    r: Optional[int] = None
    g: Optional[int] = None
    b: Optional[int] = None
    color_temp_kelvin: Optional[int] = None
    brightness: Optional[int] = None   # 0..100
    label: Optional[str] = None


class SceneBaseSeed(BaseModel):
    ip: str
    r: Optional[int] = None
    g: Optional[int] = None
    b: Optional[int] = None
    color_temp_kelvin: Optional[int] = None
    brightness: Optional[int] = None


class SceneRazer(BaseModel):
    ip: str
    sku: str
    colors: list[list[int]]            # full-brightness RGB per segment
    brightness: Optional[int] = 100
    label: Optional[str] = None


class SceneCloudGroup(BaseModel):
    segments: list[int]
    r: Optional[int] = None
    g: Optional[int] = None
    b: Optional[int] = None
    color_temp_kelvin: Optional[int] = None


class SceneCloudDevice(BaseModel):
    ip: str
    sku: str
    device_mac: str
    unit: str = "segment"              # "segment" or "panel", for the label
    label: Optional[str] = None
    groups: list[SceneCloudGroup] = []


class SceneApplyRequest(BaseModel):
    room: str
    brightness: int = 100
    base_seeds: list[SceneBaseSeed] = []
    hue: list[SceneHueTarget] = []
    govee_whole: list[SceneGoveeWhole] = []
    razer: list[SceneRazer] = []
    cloud: list[SceneCloudDevice] = []


class SceneCancelRequest(BaseModel):
    room: str


# room name → running apply task. One scene per room; a new apply cancels the
# previous so two rapid Applies don't fight over the same lights.
_scene_tasks: "dict[str, asyncio.Task]" = {}


def _scene_emit(room: str, **fields):
    # scene_apply events bypass the per-run publish suppression (by type).
    publish_event("scene_apply", room=room, **fields)


async def _run_scene_apply(req: SceneApplyRequest):
    room = req.room
    # Suppress the noisy per-call device events for this task's context; we emit
    # one "config" refresh at the end instead.
    _suppress_publish.set(True)

    has_cloud = any(d.groups for d in req.cloud)
    cloud_group_count = sum(len(d.groups) for d in req.cloud)
    apply_total = len(req.hue) + len(req.govee_whole) + len(req.razer) + cloud_group_count

    # Wall-clock estimate so the browser can show a countdown.
    cloud_time = (max(0, cloud_group_count - 1) * SCENE_SEG_STAGGER_S + 0.1) if cloud_group_count else 0
    govee_time = (max(0, len(req.govee_whole) - 1) * SCENE_GOVEE_STAGGER_S + 0.2) if req.govee_whole else 0
    apply_time = max(cloud_time, govee_time, 0.05 if req.hue else 0)
    base_time = 0.6 if req.base_seeds else 0.0
    hold = SCENE_HOLD_S if has_cloud else 0.0
    end_at_ms = int((time.time() + base_time + hold + apply_time) * 1000)

    done = 0
    prog_lock = asyncio.Lock()

    async def tick(phase: str, total: int, label=None):
        nonlocal done
        async with prog_lock:
            done += 1
            _scene_emit(room, phase=phase, total=total, done=done, label=label, active=True)

    try:
        # ── Phase 1: fast whole-device base color (parallel LAN) ──
        if req.base_seeds:
            done = 0
            _scene_emit(room, phase="resetting", total=len(req.base_seeds), done=0,
                        label="Setting base color…", active=True, end_at=end_at_ms)

            async def seed(s: SceneBaseSeed):
                try:
                    await control_govee(GoveeCommandRequest(
                        ip=s.ip, r=s.r, g=s.g, b=s.b,
                        color_temp_kelvin=s.color_temp_kelvin, brightness=s.brightness))
                except Exception as e:
                    log.warning("scene base seed failed %s: %s", s.ip, e)
                await tick("resetting", len(req.base_seeds), "Setting base color…")

            await asyncio.gather(*(seed(s) for s in req.base_seeds))
            if has_cloud:
                await asyncio.sleep(hold)

        # ── Phase 2: hue + govee whole + razer + cloud segments ──
        done = 0
        _scene_emit(room, phase="applying", total=apply_total, done=0, active=True, end_at=end_at_ms)

        async def do_hue():
            for t in req.hue:
                try:
                    await control_hue_light(HueLightStateRequest(
                        light_id=t.light_id, on=t.on, r=t.r, g=t.g, b=t.b,
                        color_temp=t.color_temp, brightness=t.brightness))
                except Exception as e:
                    log.warning("scene hue failed %s: %s", t.light_id, e)
                await tick("applying", apply_total, t.label)

        async def do_govee_whole():
            for i, t in enumerate(req.govee_whole):
                if i:
                    await asyncio.sleep(SCENE_GOVEE_STAGGER_S)
                try:
                    await control_govee(GoveeCommandRequest(
                        ip=t.ip, on=t.on, r=t.r, g=t.g, b=t.b,
                        color_temp_kelvin=t.color_temp_kelvin, brightness=t.brightness))
                except Exception as e:
                    log.warning("scene govee whole failed %s: %s", t.ip, e)
                await tick("applying", apply_total, t.label)

        async def do_razer():
            for t in req.razer:
                try:
                    await control_govee_segments_bulk(GoveeSegmentsBulkRequest(
                        ip=t.ip, sku=t.sku, colors=t.colors, brightness=t.brightness))
                except Exception as e:
                    log.warning("scene razer failed %s: %s", t.ip, e)
                await tick("applying", apply_total, t.label)

        async def do_cloud():
            # Flatten groups across devices: the V2 rate limit is per-account, so
            # space every group call SCENE_SEG_STAGGER_S apart globally.
            first = True
            for d in req.cloud:
                for g in d.groups:
                    if not first:
                        await asyncio.sleep(SCENE_SEG_STAGGER_S)
                    first = False
                    n = len(g.segments)
                    unit = d.unit or "segment"
                    label = f"{d.label or d.ip} · {n} {unit}{'' if n == 1 else 's'}"
                    try:
                        await control_govee_segments_multi(GoveeSegmentsMultiRequest(
                            ip=d.ip, sku=d.sku, device_mac=d.device_mac,
                            segments=g.segments, r=g.r, g=g.g, b=g.b,
                            color_temp_kelvin=g.color_temp_kelvin))
                    except Exception as e:
                        log.warning("scene cloud failed %s: %s", d.ip, e)
                    await tick("applying", apply_total, label)

        await asyncio.gather(do_hue(), do_govee_whole(), do_razer(), do_cloud())

        _scene_emit(room, phase="done", total=apply_total, done=apply_total, label="", active=False)
    except asyncio.CancelledError:
        _scene_emit(room, phase="canceled", active=False, label="")
        raise
    finally:
        # Re-enable events and emit one refresh so all sessions resync once.
        _suppress_publish.set(False)
        publish_event("config")
        _scene_tasks.pop(room, None)


@app.post("/api/scenes/room-apply")
async def scene_room_apply(req: SceneApplyRequest):
    """Apply a fully-resolved room scene server-side. Returns immediately; the
    lights fill in via a background task, so the browser can be closed right
    after pressing Apply."""
    existing = _scene_tasks.get(req.room)
    if existing and not existing.done():
        existing.cancel()
        try:
            await existing
        except BaseException:
            pass
    task = asyncio.create_task(_run_scene_apply(req))
    _scene_tasks[req.room] = task
    return {"started": True, "room": req.room}


@app.post("/api/scenes/room-apply/cancel")
async def scene_room_apply_cancel(req: SceneCancelRequest):
    task = _scene_tasks.get(req.room)
    if task and not task.done():
        task.cancel()
        return {"canceled": True, "room": req.room}
    return {"canceled": False, "room": req.room}


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
        # Dimming the whole device via per-segment v2 brightness means one
        # rate-limited cloud call per segment (~1.5s each) — a 15-segment
        # slider drag takes ~22s and gets throttled, so the light appears not
        # to respond. A single whole-device LAN brightness command dims the
        # entire device instantly over UDP; the persistent segmentedColorRgb
        # segment colors are device state and survive the brightness change.
        await govee_lan_brightness(req.ip, brightness)
    else:
        raise HTTPException(400, f"SKU {req.sku} does not support segmented control")

    segment_state.set_brightness(req.ip, brightness)
    persist_segments()
    return {"success": True, "brightness": brightness}


@app.get("/api/govee/segment-state")
async def get_segment_state():
    """Return the last-known per-segment colors + brightness for every Govee
    device the server has set segments on, in the render-ready shape the UI uses:
    { ip: { colors: { idx: {r,g,b} }, brightness } } (devices with no colors are
    omitted). The frontend no longer reshapes this itself."""
    out = {}
    for ip, entry in segment_state.snapshot().items():
        colors = {}
        for k, v in (entry.get("colors") or {}).items():
            if isinstance(v, (list, tuple)) and len(v) == 3:
                colors[int(k)] = {"r": v[0], "g": v[1], "b": v[2]}
        if colors:
            out[ip] = {"colors": colors, "brightness": entry.get("brightness", 100)}
    return {"state": out}


# ─── Room color-tool state (display-only) ──────────────────────────────────────
# The room color tool's selection (mode, palette, brightness, etc.) lives only
# in the browser. Persisting the last-applied selection per room lets a second
# device pre-select the same palette/mode on open — display-only, never replays
# any light command.

class RoomColorStateRequest(BaseModel):
    room_name: str
    mode: Optional[str] = None
    color_space: Optional[str] = None
    palette_colors: Optional[list] = None
    base_color: Optional[dict] = None
    brightness: Optional[int] = None
    direction: Optional[str] = None
    address_segments: Optional[str] = None
    shuffle_seed: Optional[int] = None
    target_vendor: Optional[str] = None
    selected_team: Optional[str] = None
    selected_ncaa: Optional[str] = None
    selected_flag: Optional[str] = None
    # Per-mode settings so every scene mode (not just palette) rehydrates.
    custom_colors: Optional[list] = None
    custom_shade_mode: Optional[str] = None
    beacon_source_key: Optional[str] = None
    max_kelvin: Optional[int] = None
    ct_preset: Optional[int] = None


@app.post("/api/room-color-state")
async def set_room_color_state(req: RoomColorStateRequest):
    store = config.setdefault("room_color_state", {})
    entry = {k: v for k, v in req.model_dump().items()
             if k != "room_name" and v is not None}
    entry["updated_at"] = _now_iso()
    store[req.room_name] = entry
    schedule_save()
    publish_event("room-color", room=req.room_name)
    return {"success": True}


class CTCalibrationRequest(BaseModel):
    device_key: str  # "govee:<ip>"
    points: list  # [{ in: requestedK, out: correctedK }, ...]; [] clears calibration


@app.post("/api/calibration/ct")
async def set_ct_calibration(req: CTCalibrationRequest):
    store = config.setdefault("ct_correction", {})
    pts = [p for p in (req.points or []) if p.get("in") and p.get("out")]
    if pts:
        store[req.device_key] = sorted(pts, key=lambda p: p["in"])
    else:
        store.pop(req.device_key, None)
    schedule_save()
    publish_event("config")
    return {"success": True, "ct_correction": store}


@app.post("/api/calibration/ct-rgb")
async def set_ct_rgb_calibration(req: CTCalibrationRequest):
    """RGB-space white calibration: same {in,out} shape as /calibration/ct, but
    out is an effective warm Kelvin we send as kelvin_to_rgb() RGB. Setting an
    ct_rgb entry takes precedence over ct_correction for that device."""
    store = config.setdefault("ct_rgb", {})
    pts = [p for p in (req.points or []) if p.get("in") and p.get("out")]
    if pts:
        store[req.device_key] = sorted(pts, key=lambda p: p["in"])
    else:
        store.pop(req.device_key, None)
    schedule_save()
    publish_event("config")
    return {"success": True, "ct_rgb": store}


# ─── Config Endpoint ────────────────────────────────────────────────────────

# Default favorite colors, served when the user hasn't saved their own. These
# used to live in the browser's localStorage (per-device, didn't sync); they now
# live in config so every session/device sees the same set.
DEFAULT_FAVORITES = [
    {"r": 255, "g": 180, "b": 100, "label": "Warm"},
    {"r": 180, "g": 210, "b": 255, "label": "Cool"},
    {"r": 255, "g": 245, "b": 228, "label": "Daylight"},
    {"r": 255, "g": 40, "b": 40, "label": "Red"},
    {"r": 40, "g": 80, "b": 255, "label": "Blue"},
    {"r": 40, "g": 220, "b": 80, "label": "Green"},
    {"r": 160, "g": 50, "b": 255, "label": "Purple"},
    {"r": 255, "g": 120, "b": 20, "label": "Orange"},
]


class FavoritesRequest(BaseModel):
    favorites: list


@app.post("/api/favorites")
async def set_favorites(req: FavoritesRequest):
    config["favorites"] = req.favorites
    save_config(config)
    publish_event("config")
    return {"success": True}


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
        "device_state": config.get("device_state", {}),
        "room_color_state": config.get("room_color_state", {}),
        "ct_correction": config.get("ct_correction", {}),
        "ct_rgb": config.get("ct_rgb", {}),
        "device_modes": config.get("device_modes", {}),
        "segment_fill_modes": config.get("segment_fill_modes", {}),
        "ui_prefs": config.get("ui_prefs", {}),
        "favorites": config.get("favorites") or DEFAULT_FAVORITES,
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
    publish_event("config")
    return {"success": True, "fixtures": fixtures}


@app.delete("/api/fixtures/{fixture_id}")
async def delete_fixture(fixture_id: str):
    fixtures = config.get("fixtures", {})
    if fixture_id in fixtures:
        del fixtures[fixture_id]
        save_config(config)
        publish_event("config")
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
    publish_event("config")
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
    publish_event("config")
    return {"success": True}


@app.post("/api/device-modes/bulk")
async def set_device_modes_bulk(req: DeviceModesBulkRequest):
    if "device_modes" not in config:
        config["device_modes"] = {}
    for k, v in req.modes.items():
        if v in ("whole", "segments"):
            config["device_modes"][k] = v
    save_config(config)
    publish_event("config")
    return {"success": True, "device_modes": config["device_modes"]}


class SegmentFillModeRequest(BaseModel):
    device_key: str
    mode: str  # "follow" | "solid" | "shades"


@app.post("/api/segment-fill-modes")
async def set_segment_fill_mode(req: SegmentFillModeRequest):
    if req.mode not in ("follow", "solid", "shades"):
        raise HTTPException(400, "mode must be follow, solid, or shades")
    if "segment_fill_modes" not in config:
        config["segment_fill_modes"] = {}
    config["segment_fill_modes"][req.device_key] = req.mode
    save_config(config)
    publish_event("config")
    return {"success": True}


# ─── UI Preferences ─────────────────────────────────────────────────────────

class UiPrefsRequest(BaseModel):
    color_picker_style: Optional[str] = None  # "huebar" | "wheel"
    min_saturation_enabled: Optional[bool] = None
    min_saturation_pct: Optional[int] = None


@app.post("/api/ui-prefs")
async def set_ui_prefs(req: UiPrefsRequest):
    if "ui_prefs" not in config:
        config["ui_prefs"] = {}
    if req.color_picker_style in ("huebar", "wheel"):
        config["ui_prefs"]["color_picker_style"] = req.color_picker_style
    if req.min_saturation_enabled is not None:
        config["ui_prefs"]["min_saturation_enabled"] = bool(req.min_saturation_enabled)
    if req.min_saturation_pct is not None:
        config["ui_prefs"]["min_saturation_pct"] = max(0, min(100, req.min_saturation_pct))
    save_config(config)
    return {"success": True, "ui_prefs": config["ui_prefs"]}


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


@app.get("/api/version")
async def get_version():
    """Return the running build's version + short git hash + commit date."""
    return {
        "version": APP_VERSION,
        "git_hash": GIT_HASH,
        "git_date": GIT_DATE,
        "display": version_string(),
    }


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
    if not index.exists():
        return {"message": "Frontend not found. Place index.html in /static/"}
    html = index.read_text(encoding="utf-8")
    # Cache-bust the in-browser JS. The js/*.js files have no content hash and
    # browsers cache them aggressively, so after a deploy the UI would keep
    # running stale scripts until a manual hard-refresh (and the footer version
    # comes from the API, so it looks updated while the JS isn't). Tag each local
    # script src with the build hash so a new build loads fresh automatically.
    ver = GIT_HASH or APP_VERSION
    import re
    html = re.sub(r'(src=")(js/[^"?]+\.js)(")', rf'\1\2?v={ver}\3', html)
    # Never cache the shell itself, so the updated ?v= tags are always seen.
    return HTMLResponse(html, headers={"Cache-Control": "no-cache, must-revalidate"})

app.mount("/sounds", StaticFiles(directory=str(STATIC_DIR / "sounds")), name="sounds")
app.mount("/js", StaticFiles(directory=str(STATIC_DIR / "js")), name="js")


if __name__ == "__main__":
    import uvicorn
    # timeout_graceful_shutdown: the SSE streams (/api/events, lightning events)
    # are long-lived requests that never finish on their own. Without a bound,
    # uvicorn waits forever for them on shutdown, so `systemctl restart` hangs
    # until systemd force-kills. Cap it so a restart force-closes them in a few s.
    uvi_config = uvicorn.Config(app, host="0.0.0.0", port=8420, timeout_graceful_shutdown=5)
    server = uvicorn.Server(uvi_config)
    _server_ref = server
    server.run()
