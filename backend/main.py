"""
LightEmUp - FastAPI backend for controlling Hue and Govee lights.
"""

import asyncio
import json
import logging
import math
import os
import random
import sys
import subprocess
import time
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, StreamingResponse, HTMLResponse, Response
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
import palettes
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
    "device_modes": {},  # device_key → "whole" | "segments" (LightCard preference:
                          # which CONTROLS the card shows. Not scene addressing —
                          # that's govee_scene_address below.)
    "hue_missing_since": {},  # hue light id → ISO date it was FIRST seen absent
                               # from the bridge (v3.23.1). Cleared the moment it
                               # comes back. Govee's equivalent is
                               # known_devices.govee[mac].last_seen.
    "govee_scene_address": {},  # govee slug → "segments" | "whole" (v3.18.0)
                                # Does a room scene paint this device per segment or
                                # as one colour? Set per device in the Scenes panel
                                # and read by BOTH the browser's scene apply and the
                                # scheduler's palette action, so a scheduled look
                                # matches a hand-applied one. Absent = "segments"
                                # for any device with >1 segment (the old default).
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
    "power_recovery": {   # how a fresh boot after a power outage treats the lights
        "mode": "resume_unless_night",   # "resume_unless_night" | "resume_always" | "off"
        "night_start": "22:00",          # 24h HH:MM — start of the "stay off overnight" window
        "night_end": "07:00",            # 24h HH:MM — end of it (window wraps past midnight)
    },
    "schedules": [],      # time-based schedules; list of schedule objects. Each:
                          #   { id, name, enabled, last_fired,
                          #     trigger: { type: weekly|oneoff|sun, ... },
                          #     action:  { type: scene|white|color, room, ... } }
                          # Scene actions store a fully-resolved room-apply payload
                          # (scene math is browser-only); the scheduler re-resolves
                          # each Govee entry's IP from its mac at fire time. See
                          # _scheduler_loop / _schedule_due / _fire_schedule.
    "room_last_applied": {},  # room name → what that room was last set to, for the
                          # "Now showing" strip in the room header:
                          #   { kind, label, swatches: [[r,g,b],…], kelvin, at,
                          #     source: "app"|"schedule", source_detail }
                          # DISTINCT from room_color_state, which stores the Scenes
                          # panel's *recipe* so its controls rehydrate. This stores the
                          # resolved RESULT, is written by every whole-room path
                          # (including schedules firing server-side), and is the only
                          # one that can answer "what is this room set to right now".
    "location": {},       # { lat, lng } — for sun-relative (sunrise/sunset) triggers
    "zones": {},          # name-keyed groups of rooms: { zoneName: { rooms: [name,…] } }
                          # A zone is a scheduling target that fans a white/color/power
                          # action out over every device in every member room. Scenes
                          # stay room-only (a scene is a device-specific snapshot).
    # The five below were written by their features but never declared here — found
    # by diffing DEFAULT_CONFIG against a live export (v3.30.0). A key missing from
    # this dict is invisible to the restore preview and absent after importing an
    # older backup that predates it, so THIS DICT IS THE REGISTRY OF WHAT SETTINGS
    # EXIST. Add a key here in the same commit that starts writing it.
    "favorites": [],      # saved colours [[r,g,b],…]. Empty is falsy on purpose:
                          # /api/config falls back to DEFAULT_FAVORITES (defined much
                          # further down, so it can't be referenced from here).
    "lightning_scenes": {},      # room name → saved storm settings
    "govee_segment_counts": {},  # govee slug → real panel count (a 7-panel Hexa, not
                                 # the SKU's 15). User ground truth; beats the SKU table.
    "govee_segment_mode": {},    # govee slug → bool: per-segment LIGHTNING. NOT scene
                                 # addressing (that's govee_scene_address above).
    "room_presets": {},          # room name → saved preset list (GET/POST /api/room-presets)
    # NOT here on purpose: "schema_version". It's a migration marker, not a setting.
    # Defaulting it to the current version would make an ancient backup that carries
    # no schema_version look already-migrated, so migrate_govee_to_mac would skip an
    # IP-keyed config and silently orphan every Govee association.
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

    # 3) Bare-IP dicts (segment mode / counts / scene addressing)
    for key in ("govee_segment_mode", "govee_segment_counts", "govee_scene_address"):
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


def migrate_scene_address(cfg: dict) -> bool:
    """One-time: turn the old ROOM-level "address segmented devices individually /
    as a unit" scene setting into the per-device `govee_scene_address` map.

    Before v3.18.0 the choice was one switch per room, stored in
    `room_color_state[room].address_segments`, and only the browser could read it —
    which is why a scheduled palette and a hand-applied one disagreed about the
    same device. Now it's per device and shared with the backend.

    Only rooms that opted OUT ("unit") need a record: absent means "segments",
    which is what "individual" (the default) meant. Guarded by the key's presence,
    not its contents, so a legitimately empty result doesn't re-migrate forever."""
    if "govee_scene_address" in cfg:
        return False

    mapping = {}
    for room_name, state in (cfg.get("room_color_state") or {}).items():
        if (state or {}).get("address_segments") != "unit":
            continue
        room = (cfg.get("rooms") or {}).get(room_name) or {}
        for slug in room.get("govee_devices", []):
            mapping[slug] = "whole"

    cfg["govee_scene_address"] = mapping
    if mapping:
        log.warning("Scene addressing migrated: %d device(s) kept on whole-device "
                    "(from a room set to 'address as a unit')", len(mapping))
    return True


config = load_config()
if migrate_govee_to_mac(config):
    save_config(config)
if migrate_scene_address(config):
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


def record_hue_state(light_id: str, state: dict):
    """Mirror the last state we sent a Hue light into device_state under
    'hue:<id>', so power-recovery can replay it. Stores the Hue-native fields we
    sent (on/bri/xy/ct/hue/sat). Color (xy/hue/sat) and CT are mutually
    exclusive — a new color clears a prior ct and vice-versa. Display-only for
    the browser (Hue lights render from live bridge state); this exists purely so
    a fresh boot can restore the last intended state."""
    store = config.setdefault("device_state", {})
    key = f"hue:{light_id}"
    entry = store.get(key, {})
    if any(k in state for k in ("xy", "hue", "sat")):
        entry.pop("ct", None)
    if "ct" in state:
        for k in ("xy", "hue", "sat"):
            entry.pop(k, None)
    for k in ("on", "bri", "xy", "ct", "hue", "sat"):
        if state.get(k) is not None:
            entry[k] = state[k]
    entry["updated_at"] = _now_iso()
    store[key] = entry
    schedule_save()


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

# Set by bulk paths that drive control_hue_light in a loop AND register their own
# verify batch at the end. Without it, a staggered scene apply would register each
# light as it goes and trigger a read-back every settle window for the whole run;
# the batch at the end covers them all in one. Per-task, so single-light requests
# from the UI are unaffected and still self-verify.
_in_bulk_hue: ContextVar[bool] = ContextVar("in_bulk_hue", default=False)


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


# ─── Power-recovery (graceful handling of a power outage → boot) ──────────────
# A sudden power loss + restore reboots the Pi, the Hue bridge, and the Govee
# devices together. The lights come back to their *hardware/bridge* default —
# often full-on — which at 3am lights the whole house. So on a genuine fresh
# boot we either replay the last-known lighting (daytime) or force everything
# off (overnight), per the user's power_recovery settings.
#
# CRITICAL: only act on an actual boot. A normal deploy / service restart (the
# machine has been up for hours) must NOT touch the lights — otherwise deploying
# at night would kill lights that are intentionally on. /proc/uptime is the
# discriminator: a power event restarts the service within minutes of boot; a
# deploy restart happens long after. On non-Linux dev boxes /proc/uptime is
# absent, so recovery simply never fires there.

FRESH_BOOT_MAX_UPTIME_S = 600   # service up within 10 min of boot ⇒ treat as power event
RECOVERY_SETTLE_S = 45          # wait for the bridge + Govee to rejoin the LAN first
# Clean-shutdown marker: written when the lifespan shutdown hook runs (a planned
# reboot / `systemctl restart` sends SIGTERM, so it runs) and consumed on the next
# startup. Present at boot ⇒ we were stopped cleanly (planned reboot — always
# resume, even overnight). Absent ⇒ the process was killed without a clean stop
# (a power outage), so the overnight "stay off" guard applies. This is how a
# planned nightly reboot differs from a 3am outage.
SHUTDOWN_MARKER = CONFIG_PATH.parent / ".clean_shutdown"


def _system_uptime_s():
    """Seconds since the machine booted, or None if unknowable (non-Linux)."""
    try:
        with open("/proc/uptime") as f:
            return float(f.read().split()[0])
    except Exception:
        return None


def _parse_hhmm(s, default_h=-1, default_m=-1):
    """Parse 'HH:MM' → (hour, minute); returns the defaults on any bad input."""
    try:
        h, m = str(s).split(":")
        return int(h) % 24, int(m) % 60
    except Exception:
        return default_h, default_m


def _in_night_window(now, start_s, end_s):
    """Is local time `now` inside the [start, end) overnight window? The window
    wraps past midnight (e.g. 22:00→07:00). Equal start==end ⇒ never night."""
    sh, sm = _parse_hhmm(start_s, 22, 0)
    eh, em = _parse_hhmm(end_s, 7, 0)
    cur = now.hour * 60 + now.minute
    a, b = sh * 60 + sm, eh * 60 + em
    if a == b:
        return False
    if a < b:
        return a <= cur < b
    return cur >= a or cur < b   # wraps midnight


async def _recovery_all_off():
    """Overnight recovery: force every Hue light and known Govee device off."""
    ip = config.get("hue_bridge_ip")
    username = config.get("hue_username")
    hue_n = govee_n = 0
    if ip and username:
        try:
            lights = await get_hue_lights(ip, username)
        except Exception:
            lights = []
        for light in lights:
            try:
                await set_hue_light_state(ip, username, str(light["id"]), {"on": False})
                record_hue_state(str(light["id"]), {"on": False})
                hue_n += 1
            except Exception:
                pass
    for mac, info in list(_known_govee().items()):
        dip = info.get("ip")
        if not dip:
            continue
        try:
            await govee_lan_turn(dip, False)
            record_govee_state(dip, mac=mac, on=False)
            govee_n += 1
        except Exception:
            pass
    log.info("Power recovery: forced OFF %d Hue + %d Govee", hue_n, govee_n)


async def _recovery_resume():
    """Daytime recovery: replay the last state we set on each device."""
    ds = config.get("device_state", {})
    ip = config.get("hue_bridge_ip")
    username = config.get("hue_username")
    hue_n = govee_n = 0
    for key, st in list(ds.items()):
        if key.startswith("hue:") and ip and username:
            replay = {k: st[k] for k in ("on", "bri", "xy", "ct", "hue", "sat") if k in st}
            if not replay:
                continue
            try:
                await set_hue_light_state(ip, username, key[len("hue:"):], replay)
                hue_n += 1
            except Exception:
                pass
        elif key.startswith("govee:"):
            dip = gv_ip_for_slug(key[len("govee:"):])
            if not dip:
                continue
            # Default to OFF when the on-state was never recorded — after an outage
            # a Govee device powers back on at its hardware default, so an unknown
            # state must NOT be treated as "turn it on".
            on = st.get("on", False)
            try:
                await govee_lan_turn(dip, bool(on))
                if on:
                    if st.get("brightness") is not None:
                        await govee_lan_brightness(dip, st["brightness"])
                    if st.get("r") is not None and st.get("g") is not None and st.get("b") is not None:
                        await govee_lan_color(dip, st["r"], st["g"], st["b"])
                    elif st.get("color_temp_kelvin") is not None:
                        await govee_lan_color_temp(dip, st["color_temp_kelvin"])
                govee_n += 1
            except Exception:
                pass
    log.info("Power recovery: resumed %d Hue + %d Govee", hue_n, govee_n)


async def _apply_power_recovery(clean_shutdown: bool):
    """One-shot background task, launched only on a fresh boot. Decides whether the
    lights actually lost power, and if so resumes or forces-off per settings.

    KEY INSIGHT: the Pi does NOT power the Hue/Govee lights — they run on their own
    wall power. So a plain Pi reboot (`sudo reboot`, `systemctl`, a deploy) leaves
    the lights untouched; they keep their real state across the reboot and there is
    NOTHING to recover. Actively driving them would be wrong (it would turn ON lights
    that were off — the v3.4.4 bug). The ONLY event that actually de-powers the
    lights is a house/circuit outage — and that also kills the Pi *without* a clean
    shutdown, so the clean-shutdown marker is absent.

    Therefore: `clean_shutdown` True ⇒ planned reboot ⇒ do NOTHING (leave the lights
    exactly as they were — this is the truest "resume", and never wakes the house).
    Only an *unclean* boot (real outage) applies the policy: resume the last-known
    lighting during the day, or force everything off overnight. Lightning storms are
    never resumed (the scene engine bypasses device_state)."""
    from datetime import datetime
    settings = config.get("power_recovery", {})
    mode = settings.get("mode", "resume_unless_night")
    if mode == "off":
        log.info("Power recovery: disabled (mode=off) — leaving lights as-is")
        return
    if clean_shutdown:
        log.info("Power recovery: clean shutdown (planned reboot) — the lights kept "
                 "their state through the reboot (the Pi doesn't power them), so "
                 "there's nothing to recover; leaving them untouched")
        return

    # Only a genuine power outage (unclean boot) reaches here.
    await asyncio.sleep(RECOVERY_SETTLE_S)

    now = datetime.now()   # Pi runs in the user's local timezone
    night = _in_night_window(now, settings.get("night_start", "22:00"),
                             settings.get("night_end", "07:00"))
    stay_off = (mode == "resume_unless_night") and night
    log.info("Power recovery: OUTAGE detected — mode=%s local=%s night=%s → %s", mode,
             now.strftime("%H:%M"), night, "ALL OFF" if stay_off else "RESUME")

    # DHCP may have handed out new Govee IPs on reboot — refresh before addressing.
    try:
        await discover_govee()
    except Exception:
        log.exception("Power recovery: Govee refresh failed (continuing anyway)")

    try:
        if stay_off:
            await _recovery_all_off()
        else:
            await _recovery_resume()
    except Exception:
        log.exception("Power recovery: apply failed")


async def _recover_then_release(clean_shutdown: bool):
    """Run power recovery, then release the span catch-up that's waiting on it.
    The `finally` matters: every early return in _apply_power_recovery (mode=off,
    clean shutdown) must still release, or the catch-up sits out its full timeout
    for no reason."""
    try:
        await _apply_power_recovery(clean_shutdown)
    finally:
        if _recovery_done is not None:
            _recovery_done.set()


# ─── Time-based scheduler ──────────────────────────────────────────────────────
# Fire a room "look" at a wall-clock time. The three trigger types (weekly,
# one-off, sunrise/sunset) all resolve to a target HH:MM on a matching day and are
# compared against naive Pi-local time — DST-safe by construction (7am is always
# 7am). Color-scene assignment is browser-only, so a scheduled scene stores a
# fully-resolved room-apply payload and we re-resolve each Govee entry's DHCP IP
# from its stable mac at fire time (mirrors the v3.0 MAC-keying fix). No catch-up:
# a schedule whose minute passed while the Pi was off does NOT retro-fire.

_scheduler_task: "asyncio.Task | None" = None
_scheduler_stop: "asyncio.Event | None" = None
_catchup_task: "asyncio.Task | None" = None
# Set once power recovery has finished (or immediately, when none is scheduled).
# The span catch-up waits on this so the two can't fight over the same lights —
# see _catch_up_spans for why the schedule deliberately gets the last word.
_recovery_done: "asyncio.Event | None" = None

SPAN_CATCHUP_LOOKBACK_DAYS = 2   # how far back to look for a still-running span
RECOVERY_WAIT_MAX_S = 180        # give up waiting on power recovery after this


def _hhmm_matches(hhmm: str, now) -> bool:
    """Does the given 'HH:MM' equal the minute of `now`?"""
    h, m = _parse_hhmm(hhmm)
    return h >= 0 and now.hour == h and now.minute == m


def _sun_hhmm(event: str, d, lat, lng, offset_min: int = 0):
    """Local wall-clock (hour, minute) of sunrise/sunset on date `d` at lat/lng,
    shifted by `offset_min`. Returns None if astral is missing or inputs are bad.
    astral is imported lazily so the module loads on dev boxes without it."""
    try:
        from astral import LocationInfo
        from astral.sun import sun as _astral_sun
        from datetime import datetime as _dt, timedelta
        tz = _dt.now().astimezone().tzinfo   # the Pi's local zone
        loc = LocationInfo(latitude=float(lat), longitude=float(lng))
        t = _astral_sun(loc.observer, date=d, tzinfo=tz).get(event)
        if t is None:
            return None
        t = t + timedelta(minutes=int(offset_min or 0))
        return t.hour, t.minute
    except Exception:
        log.debug("Scheduler: sun time unavailable", exc_info=True)
        return None


def _schedule_due(sched: dict, now, location: dict = None, sun_resolver=None) -> bool:
    """PURE (unit-testable): is this schedule due in the minute containing `now`?
    Deduped against `last_fired` so it fires at most once per minute-occurrence.
    `now` is naive Pi-local. `sun_resolver(event, date, offset) -> (h, m)|None` is
    injectable for tests; it defaults to astral via _sun_hhmm."""
    if not sched.get("enabled"):
        return False
    trig = sched.get("trigger") or {}
    ttype = trig.get("type")
    if sched.get("last_fired") == now.strftime("%Y-%m-%d %H:%M"):
        return False   # already fired this exact minute-occurrence

    if ttype == "weekly":
        days = trig.get("days") or []
        return now.weekday() in days and _hhmm_matches(trig.get("time"), now)

    if ttype == "oneoff":
        return (trig.get("date") == now.strftime("%Y-%m-%d")
                and _hhmm_matches(trig.get("time"), now))

    if ttype == "sun":
        days = trig.get("days")
        if days and now.weekday() not in days:
            return False
        loc = location or {}
        lat, lng = loc.get("lat"), loc.get("lng")
        if lat is None or lng is None:
            return False
        resolver = sun_resolver or (lambda ev, dt, off: _sun_hhmm(ev, dt, lat, lng, off))
        hm = resolver(trig.get("event", "sunrise"), now.date(), trig.get("offset_min", 0))
        return bool(hm) and now.hour == hm[0] and now.minute == hm[1]

    return False


def _freshen_scene_payload(payload: dict):
    """Copy a stored scene room-apply payload with every Govee entry's IP
    re-resolved from its mac (DHCP-robust). Govee entries whose device can't be
    resolved (never seen / gone) are dropped; Hue entries are always kept (stable
    light_id). Returns None if nothing addressable remains."""
    if not payload:
        return None
    import copy
    p = copy.deepcopy(payload)
    for listname, mac_field in (("base_seeds", "mac"), ("govee_whole", "mac"),
                                ("razer", "mac"), ("cloud", "device_mac")):
        kept = []
        for entry in p.get(listname, []) or []:
            mac = entry.get(mac_field)
            ip = gv_ip_for_slug(gv_slug(mac)) if mac else entry.get("ip")
            if not ip:
                continue   # unresolved — drop this device
            entry["ip"] = ip
            kept.append(entry)
        p[listname] = kept
    has_any = bool(p.get("hue")) or any(
        p.get(k) for k in ("base_seeds", "govee_whole", "razer", "cloud"))
    return p if has_any else None


def _white_label(kelvin: int) -> str:
    """Name a white temperature the way the room header's shortcuts do, so a
    schedule firing 2700K reads the same as pressing Soft White."""
    if kelvin <= 2800:
        return f"Soft White · {kelvin}K"
    if kelvin >= 5000:
        return f"Cool White · {kelvin}K"
    return f"White · {kelvin}K"


async def _apply_room_white(room_name: str, kelvin: int, brightness_pct: int,
                            source: str = "app", source_detail: Optional[str] = None):
    """Set every light in a room to a white color temperature at a brightness %.
    Mirrors the frontend setRoomWhite fan-out (Hue in mireds, Govee in kelvin)."""
    room = config.get("rooms", {}).get(room_name)
    if not room:
        log.warning("Scheduler: white action — room %r not found", room_name)
        return
    mireds = max(153, min(500, round(1_000_000 / max(1, kelvin))))
    bri254 = max(1, min(254, round(brightness_pct * 254 / 100)))
    sent = {}
    _in_bulk_hue.set(True)
    try:
        for light_id in room.get("hue_light_ids", []):
            res = await control_hue_light(HueLightStateRequest(
                light_id=str(light_id), on=True, brightness=bri254, color_temp=mireds))
            if res.get("success") and res.get("state"):
                sent[str(light_id)] = res["state"]
    finally:
        _in_bulk_hue.set(False)
    schedule_hue_verify(sent)
    for slug in room.get("govee_devices", []):
        ip = gv_ip_for_slug(slug)
        if ip:
            await control_govee(GoveeCommandRequest(
                ip=ip, mac=slug, on=True, brightness=brightness_pct,
                color_temp_kelvin=kelvin))
    # No swatch: the frontend renders the chip from `kelvin` via kelvinToRGB, so
    # the backend doesn't need discovery's colour math just for a label.
    record_room_applied(room_name, "white", _white_label(kelvin), kelvin=kelvin,
                        source=source, source_detail=source_detail, expect=sent)


async def _apply_room_color(room_name: str, r: int, g: int, b: int, brightness_pct: int,
                            source: str = "app", source_detail: Optional[str] = None):
    """Set every light in a room to one RGB color at a brightness %."""
    room = config.get("rooms", {}).get(room_name)
    if not room:
        log.warning("Scheduler: color action — room %r not found", room_name)
        return
    bri254 = max(1, min(254, round(brightness_pct * 254 / 100)))
    sent = {}
    _in_bulk_hue.set(True)
    try:
        for light_id in room.get("hue_light_ids", []):
            res = await control_hue_light(HueLightStateRequest(
                light_id=str(light_id), on=True, brightness=bri254, r=r, g=g, b=b))
            if res.get("success") and res.get("state"):
                sent[str(light_id)] = res["state"]
    finally:
        _in_bulk_hue.set(False)
    schedule_hue_verify(sent)
    for slug in room.get("govee_devices", []):
        ip = gv_ip_for_slug(slug)
        if ip:
            await control_govee(GoveeCommandRequest(
                ip=ip, mac=slug, on=True, brightness=brightness_pct, r=r, g=g, b=b))
    record_room_applied(room_name, "color", "Solid color", swatches=[[r, g, b]],
                        source=source, source_detail=source_detail, expect=sent)


# ─── Palette actions (v3.17.0) ───────────────────────────────────────────────
# A palette schedule stores a SOURCE, not a snapshot: "a random palette from
# Summer" or "a random one of these four". The look is resolved at fire time,
# which is the whole point — the same schedule has to produce a different scene
# each evening. That means the Pi does the colour-to-device assignment itself,
# where the browser normally would.
#
# Why not snapshot ten payloads in the browser and pick one? Because a category
# is ten devices-worth of resolved JSON per palette, it would bloat config.json
# (rewritten on every mutation, on an SD card) by an order of magnitude, it goes
# stale the moment a light is added to the room, and it would freeze each
# palette into one arrangement forever. Storing the intent instead is smaller,
# survives room edits, and re-arranges every night.
#
# The assignment here is deliberately simpler than the browser's adjacency
# solver: deal a shuffled pool round-robin over devices sorted by their position
# in the room layout. That gives the two properties that actually matter — no
# two neighbours share a colour, and the arrangement differs each fire.

class _ColorDealer:
    """Hands out palette colours so that consecutive calls never repeat.

    Reshuffles at each cycle boundary (and re-rolls if the new cycle would open
    with the colour the last one closed on), so a long strip doesn't show the
    same repeating ABCABC pattern down its whole length."""

    def __init__(self, colors: list, rng=None):
        self.colors = list(colors)
        self.rng = rng or random
        self.queue: list = []
        self.last = None

    def _refill(self):
        pool = list(self.colors)
        self.rng.shuffle(pool)
        if len(pool) > 1 and pool[0] == self.last:
            pool.append(pool.pop(0))
        self.queue = pool

    def next(self):
        if not self.colors:
            return (255, 255, 255)
        if not self.queue:
            self._refill()
        self.last = self.queue.pop(0)
        return self.last


def _palette_device_order(room_name: str, keys: list[str]) -> list[str]:
    """Device keys in room-layout order (left to right, then top to bottom).

    Dealing colours in this order is what makes "no two neighbours match" mean
    anything spatially. Devices with no placement sort last, in config order —
    a room that was never laid out still gets a valid, if arbitrary, spread."""
    positions = ((config.get("room_layouts", {}) or {}).get(room_name) or {}).get("devices") or {}
    def sort_key(item):
        i, key = item
        p = positions.get(key)
        if not p:
            return (1, 0.0, 0.0, i)
        return (0, float(p.get("x", 0)), float(p.get("y", 0)), i)
    return [k for _, k in sorted(enumerate(keys), key=sort_key)]


def _gv_info_for_slug(slug: str):
    """(mac, info) from known_devices for a stored device slug, or (None, None)."""
    for mac, info in _known_govee().items():
        if gv_slug(mac) == slug:
            return mac, info
    return None, None


def gv_segment_count(slug: str, sku: Optional[str]) -> int:
    """How many segments this device is treated as having: the count configured
    for it (a 7-panel Hexa) beats the SKU's maximum (15). Mirrors the browser's
    `segCountForDevice` — the two MUST agree or a scheduled scene addresses a
    different number of segments than the same look applied by hand."""
    configured = (config.get("govee_segment_counts", {}) or {}).get(slug)
    if configured:
        return int(configured)
    return int((GOVEE_SEGMENT_INFO.get(sku) or {}).get("count") or 0)


def gv_scene_address(slug: str, sku: Optional[str]) -> str:
    """"segments" or "whole" — how a room scene paints this device (v3.18.0).

    THE single answer to that question, shared by the browser's scene apply and
    the scheduler's palette action. Before this existed the browser used a
    room-level toggle it kept to itself and the scheduler read `govee_segment_mode`
    (which only the LIGHTNING panel ever writes), so the same device could be
    painted per-segment by hand and as one colour on a schedule.

    A device with one segment is always "whole" regardless of what's stored —
    there is nothing to spread a palette across."""
    if gv_segment_count(slug, sku) <= 1:
        return "whole"
    stored = (config.get("govee_scene_address", {}) or {}).get(slug)
    return "whole" if stored == "whole" else "segments"


def _device_label(key: str, fallback: str) -> str:
    return (config.get("nicknames", {}) or {}).get(key) or fallback


def _build_palette_scene(room_name: str, palette: dict, brightness: int = 100,
                         rng=None):
    """Resolve a palette into a SceneApplyRequest for one room.

    Whether each Govee device is painted per-segment or as one colour comes from
    `gv_scene_address` — the SAME setting the Scenes panel writes — so a schedule
    fires the look the room is configured for rather than a second opinion.

    Returns None when the room has nothing addressable — the scheduler then logs
    and skips rather than firing an empty scene."""
    room = config.get("rooms", {}).get(room_name)
    if not room:
        return None
    colors = list(palette.get("colors") or [])
    if not colors:
        return None

    brightness = max(1, min(100, int(brightness)))
    dealer = _ColorDealer(colors, rng)

    hue_keys = [f"hue:{lid}" for lid in room.get("hue_light_ids", [])]
    govee_keys = [f"govee:{slug}" for slug in room.get("govee_devices", [])]
    ordered = _palette_device_order(room_name, hue_keys + govee_keys)

    bri254 = max(1, min(254, round(brightness * 254 / 100)))

    hue, govee_whole, razer, cloud, base_seeds = [], [], [], [], []

    for key in ordered:
        if key.startswith("hue:"):
            r, g, b = dealer.next()
            hue.append(SceneHueTarget(light_id=key[4:], on=True, r=r, g=g, b=b,
                                      brightness=bri254,
                                      label=_device_label(key, f"Light {key[4:]}")))
            continue

        slug = key[6:]
        mac, info = _gv_info_for_slug(slug)
        ip = (info or {}).get("ip") or gv_ip_for_slug(slug)
        if not ip:
            continue                      # never seen / gone — nothing to address
        sku = (info or {}).get("sku")
        label = _device_label(key, (info or {}).get("name") or slug)
        count = gv_segment_count(slug, sku)
        protocol = (GOVEE_SEGMENT_INFO.get(sku) or {}).get("protocol")

        if gv_scene_address(slug, sku) == "segments" and count > 0 and protocol:
            seg_colors = [dealer.next() for _ in range(count)]
            if protocol == "razer":
                razer.append(SceneRazer(ip=ip, mac=mac or slug, sku=sku,
                                        colors=[list(c) for c in seg_colors],
                                        brightness=brightness, label=label))
            else:
                # cloud_v2 is rate-limited, so segments are batched BY COLOUR —
                # one V2 call per distinct colour instead of one per segment.
                by_color: dict = {}
                for idx, c in enumerate(seg_colors):
                    by_color.setdefault(c, []).append(idx)
                cloud.append(SceneCloudDevice(
                    ip=ip, sku=sku, device_mac=mac or slug,
                    unit="panel" if sku == "H6061" else "segment", label=label,
                    groups=[SceneCloudGroup(segments=idxs, r=c[0], g=c[1], b=c[2])
                            for c, idxs in by_color.items()]))
                # Seed the whole strip with its own middle colour first, so it
                # reads as the scene immediately instead of flashing white while
                # the rate-limited segment calls trickle in.
                seed = seg_colors[len(seg_colors) // 2]
                base_seeds.append(SceneBaseSeed(ip=ip, mac=mac or slug,
                                                r=seed[0], g=seed[1], b=seed[2],
                                                brightness=brightness))
        else:
            r, g, b = dealer.next()
            govee_whole.append(SceneGoveeWhole(ip=ip, mac=mac or slug, on=True,
                                               r=r, g=g, b=b,
                                               brightness=brightness, label=label))

    if not (hue or govee_whole or razer or cloud):
        return None
    return SceneApplyRequest(room=room_name, brightness=brightness,
                             base_seeds=base_seeds, hue=hue, govee_whole=govee_whole,
                             razer=razer, cloud=cloud,
                             label=f"Palette · {palette['name']}")


async def _start_scene_apply(req):
    """Run a scene in the background, replacing any apply already running in that
    room. Two applies fighting over the same lights is the one thing worse than
    a slow one, so the outgoing task is awaited to completion after cancelling —
    it must have let go of the Govee socket before the new one grabs it."""
    existing = _scene_tasks.get(req.room)
    if existing and not existing.done():
        existing.cancel()
        try:
            await existing
        except BaseException:
            pass
    _scene_tasks[req.room] = asyncio.create_task(_run_scene_apply(req))
    return _scene_tasks[req.room]


async def _apply_room_palette(room_name: str, palette: dict, brightness: int = 100,
                              source: str = "app", source_detail: Optional[str] = None) -> bool:
    """Put one already-chosen palette on a room. The choice is made by the
    caller so that a ZONE gets one coherent palette across every member room
    rather than a different random one per room."""
    req = _build_palette_scene(room_name, palette, brightness)
    if req is None:
        log.warning("Palette action: room %r has no addressable devices, skipped", room_name)
        return False
    req.source = source
    req.source_detail = source_detail
    await _start_scene_apply(req)
    return True


async def _apply_room_power(room_name: str, on: bool,
                            source: str = "app", source_detail: Optional[str] = None):
    """Turn a whole room on (resume last state) or off, via the normal room
    control fan-out (Hue + Govee, incl. segment-clear on off)."""
    try:
        await control_room(RoomStateRequest(room_name=room_name, on=bool(on)))
        if source != "app":
            # control_room already recorded this, but as an in-app action. Restamp
            # it so the header credits the schedule that actually did it.
            record_room_applied(room_name, "power",
                                "Resumed last lighting" if on else "Turned off",
                                source=source, source_detail=source_detail)
    except HTTPException:
        log.warning("Scheduler: power action — room %r not found", room_name)


async def _apply_action_to_room(room: str, action: dict,
                                source: str = "app", source_detail: Optional[str] = None):
    """Fan a non-scene action (white / color / power) out to a single room.
    Shared by room-targeted and zone-targeted schedules."""
    atype = action.get("type")
    if atype == "white":
        await _apply_room_white(room, int(action.get("kelvin", 2700)),
                                int(action.get("brightness", 100)), source, source_detail)
    elif atype == "color":
        rgb = action.get("rgb") or {}
        await _apply_room_color(room, int(rgb.get("r", 255)), int(rgb.get("g", 255)),
                                int(rgb.get("b", 255)), int(action.get("brightness", 100)),
                                source, source_detail)
    elif atype == "power":
        await _apply_room_power(room, bool(action.get("on", True)), source, source_detail)


def _zone_rooms(zone_name: str, sched_name: str) -> list[str]:
    """Member rooms of a zone that still exist, with the missing ones logged."""
    z = (config.get("zones", {}) or {}).get(zone_name)
    if not z:
        log.warning("Scheduler: %r — zone %r not found, skipped", sched_name, zone_name)
        return []
    rooms = []
    for member in z.get("rooms", []):
        if member in config.get("rooms", {}):
            rooms.append(member)
        else:
            log.warning("Scheduler: %r — zone member %r missing, skipped", sched_name, member)
    return rooms


# schedule id → the palette it last chose, so the next fire can avoid an
# immediate repeat. Deliberately in memory only: persisting it would mean a
# config write (an SD-card write) every time a schedule fires, to protect
# against a repeat that only matters across a restart.
_last_palette_pick: dict[str, str] = {}


async def _fire_schedule(sched: dict):
    """Execute a due schedule's action, reusing the normal control paths.

    A scene action always targets one room (a scene is a device-specific
    snapshot). white / color / power / palette can target a single room OR a
    zone — a zone fans the same action out over every member room."""
    action = sched.get("action") or {}
    atype = action.get("type")
    room = action.get("room")
    zone = action.get("zone")
    name = sched.get("name") or sched.get("id")
    log.info("Scheduler: firing %r (action=%s room=%s zone=%s)", name, atype, room, zone)
    try:
        if atype == "scene":
            payload = _freshen_scene_payload(action.get("payload") or {})
            if payload is None:
                log.warning("Scheduler: %r — scene has no resolvable devices, skipped", name)
                return
            req = SceneApplyRequest(**payload)
            # Attribute the room's "Now showing" to this schedule rather than to
            # someone in the app. The snapshot may predate labels, hence the fallback.
            req.source = "schedule"
            req.source_detail = name
            if not req.label:
                req.label = "Scheduled scene"
            await _start_scene_apply(req)
        elif atype == "colors":
            # "My Colors": the colours are IN the schedule, so there's nothing to
            # choose between. Wrapped as a one-off palette so it goes through the
            # exact same builder — which is what makes alternating red/green come
            # out ABABAB down a hexa strip (see _ColorDealer) rather than needing
            # its own arrangement logic.
            colors = [tuple(int(v) for v in c)
                      for c in (action.get("colors") or [])
                      if isinstance(c, (list, tuple)) and len(c) == 3]
            if not colors:
                log.warning("Scheduler: %r — colours action has no colours, skipped", name)
                return
            chosen = {"name": action.get("label") or "My Colors",
                      "category": "custom", "featured": False, "colors": colors}
            targets = _zone_rooms(zone, name) if zone else [room]
            for target in targets:
                await _apply_room_palette(
                    target, chosen, brightness=int(action.get("brightness", 100)),
                    source="schedule", source_detail=name)
        elif atype == "palette":
            # Choose ONCE, then fan out: a zone on "random Summer palette" should
            # look like one decision across the house, not six unrelated ones.
            candidates = palettes.resolve_candidates(action)
            sid = sched.get("id") or name
            chosen = palettes.pick(candidates, avoid=_last_palette_pick.get(sid))
            if not chosen:
                log.warning("Scheduler: %r — palette action matched no palettes, skipped", name)
                return
            _last_palette_pick[sid] = chosen["name"]
            log.info("Scheduler: %r picked palette %r (%d candidate%s)",
                     name, chosen["name"], len(candidates), "" if len(candidates) == 1 else "s")
            targets = _zone_rooms(zone, name) if zone else [room]
            for target in targets:
                await _apply_room_palette(
                    target, chosen, brightness=int(action.get("brightness", 100)),
                    source="schedule", source_detail=name)
        elif atype in ("white", "color", "power"):
            if zone:
                for member in _zone_rooms(zone, name):
                    await _apply_action_to_room(member, action, "schedule", name)
            else:
                await _apply_action_to_room(room, action, "schedule", name)
        else:
            log.warning("Scheduler: %r — unknown action type %r", name, atype)
    except Exception:
        log.exception("Scheduler: %r failed to fire", name)


# ─── Paired on/off schedules (v3.27.0) ───────────────────────────────────────
# One entry that turns lights ON and later turns them OFF: "sunset−10 until
# sunrise+10", or "10am for 90 minutes". Previously that took two schedules,
# which can silently drift apart — retarget one, forget the other, and the lights
# stay on all day with nothing to flag it.
#
# The end is ARMED BY THE START rather than scheduled independently. When the
# start fires, the end is resolved to an absolute datetime and stored in
# `end_due`; each tick fires anything now due. That choice does a lot of work:
#
#   - Overnight spans need no special handling. An independently-scheduled end
#     would have to answer "does Monday mean it STARTS Monday, or must be off
#     during Monday?" for every sunset→sunrise pair. Armed, the question can't
#     arise: days-of-week apply to the start, and the end is simply "later".
#   - It survives a restart, because `end_due` is persisted. A Pi that reboots at
#     2am still turns the porch off at sunrise — which is the durability case
#     that actually matters.
#   - A start that never fired arms nothing, so no stray "off" arrives for a span
#     that never began.
#
# A due end DOES fire late (unlike a missed start, which is skipped — waking to a
# 7am scene at 9am is worse than nothing). Turning lights off late is both
# harmless and what you wanted. **If the end action ever becomes configurable
# beyond "off", revisit that**: catching up on a colour change hours later is the
# behaviour the no-catch-up rule exists to prevent.

def _resolve_end_due(sched: dict, started: "datetime", location: dict,
                     sun_resolver=None) -> Optional[str]:
    """Absolute wall-clock moment this schedule's span should end, as
    'YYYY-MM-DD HH:MM'. None when the schedule has no end.

    PURE apart from the sun lookup, which is injectable for the same reason
    _schedule_due's is: astral is imported lazily so the module loads on a dev
    box without it, and a test there would otherwise silently get None."""
    from datetime import timedelta
    end = sched.get("end") or {}
    etype = end.get("type")

    if etype == "after":
        mins = int(end.get("after_minutes") or 0)
        if mins <= 0:
            return None
        return (started + timedelta(minutes=mins)).strftime("%Y-%m-%d %H:%M")

    if etype == "weekly":
        # _parse_hhmm always returns a tuple, signalling bad input with -1.
        hm = _parse_hhmm(end.get("time"))
        if hm[0] < 0:
            return None
        cand = started.replace(hour=hm[0], minute=hm[1], second=0, microsecond=0)
        if cand <= started:
            cand += timedelta(days=1)      # a clock time already past means tomorrow
        return cand.strftime("%Y-%m-%d %H:%M")

    if etype == "sun":
        lat, lng = (location or {}).get("lat"), (location or {}).get("lng")
        if lat is None or lng is None:
            log.warning("Schedule end: sun end needs a location, ignoring")
            return None
        # Today's occurrence may already have passed (a sunset start ending at
        # sunrise), so walk forward until it's in the future.
        resolver = sun_resolver or (lambda ev, dt, off: _sun_hhmm(ev, dt, lat, lng, off))
        for day_offset in (0, 1, 2):
            d = (started + timedelta(days=day_offset)).date()
            hm = resolver(end.get("event", "sunrise"), d,
                          int(end.get("offset_min", 0) or 0))
            # Don't trust the tuple blindly: an out-of-range minute would raise
            # out of the scheduler tick. _sun_hhmm normalises via timedelta, so
            # this only bites on a bad resolver — skip rather than throw.
            if not hm or not (0 <= hm[0] <= 23 and 0 <= hm[1] <= 59):
                continue
            cand = started.replace(year=d.year, month=d.month, day=d.day,
                                   hour=hm[0], minute=hm[1], second=0, microsecond=0)
            if cand > started:
                return cand.strftime("%Y-%m-%d %H:%M")
    return None


def _start_hhmm_on(sched: dict, d, location: dict = None, sun_resolver=None):
    """(hour, minute) this schedule's START lands on the date `d`, or None if it
    has no occurrence that day. PURE (the sun lookup is injectable).

    This is `_schedule_due` asked the other way round — "when today?" rather than
    "is it now?" — and the two MUST agree on day filtering: weekly requires an
    explicit day list, while an empty `days` on a sun trigger means every day."""
    trig = sched.get("trigger") or {}
    ttype = trig.get("type")

    if ttype == "weekly":
        if d.weekday() not in (trig.get("days") or []):
            return None
        hm = _parse_hhmm(trig.get("time"))
        return hm if hm[0] >= 0 else None

    if ttype == "oneoff":
        if trig.get("date") != d.strftime("%Y-%m-%d"):
            return None
        hm = _parse_hhmm(trig.get("time"))
        return hm if hm[0] >= 0 else None

    if ttype == "sun":
        days = trig.get("days")
        if days and d.weekday() not in days:
            return None
        lat, lng = (location or {}).get("lat"), (location or {}).get("lng")
        if lat is None or lng is None:
            return None
        resolver = sun_resolver or (lambda ev, dt, off: _sun_hhmm(ev, dt, lat, lng, off))
        hm = resolver(trig.get("event", "sunrise"), d, int(trig.get("offset_min", 0) or 0))
        # Same defensive range check as _resolve_end_due: a bad resolver must not
        # throw out of the scheduler tick.
        if not hm or not (0 <= hm[0] <= 23 and 0 <= hm[1] <= 59):
            return None
        return hm

    return None


def _active_span(sched: dict, now, location: dict = None, sun_resolver=None):
    """Should this schedule's span be RUNNING at `now`? Returns
    `(started_datetime, end_due_str)` for the most recent start occurrence whose
    end is still in the future, else None. PURE.

    Only schedules with an `end` can have a span — a schedule that just fires at a
    moment has no "should be running" state to be wrong about."""
    from datetime import timedelta
    if not sched.get("enabled") or not (sched.get("end") or {}).get("type"):
        return None
    for back in range(0, SPAN_CATCHUP_LOOKBACK_DAYS + 1):
        d = (now - timedelta(days=back)).date()
        hm = _start_hhmm_on(sched, d, location, sun_resolver)
        if not hm:
            continue
        started = now.replace(year=d.year, month=d.month, day=d.day,
                              hour=hm[0], minute=hm[1], second=0, microsecond=0)
        if started > now:
            continue                      # today's occurrence hasn't arrived yet
        # The MOST RECENT start is the only one that can still be running, so this
        # answers for it and stops — an older one is necessarily already over.
        end_due = _resolve_end_due(sched, started, location, sun_resolver)
        if not end_due:
            return None
        # 'YYYY-MM-DD HH:MM' sorts chronologically, and the loop fires an end when
        # now >= end_due — so the span is live while now is strictly before it.
        return (started, end_due) if now.strftime("%Y-%m-%d %H:%M") < end_due else None
    return None


async def _fire_schedule_end(sched: dict):
    """The OFF half of a paired schedule — same target as the start."""
    action = sched.get("action") or {}
    name = sched.get("name") or sched.get("id")
    zone, room = action.get("zone"), action.get("room")
    log.info("Scheduler: ending %r (room=%s zone=%s)", name, room, zone)
    try:
        targets = _zone_rooms(zone, name) if zone else ([room] if room else [])
        for target in targets:
            await _apply_room_power(target, False, "schedule", f"{name} (end)")
    except Exception:
        log.exception("Scheduler: %r failed to end", name)


async def _scheduler_loop():
    """Wake ~once a minute (aligned to the top of the minute) and fire due
    schedules. Wakes instantly on shutdown via the stop event."""
    global _scheduler_stop
    _scheduler_stop = asyncio.Event()
    from datetime import datetime
    log.info("Scheduler started")
    try:
        # Drive nothing until power recovery has finished. On a normal restart or
        # deploy `_recovery_done` is already set, so this costs nothing; on an
        # OUTAGE boot it holds the first tick until the bridge and the Govee
        # devices are actually back on the LAN.
        #
        # Without it the first tick ran IMMEDIATELY — ~45s before
        # RECOVERY_SETTLE_S, the delay that exists precisely because the network
        # isn't up yet. An overdue end therefore fired into the void, cleared its
        # `end_due`, and then recovery replayed the pre-outage look with no idea
        # the span had ended. Worked example: a room set green 09:00–10:00, power
        # out 09:30, back 10:15. The 10:00 off fired at 10:16 against a Hue bridge
        # that was still rebooting; `set_hue_light_state` failed, so
        # `record_hue_state` (success-gated) never recorded it, so recovery
        # restored GREEN a minute later — and with `end_due` already consumed,
        # nothing would ever turn it off again.
        #
        # Ordering it after recovery fixes both halves: the late off reaches live
        # devices, and it lands AFTER the resume, so it corrects the restored look
        # instead of being clobbered by it. The room shows the old look for a few
        # seconds first — correct beats flicker-free.
        #
        # A start that falls due inside the settle window is simply skipped, per
        # the no-catch-up rule; firing it at a dead bridge would only look like it
        # ran. Spans are covered by _catch_up_spans, which waits on the same event.
        if _recovery_done is not None and not _recovery_done.is_set():
            log.info("Scheduler: holding the first tick until power recovery finishes")
            try:
                await asyncio.wait_for(_recovery_done.wait(), timeout=RECOVERY_WAIT_MAX_S)
            except asyncio.TimeoutError:
                log.warning("Scheduler: power recovery still running after %ds — "
                            "ticking anyway", RECOVERY_WAIT_MAX_S)
        while not _scheduler_stop.is_set():
            now = datetime.now()   # Pi runs in the user's local timezone
            location = config.get("location", {}) or {}
            fired = False
            for sched in list(config.get("schedules", []) or []):
                try:
                    # Checked BEFORE (and independently of) the start, and without
                    # consulting `enabled` — because disabling or retiming clears
                    # end_due at save time, so an armed end reaching here means the
                    # span really is still running. Fires late if the Pi was down
                    # through the moment: an off is idempotent and still wanted.
                    due = sched.get("end_due")
                    if due and now.strftime("%Y-%m-%d %H:%M") >= due:
                        await _fire_schedule_end(sched)
                        sched["end_due"] = None
                        sched["end_last_fired"] = now.strftime("%Y-%m-%d %H:%M")
                        fired = True

                    if _schedule_due(sched, now, location):
                        await _fire_schedule(sched)
                        sched["last_fired"] = now.strftime("%Y-%m-%d %H:%M")
                        # Arm the OFF half, if this schedule has one.
                        end_due = _resolve_end_due(sched, now, location)
                        if end_due:
                            sched["end_due"] = end_due
                            log.info("Scheduler: %r will turn off at %s",
                                     sched.get("name") or sched.get("id"), end_due)
                        if (sched.get("trigger") or {}).get("type") == "oneoff":
                            sched["enabled"] = False   # one-off: fire once, then off
                        fired = True
                except Exception:
                    log.exception("Scheduler: error on schedule %s", sched.get("id"))
            if fired:
                schedule_save()
                publish_event("config")
            # Sleep to just past the top of the next minute; wake early on stop.
            delay = 60 - datetime.now().second + 0.5
            try:
                await asyncio.wait_for(_scheduler_stop.wait(), timeout=delay)
            except asyncio.TimeoutError:
                pass
    except asyncio.CancelledError:
        pass
    finally:
        log.info("Scheduler stopped")


async def _catch_up_spans():
    """Re-enter, once at startup, any paired schedule whose span should be
    RUNNING right now — and re-arm its end.

    A missed START is normally skipped on purpose ("no catch-up": waking to a 7am
    scene at 9am is worse than nothing). **But a span is not a moment.** "On at
    sunset, off at sunrise" describes an interval that is either currently true or
    not, and the Pi being down through its first minute doesn't make it untrue.

    This is the exact hole that lost a whole night: an outage spanning sunset meant
    the start never fired, so `end_due` was never armed, so the sunrise OFF had
    nothing to fire either — the lights were left to whatever a human did in the
    meantime, all day. Both halves are fixed here, because arming the end IS the
    fix for the missing off.

    Two guards keep it from re-firing things that are fine:
      - **`end_due` already set ⇒ skip.** A span that fired normally and merely
        outlived a deploy restart is already armed and needs nothing. That single
        check is what makes this safe to run on *every* process start rather than
        only after an outage.
      - **`last_fired` already at this occurrence ⇒ arm the end, don't re-fire.**
        The start did happen; only the end went missing (a save clears it). The
        lights are already in the span, so re-applying would just re-roll a
        random palette for no reason.

    It runs AFTER power recovery (which is why it waits on `_recovery_done`) so an
    outage boot lands in this order: recovery restores/forces-off, then the
    schedule that explicitly covers this hour gets the last word. A generic
    "stay off overnight" policy must not beat "the porch is on until sunrise"."""
    from datetime import datetime
    if _recovery_done is not None:
        try:
            await asyncio.wait_for(_recovery_done.wait(), timeout=RECOVERY_WAIT_MAX_S)
        except asyncio.TimeoutError:
            log.warning("Span catch-up: power recovery still running after %ds — "
                        "proceeding anyway", RECOVERY_WAIT_MAX_S)
    now = datetime.now()   # Pi runs in the user's local timezone
    location = config.get("location", {}) or {}
    changed = False
    for sched in list(config.get("schedules", []) or []):
        name = sched.get("name") or sched.get("id")
        try:
            if sched.get("end_due"):
                continue                      # already armed — it survived the restart
            span = _active_span(sched, now, location)
            if not span:
                continue
            started, end_due = span
            stamp = started.strftime("%Y-%m-%d %H:%M")
            if sched.get("last_fired") == stamp:
                log.info("Span catch-up: %r already started at %s but lost its end — "
                         "re-arming the off for %s", name, stamp, end_due)
            else:
                log.info("Span catch-up: %r should have started at %s and runs until "
                         "%s — starting it now", name, stamp, end_due)
                await _fire_schedule(sched)
                sched["last_fired"] = stamp   # the OCCURRENCE, not now: it's the truth
            sched["end_due"] = end_due
            changed = True
        except Exception:
            log.exception("Span catch-up: error on schedule %s", sched.get("id"))
    if changed:
        schedule_save()
        publish_event("config")


# ─── App ─────────────────────────────────────────────────────────────────────

def reload_segment_state():
    """Rehydrate the in-memory segment store from config.

    config's segment_state is mac-slug keyed; the in-memory store is IP-keyed
    (that's the live address). Resolve slug→current IP on load (persist maps back).
    Shared by startup and config import so the two can't drift apart."""
    raw = config.get("segment_state", {}) or {}
    resolved = {}
    for k, v in raw.items():
        if k.startswith("govee:"):
            ip = gv_ip_for_slug(k[len("govee:"):])
            if ip:
                resolved[f"govee:{ip}"] = v
        else:
            resolved[k] = v
    segment_state.load(resolved)


@asynccontextmanager
async def lifespan(app: FastAPI):
    print("🔆 LightEmUp starting up...")
    reload_segment_state()

    # Was our last stop clean (planned reboot) or abrupt (power outage)? Consume
    # the marker now so a later outage — which won't run the shutdown hook — is
    # seen as unclean. Written again in the shutdown hook below.
    _clean_shutdown = SHUTDOWN_MARKER.exists()
    try:
        SHUTDOWN_MARKER.unlink()
    except FileNotFoundError:
        pass
    except Exception:
        log.exception("Could not clear clean-shutdown marker")

    # Power-recovery: on a genuine fresh boot, gracefully resume or force-off the
    # lights. Skip on a normal deploy/service restart (machine up for a while) so
    # we never disturb lights that are intentionally on.
    global _recovery_done
    _recovery_done = asyncio.Event()
    _uptime = _system_uptime_s()
    if _uptime is not None and _uptime <= FRESH_BOOT_MAX_UPTIME_S:
        log.info("Fresh boot detected (uptime %.0fs, clean_shutdown=%s) — scheduling power recovery",
                 _uptime, _clean_shutdown)
        asyncio.create_task(_recover_then_release(_clean_shutdown))
    else:
        log.info("Not a fresh boot (uptime=%s) — skipping power recovery",
                 f"{_uptime:.0f}s" if _uptime is not None else "unknown")
        _recovery_done.set()

    # Time-based scheduler: fires room scenes / white / color at wall-clock times.
    global _scheduler_task, _catchup_task
    _scheduler_task = asyncio.create_task(_scheduler_loop())
    # One-shot: re-enter any on/off span that should be running right now (an
    # outage across its start would otherwise lose BOTH halves — see _catch_up_spans).
    _catchup_task = asyncio.create_task(_catch_up_spans())

    yield

    # Stop the scheduler loop promptly (it also honors CancelledError).
    if _scheduler_stop is not None:
        _scheduler_stop.set()
    if _scheduler_task is not None:
        _scheduler_task.cancel()
    if _catchup_task is not None:
        _catchup_task.cancel()   # may still be waiting on power recovery

    # Mark this as a clean stop FIRST (before the flush, which could be slow), so
    # even if shutdown is force-killed after SIGTERM the marker is already down —
    # the next boot then knows this was a planned stop, not an outage.
    try:
        SHUTDOWN_MARKER.write_text(_now_iso())
    except Exception:
        log.exception("Could not write clean-shutdown marker")
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


def _govee_cached_devices():
    """Build the Govee device list from persisted ``known_devices`` + last-known
    ``device_state`` with **no LAN scan** — instant. Used for the fast initial
    paint; the client follows up with the live ``/discover/govee`` in the
    background to refresh reachability + live state. Devices are optimistically
    marked responding (assume-presence, v2.16.0); the live scan corrects any that
    are actually offline. Mirrors the render-ready shape of the live endpoint."""
    known = _known_govee()
    device_state = config.get("device_state", {})
    devices = []
    for mac, entry in known.items():
        sku = entry.get("sku")
        dev = {
            "ip": entry.get("ip"),
            "device": mac,
            "mac": mac,
            "sku": sku,
            "type": "govee",
            "name": entry.get("name") or sku or "Govee Device",
            "capabilities": {"has_color": True, "has_brightness": True, "has_segments": False},
            "responding": True,
            "last_seen": entry.get("last_seen"),
            "state": {"on": None, "brightness": None, "reachable": True},
        }
        stored = device_state.get(gv_key(mac))
        if stored:
            st = dev["state"]
            if stored.get("r") is not None and stored.get("g") is not None and stored.get("b") is not None:
                st["color"] = {"r": stored["r"], "g": stored["g"], "b": stored["b"]}
            elif stored.get("color_temp_kelvin") is not None:
                st["color_temp"] = stored["color_temp_kelvin"]
            if stored.get("on") is not None:
                st["on"] = stored["on"]
            if stored.get("brightness") is not None:
                st["brightness"] = stored["brightness"]
        devices.append(dev)
    return devices


@app.get("/api/discover/govee/cached")
async def discover_govee_cached():
    """Instant Govee device list from cache (no LAN scan) for the fast initial
    paint. The client renders these immediately, then calls the live
    ``/discover/govee`` in the background to refresh reachability + state."""
    return {"devices": _govee_cached_devices(), "missing": []}


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
    if success:
        record_hue_state(req.light_id, state)  # last-known, for power recovery
        # Verify discrete actions only. Presence of `on` is an exact proxy for
        # "settled click" in this UI: the card's toggle sends {on}, a colour/CT
        # pick sends {on:true, …}, while the brightness and colour-wheel DRAGS
        # send {brightness} / {r,g,b} with no `on`. Drags commit every 180ms
        # (useThrottledControl), so verifying those would mean a GET per tick.
        # Bulk callers opt out — they register one batch for the whole run.
        if "on" in state and not _in_bulk_hue.get():
            schedule_hue_verify({req.light_id: state})
    publish_event("hue", key=f"hue:{req.light_id}")
    # `state` is echoed back so bulk callers can collect exactly what was sent and
    # hand it to schedule_hue_verify (which re-sends this dict verbatim on a miss).
    return {"success": success, "state": state}


# ─── Hue verify-and-repair ──────────────────────────────────────────────────
# The bridge returns HTTP 200 as soon as it QUEUES a command, so a Zigbee
# delivery failure downstream is completely invisible at the HTTP layer — the
# classic symptom is one lamp in a room staying on after "all off" while every
# PUT logged 200. Retrying on a non-200 therefore fixes nothing; you have to read
# the state back: ONE GET of all lights (a single request regardless of light
# count), then re-send only to the lights that didn't take.
HUE_VERIFY_SETTLE_S = 0.6      # let the mesh apply before reading back
HUE_VERIFY_BRI_TOLERANCE = 3   # bridge rounds brightness; don't chase 1-2 off

# Verification is COALESCED: callers register expectations here rather than each
# spawning its own read-back, and a single drain task services them. Without this,
# a room press that fans out client-side through /api/hue/light (app.js does
# exactly that for room + "Unassigned" controls) would cost one GET per light.
# Now any number of commands landing within a settle window share ONE GET.
_hue_verify_pending: dict = {}
_hue_verify_task: Optional[asyncio.Task] = None


def schedule_hue_verify(expectations: dict):
    """Queue {light_id: state_as_sent} for read-back. Cheap and synchronous —
    merges into the pending map and ensures the drain task is running. A later
    expectation for the same light wins (it's the more recent intent)."""
    global _hue_verify_task
    if not expectations:
        return
    if not config.get("hue_bridge_ip") or not config.get("hue_username"):
        return
    _hue_verify_pending.update({str(k): v for k, v in expectations.items()})
    if _hue_verify_task is None or _hue_verify_task.done():
        _hue_verify_task = asyncio.create_task(_hue_verify_drain())


async def _hue_verify_drain(settle_s: float = HUE_VERIFY_SETTLE_S):
    """Wait out the settle, then verify everything queued in one pass. Loops so
    commands that arrive *during* a pass get their own pass rather than being
    dropped — but still only one GET per settle window."""
    try:
        while _hue_verify_pending:
            await asyncio.sleep(settle_s)
            batch = dict(_hue_verify_pending)
            _hue_verify_pending.clear()
            await _hue_verify_repair(batch)
    except asyncio.CancelledError:
        pass
    except Exception:
        log.exception("Hue verify drain failed")


# How long after an apply a stored expectation may still be reconciled against
# what the bridge actually settled on. Deliberately short — see below.
EXPECT_RECONCILE_WINDOW_S = 45


def _reconcile_expectations(actual: dict) -> bool:
    """Replace "the colour we asked for" with "the colour the bridge settled on"
    in any JUST-WRITTEN room record. Returns True if anything changed.

    The bridge gamut-clamps. Ask an outdoor bulb for a saturated cyan and it
    reports back the nearest colour it can physically make, and for a hard clamp
    that lands well outside HUE_XY_TOLERANCE — one of Dan's Front Door lights was
    asked for xy [0.184, 0.284] and settled at [0.157, 0.379], a dy of 0.095.
    Comparing later against what we ASKED for then declares the room changed
    forever, minutes after LightEmUp itself set it. That's the precise false
    alarm this whole feature exists in order not to raise, and loosening the
    tolerance enough to swallow it (~0.12) would let a genuinely different colour
    hide inside it. Comparing against what the bridge SETTLED ON fixes it exactly
    and costs nothing: these lights were just read for the verify.

    STRICTLY bounded to records written moments ago. Reconciling an old record
    would quietly rewrite the evidence that something else changed the room —
    erasing divergence rather than reporting it, which is far worse than the bug
    it fixes. Same reason a light whose brightness didn't take is skipped: a
    repair is in flight, and baking in the wrong state would hide the miss."""
    from datetime import datetime
    now = datetime.now().astimezone()
    changed = False
    for entry in (config.get("room_last_applied", {}) or {}).values():
        expect = entry.get("expect_hue")
        if not expect:
            continue
        try:
            when = datetime.fromisoformat(entry.get("at") or "")
        except (ValueError, TypeError):
            continue
        if abs((now - when).total_seconds()) > EXPECT_RECONCILE_WINDOW_S:
            continue
        for light_id, sent in expect.items():
            cur = actual.get(str(light_id))
            if not cur or not cur.get("reachable", True) or not cur.get("on"):
                continue
            if sent.get("on") is False:
                continue
            want_bri = sent.get("bri")
            if want_bri is not None and \
                    abs(int(cur.get("brightness") or 0) - int(want_bri)) > HUE_VERIFY_BRI_TOLERANCE:
                continue
            mode = cur.get("color_mode")
            cxy = cur.get("xy")
            if "xy" in sent and mode == "xy" and isinstance(cxy, (list, tuple)) and len(cxy) == 2:
                settled = [round(float(cxy[0]), 4), round(float(cxy[1]), 4)]
                if settled != list(sent["xy"]):
                    log.info("Expectation reconciled: light %s asked xy %s, bridge settled %s",
                             light_id, sent["xy"], settled)
                    sent["xy"] = settled
                    changed = True
            elif "ct" in sent and mode == "ct" and cur.get("color_temp") is not None:
                if int(cur["color_temp"]) != int(sent["ct"]):
                    sent["ct"] = int(cur["color_temp"])
                    changed = True
    return changed


async def _hue_verify_repair(expectations: dict):
    """expectations: {light_id: state_dict_as_sent}. Re-sends to any light whose
    reported state disagrees with what we asked for. Assumes the caller has
    already waited for the mesh to settle.

    Only `on` and `bri` are compared. Color (xy/ct) is deliberately NOT checked:
    the bridge gamut-clamps and rounds it, so an exact comparison would report
    permanent false mismatches and re-send forever."""
    if not expectations:
        return
    ip = config.get("hue_bridge_ip")
    username = config.get("hue_username")
    if not ip or not username:
        return
    try:
        lights = await get_hue_lights(ip, username)
        actual = {l["id"]: l.get("state", {}) for l in lights}

        # Free ride on the read we just did: pin any just-written expectation to
        # the colour the bridge actually settled on, so gamut clamping can't read
        # as divergence five minutes later.
        if _reconcile_expectations(actual):
            save_config(config)

        repaired = []
        for light_id, sent in expectations.items():
            cur = actual.get(str(light_id))
            if not cur or not cur.get("reachable", True):
                continue   # unreachable/unknown: a re-send won't land either
            want_on = sent.get("on")
            if want_on is not None and bool(cur.get("on")) != bool(want_on):
                repaired.append(light_id)
                continue
            # Brightness only matters while the light is on.
            want_bri = sent.get("bri")
            if want_bri is not None and cur.get("on") and want_on is not False:
                if abs(int(cur.get("brightness") or 0) - int(want_bri)) > HUE_VERIFY_BRI_TOLERANCE:
                    repaired.append(light_id)

        for light_id in repaired:
            log.info("Hue verify: light %s didn't take — re-sending", light_id)
            try:
                await set_hue_light_state(ip, username, str(light_id), expectations[light_id])
            except Exception as e:
                log.warning("Hue verify: re-send failed for %s: %s", light_id, e)
        if repaired:
            publish_event("config")
    except Exception:
        log.exception("Hue verify-and-repair failed")


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
    for key in ("room_layouts", "room_color_state", "lightning_scenes", "room_presets",
                "room_last_applied"):
        d = config.get(key)
        if isinstance(d, dict) and room_name in d:
            del d[room_name]
            removed = True
    # Drop the room from any zone it belonged to (membership is by name).
    for zone in (config.get("zones", {}) or {}).values():
        members = zone.get("rooms", [])
        if room_name in members:
            zone["rooms"] = [r for r in members if r != room_name]
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
    hue_sent = {}
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
            if success:
                record_hue_state(str(light_id), state)  # last-known, for power recovery
                hue_sent[str(light_id)] = state
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

    # Read the Hue lights back and repair any that silently didn't take. The
    # drain runs as a background task so the caller isn't held for the settle.
    schedule_hue_verify(hue_sent)

    # Note what the room is now showing. A brightness-ONLY call is deliberately not
    # recorded: that's the room slider, which fires repeatedly while dragging and
    # would otherwise churn the record (and overwrite the scene name) on every tick.
    if req.on is False:
        record_room_applied(req.room_name, "power", "Turned off", expect=hue_sent)
    elif req.r is not None and req.g is not None and req.b is not None:
        record_room_applied(req.room_name, "color", "Solid color",
                            swatches=[[req.r, req.g, req.b]], expect=hue_sent)
    elif req.on is True and req.brightness is None:
        # "Resume" sends only {on:true}; each light returns to whatever it
        # remembers, so there's nothing to compare later — record no expectation
        # rather than a misleading one.
        record_room_applied(req.room_name, "power", "Resumed last lighting")

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
    if success:
        record_room_applied(req.room_name, "lightning", "Lightning storm")
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
    # If a storm is running in this room, live-apply the changed settings so the
    # user's tweaks take effect without stopping the storm (see update_settings for
    # what applies live vs. on next start).
    applied_live = scene_manager.update_settings(req.room_name, updates)
    return {"success": True, "settings": existing, "applied_live": applied_live}


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


# ─── Phantom Hue lights (v3.23.0) ────────────────────────────────────────────
# A light re-paired to the bridge comes back with a NEW id, and the old one stays
# in every room / layout / nickname forever. It can never be reached, and the
# divergence check has to report it as "unknown" for the rest of time — which is
# how Exterior Front ended up listing four lights when only two exist.
#
# The bridge's light list is AUTHORITATIVE for Hue, which is what makes this
# detectable at all — and it's the opposite of the Govee rule, where discovery is
# lossy and absence proves nothing (see "assume presence"). Note "absent from the
# list" is not the same as `reachable: false`: a Hue light on a flipped wall
# switch is still LISTED, just unreachable, and must never be pruned.
#
# Detection is automatic; deletion is not. See the endpoints below for why.

def _hue_phantoms(live_ids: set) -> dict:
    """room name → [light_id, …] that the room claims but the bridge doesn't have."""
    out = {}
    for room_name, room in (config.get("rooms", {}) or {}).items():
        missing = [str(i) for i in room.get("hue_light_ids", []) if str(i) not in live_ids]
        if missing:
            out[room_name] = missing
    return out


def _purge_hue_light(light_id: str) -> list[str]:
    """Remove every trace of one Hue light. Returns what was touched, for the
    caller's report — a prune that doesn't say what it removed is a prune you
    can't check afterwards."""
    lid, key = str(light_id), f"hue:{light_id}"
    touched = []

    for room_name, room in (config.get("rooms", {}) or {}).items():
        ids = room.get("hue_light_ids", [])
        kept = [i for i in ids if str(i) != lid]
        if len(kept) != len(ids):
            room["hue_light_ids"] = kept
            touched.append(f"room:{room_name}")

    for store in ("nicknames", "device_modes", "ct_correction", "ct_rgb"):
        if (config.get(store) or {}).pop(key, None) is not None:
            touched.append(store)
    if (config.get("hue_missing_since") or {}).pop(lid, None) is not None:
        touched.append("hue_missing_since")

    for layout_name, layout in (config.get("room_layouts", {}) or {}).items():
        for sub in ("devices", "segments"):
            if (layout.get(sub) or {}).pop(key, None) is not None:
                touched.append(f"layout:{layout_name}.{sub}")

    for fx_id, fx in (config.get("fixtures", {}) or {}).items():
        members = fx.get("members") or []
        kept = [m for m in members if m != key]
        if len(kept) != len(members):
            fx["members"] = kept
            touched.append(f"fixture:{fx_id}")

    for room_name, entry in (config.get("room_last_applied", {}) or {}).items():
        if (entry.get("expect_hue") or {}).pop(lid, None) is not None:
            touched.append(f"expect:{room_name}")
        # Also drop it from the stored re-apply payload, or "Set here" would keep
        # trying to drive a light that no longer exists.
        payload = entry.get("payload") or {}
        hue_list = payload.get("hue")
        if isinstance(hue_list, list):
            kept = [h for h in hue_list if str(h.get("light_id")) != lid]
            if len(kept) != len(hue_list):
                payload["hue"] = kept
                touched.append(f"payload:{room_name}")

    return touched


# A device missing this long has almost certainly been unplugged, re-paired or
# thrown away — as opposed to being briefly off the network, which is routine and
# already shown as "not responding". Five days is long enough to survive a
# holiday-weekend router swap without nagging.
STALE_MISSING_DAYS = 5


def _track_hue_missing(live_ids: set) -> bool:
    """Maintain `hue_missing_since` — the date each room-claimed Hue id was FIRST
    seen to be absent from the bridge. Returns True if anything changed.

    Only ever called with an authoritative bridge read (see the guards in
    get_hue_phantoms), so a bridge that's down records nothing rather than
    starting a five-day clock on every light in the house. If the app simply
    isn't opened for a week the clock starts late — under-reporting, which is the
    safe direction for something whose only action is "suggest deleting"."""
    from datetime import date
    store = config.setdefault("hue_missing_since", {})
    today = date.today().isoformat()
    claimed = {str(i) for room in (config.get("rooms", {}) or {}).values()
               for i in room.get("hue_light_ids", [])}
    changed = False
    for lid in claimed:
        if lid in live_ids:
            if store.pop(lid, None) is not None:
                changed = True          # it came back — reset the clock entirely
        elif lid not in store:
            store[lid] = today
            changed = True
    for lid in list(store):             # no longer claimed by any room
        if lid not in claimed:
            store.pop(lid, None)
            changed = True
    return changed


def _days_since(iso: Optional[str]) -> Optional[int]:
    from datetime import date, datetime
    if not iso:
        return None
    try:
        d = datetime.fromisoformat(iso).date() if len(iso) > 10 else date.fromisoformat(iso)
    except (ValueError, TypeError):
        return None
    return max(0, (date.today() - d).days)


@app.get("/api/devices/stale")
async def get_stale_devices():
    """Devices missing long enough to be worth removing, Hue and Govee together.

    Pure config reads — the clocks are maintained elsewhere (`hue_missing_since`
    on an authoritative bridge read, `known_devices.govee[*].last_seen` on each
    scan). That matters: it means a bridge or network that's down right now can
    never manufacture a stale device, because nothing here consults the network."""
    out = []
    room_of = {}
    for room_name, room in (config.get("rooms", {}) or {}).items():
        for lid in room.get("hue_light_ids", []):
            room_of[f"hue:{lid}"] = room_name
        for slug in room.get("govee_devices", []):
            room_of[f"govee:{slug}"] = room_name

    nicknames = config.get("nicknames", {}) or {}
    for lid, since in (config.get("hue_missing_since", {}) or {}).items():
        days = _days_since(since)
        if days is not None and days >= STALE_MISSING_DAYS:
            out.append({"kind": "hue", "key": f"hue:{lid}", "light_id": lid,
                        "name": nicknames.get(f"hue:{lid}") or f"Light {lid}",
                        "room": room_of.get(f"hue:{lid}"), "since": since, "days": days})

    for mac, info in _known_govee().items():
        slug = gv_slug(mac)
        days = _days_since(info.get("last_seen"))
        if days is not None and days >= STALE_MISSING_DAYS:
            out.append({"kind": "govee", "key": f"govee:{slug}", "mac": mac, "slug": slug,
                        "name": nicknames.get(f"govee:{slug}") or info.get("name") or info.get("sku") or slug,
                        "room": room_of.get(f"govee:{slug}"),
                        "since": info.get("last_seen"), "days": days})

    out.sort(key=lambda d: -d["days"])
    return {"threshold_days": STALE_MISSING_DAYS, "count": len(out), "devices": out}


@app.get("/api/hue/phantoms")
async def get_hue_phantoms():
    """Rooms listing Hue lights the bridge doesn't have. Read-only.

    Returns `ok: false` and prunes NOTHING when the bridge can't be read or
    reports an empty list — a bridge that's briefly down, or has just been
    factory reset, would otherwise look like "every light is a phantom", and
    acting on that would wipe every room in the house."""
    ip, username = config.get("hue_bridge_ip"), config.get("hue_username")
    if not ip or not username:
        return {"ok": False, "reason": "no bridge paired", "phantoms": {}}
    try:
        lights = await get_hue_lights(ip, username)
    except Exception as e:
        return {"ok": False, "reason": f"bridge unreachable ({e})", "phantoms": {}}
    if not lights:
        return {"ok": False, "reason": "bridge reported no lights at all", "phantoms": {}}

    live = {str(l["id"]) for l in lights}
    # This GET has one side effect on purpose: it's the only place with an
    # authoritative bridge read AND the guards above, so it's where the
    # missing-since clock is kept honest. Writes only when something changed.
    if _track_hue_missing(live):
        save_config(config)

    phantoms = _hue_phantoms(live)
    since = config.get("hue_missing_since", {}) or {}
    return {
        "ok": True,
        "live_count": len(live),
        "threshold_days": STALE_MISSING_DAYS,
        "phantoms": {room: [{"light_id": i,
                             "nickname": (config.get("nicknames", {}) or {}).get(f"hue:{i}"),
                             "since": since.get(i),
                             "days": _days_since(since.get(i))}
                            for i in ids]
                     for room, ids in phantoms.items()},
    }


class HuePhantomRemoveRequest(BaseModel):
    light_ids: list[str] = []      # empty = every phantom currently detected
    dry_run: bool = False


@app.post("/api/hue/phantoms/remove")
async def remove_hue_phantoms(req: HuePhantomRemoveRequest):
    """Drop phantom Hue lights from every room, layout, nickname and record.

    Re-verifies against the bridge on every call rather than trusting the ids the
    caller sends: this deletes user data, and the client's list may be seconds
    stale — long enough for a light to have come back."""
    ip, username = config.get("hue_bridge_ip"), config.get("hue_username")
    if not ip or not username:
        raise HTTPException(400, "No Hue bridge paired")
    try:
        lights = await get_hue_lights(ip, username)
    except Exception as e:
        raise HTTPException(503, f"Bridge unreachable, refusing to prune: {e}")
    if not lights:
        raise HTTPException(503, "Bridge reported no lights at all — refusing to prune")

    live = {str(l["id"]) for l in lights}
    detected = {i for ids in _hue_phantoms(live).values() for i in ids}
    targets = sorted(detected & {str(i) for i in req.light_ids}) if req.light_ids else sorted(detected)
    refused = sorted({str(i) for i in req.light_ids} - detected) if req.light_ids else []

    if req.dry_run or not targets:
        return {"success": True, "dry_run": req.dry_run, "removed": [],
                "would_remove": targets, "refused": refused}

    try:
        if CONFIG_PATH.exists():
            import shutil
            shutil.copy2(CONFIG_PATH, CONFIG_PATH.parent / (CONFIG_PATH.name + ".pre-phantom-purge.bak"))
    except Exception:
        log.exception("Could not write pre-purge backup")

    report = {lid: _purge_hue_light(lid) for lid in targets}
    save_config(config)
    publish_event("config")
    log.warning("Pruned %d phantom Hue light(s): %s", len(targets), ", ".join(targets))
    return {"success": True, "removed": targets, "refused": refused, "details": report}


class SceneAddressRequest(BaseModel):
    """{ "2d3acc…": "segments", "1b62ee…": "whole" } — keyed by Govee slug.
    Bulk-shaped on purpose: the Scenes panel offers a "set all" alongside the
    per-device buttons, and both should be one request."""
    modes: dict[str, str]


@app.post("/api/govee/scene-address")
async def set_scene_address(req: SceneAddressRequest):
    """Set whether room scenes paint each Govee device per segment or as one
    colour. Read by the browser AND the scheduler — see gv_scene_address."""
    store = config.setdefault("govee_scene_address", {})
    bad = [k for k, v in req.modes.items() if v not in ("segments", "whole")]
    if bad:
        raise HTTPException(400, f"mode must be 'segments' or 'whole' (bad: {bad})")
    store.update(req.modes)
    save_config(config)
    publish_event("config")     # other sessions' Scenes panels resync
    return {"success": True, "govee_scene_address": store}


@app.post("/api/govee/segment-mode")
async def set_govee_segment_mode(req: GoveeSegmentModeRequest):
    """Toggle per-segment mode for a Govee device in a room.

    NOTE: this is the LIGHTNING scene's per-device switch, not the colour tool's.
    Room scenes and the scheduler use `govee_scene_address` (v3.18.0)."""
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
    """Manually set a Govee device's real segment (panel) count. Govee's own API
    doesn't report this reliably — a Glide Hexa returns the product line's max
    regardless of how many hexagons are physically attached — so this is the
    trustworthy source. Every count consumer prefers it over the SKU-table default."""
    if "govee_segment_counts" not in config:
        config["govee_segment_counts"] = {}
    config["govee_segment_counts"][gv_slug_for_ip(req.ip, req.mac)] = max(1, min(60, req.count))
    save_config(config)
    publish_event("config")
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
    mac: Optional[str] = None          # stable identity; lets a scheduled snapshot
                                       # re-resolve the DHCP IP at fire time.
    on: bool = True
    r: Optional[int] = None
    g: Optional[int] = None
    b: Optional[int] = None
    color_temp_kelvin: Optional[int] = None
    brightness: Optional[int] = None   # 0..100
    label: Optional[str] = None


class SceneBaseSeed(BaseModel):
    ip: str
    mac: Optional[str] = None          # stable identity (see SceneGoveeWhole.mac)
    r: Optional[int] = None
    g: Optional[int] = None
    b: Optional[int] = None
    color_temp_kelvin: Optional[int] = None
    brightness: Optional[int] = None


class SceneRazer(BaseModel):
    ip: str
    mac: Optional[str] = None          # stable identity (see SceneGoveeWhole.mac)
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
    # Human name for the look ("Palette · Sunset", "Chicago Bears"). Only the
    # browser knows it — the scene math lives there — so it rides along with the
    # resolved plan and is stored verbatim for the room header's "Now showing".
    label: Optional[str] = None
    # Set when the scheduler replays a stored snapshot, so the header can say the
    # room was changed by a schedule rather than by someone in the app.
    source: Optional[str] = None
    source_detail: Optional[str] = None


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
        hue_expect = {}   # filled by do_hue; recorded for later divergence checks
        _scene_emit(room, phase="applying", total=apply_total, done=0, active=True, end_at=end_at_ms)

        async def do_hue():
            sent = {}
            # This loop is staggered by tick(); without the bulk guard each light
            # would register its own read-back as it went, costing a GET every
            # settle window for the length of the apply. One batch at the end.
            _in_bulk_hue.set(True)
            try:
                for t in req.hue:
                    try:
                        res = await control_hue_light(HueLightStateRequest(
                            light_id=t.light_id, on=t.on, r=t.r, g=t.g, b=t.b,
                            color_temp=t.color_temp, brightness=t.brightness))
                        if res.get("success") and res.get("state"):
                            sent[str(t.light_id)] = res["state"]
                    except Exception as e:
                        log.warning("scene hue failed %s: %s", t.light_id, e)
                    await tick("applying", apply_total, t.label)
            finally:
                _in_bulk_hue.set(False)
            schedule_hue_verify(sent)
            hue_expect.update(sent)   # kept so a refresh can detect external changes

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

        # Record only on COMPLETION — a cancelled apply left the room half-set, so
        # claiming it's "now showing" that look would be a lie.
        record_room_applied(
            room, "scene", req.label or "Scene",
            swatches=_scene_swatches(req),
            source=req.source or "app", source_detail=req.source_detail,
            # `hue_expect` is filled by do_hue with the state actually sent, so a
            # later refresh can tell this scene apart from whatever a Google Home
            # routine replaced it with. `payload` lets "Set here" put it back.
            expect=hue_expect,
            payload=req.model_dump(exclude_none=True),
        )
        # A scene's Hue verify fired inside do_hue, long before this record
        # existed — so it had nothing to reconcile against. Run one more pass now
        # that the expectation is stored, which pins each colour to whatever the
        # bridge settled on (and re-checks the lights while it's there).
        schedule_hue_verify(hue_expect)
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


# ─── "Now showing": what each room was last set to ──────────────────────────
# room_color_state stores the Scenes panel's *recipe* so its controls rehydrate.
# It is only written when someone presses Apply in that panel — so it says nothing
# about a schedule that fired overnight, a white shortcut, or the room being turned
# off, and a second session reading it can be badly out of date. This records the
# resolved RESULT instead, from EVERY whole-room path, so the room header can
# answer "what is this room set to, when, and who did it" without opening anything.
ROOM_SWATCH_LIMIT = 10   # enough to read a palette at a glance; a strip, not a list


def _dedupe_swatches(colors: list) -> list:
    """Distinct RGB triples in first-seen order, capped. Order is preserved because
    a palette reads as a sequence — sorting it would destroy the look's identity."""
    out, seen = [], set()
    for c in colors:
        if not c or len(c) != 3:
            continue
        try:
            t = (max(0, min(255, int(c[0]))), max(0, min(255, int(c[1]))), max(0, min(255, int(c[2]))))
        except (TypeError, ValueError):
            continue
        if t in seen:
            continue
        seen.add(t)
        out.append(list(t))
        if len(out) >= ROOM_SWATCH_LIMIT:
            break
    return out


def _scene_swatches(req: "SceneApplyRequest") -> list:
    """Pull the representative colors out of an already-resolved apply payload.

    The scene math lives in the browser, but the payload it sends is fully
    resolved — so the swatches are derivable here and don't need to be sent
    separately (or recomputed, which the backend can't do)."""
    colors = []
    for h in req.hue:
        if h.r is not None:
            colors.append([h.r, h.g, h.b])
    for g in req.govee_whole:
        if g.r is not None:
            colors.append([g.r, g.g, g.b])
    for rz in req.razer:
        colors.extend(rz.colors or [])
    for cd in req.cloud:
        for grp in cd.groups:
            if grp.r is not None:
                colors.append([grp.r, grp.g, grp.b])
    return _dedupe_swatches(colors)


def record_room_applied(room: str, kind: str, label: str,
                        swatches: Optional[list] = None,
                        kelvin: Optional[int] = None,
                        source: str = "app",
                        source_detail: Optional[str] = None,
                        expect: Optional[dict] = None,
                        payload: Optional[dict] = None):
    """Record what `room` was just set to. Best-effort display metadata — it must
    never break a light command, so callers don't need to guard it.

    `expect` is the per-light state AS SENT ({light_id: state_dict}) — the same
    dict `_hue_verify_repair` builds. Keeping it is what lets a later refresh
    prove the room has since been changed by something that isn't LightEmUp
    (the Hue app, the Govee app, a Google Home routine). See `_room_status`.

    `payload` is the resolved scene plan, kept so the look can be replayed by
    `POST /api/rooms/reapply` when it HAS drifted — same snapshot mechanism a
    scheduled scene uses."""
    try:
        entry = {
            "kind": kind,               # scene | white | color | power | lightning
            "label": label,
            "at": _now_iso(),
            "source": source,           # "app" | "schedule" | "zone"
        }
        if swatches:
            entry["swatches"] = swatches[:ROOM_SWATCH_LIMIT]
        if kelvin is not None:
            entry["kelvin"] = int(kelvin)
        if source_detail:
            entry["source_detail"] = source_detail
        if expect:
            entry["expect_hue"] = {str(k): v for k, v in expect.items()}
        if payload:
            entry["payload"] = payload
        config.setdefault("room_last_applied", {})[room] = entry
        schedule_save()
        # Publish UNSOURCED (source=None overrides the ContextVar via **fields) so
        # the session that caused this refreshes too — clients ignore their own
        # echoes, and the actor is exactly who most wants to see the new strip.
        # Also lift _suppress_publish for this one event: a scene apply sets it for
        # the whole run, which would otherwise swallow the very record that says
        # the scene finished.
        token = _suppress_publish.set(False)
        try:
            publish_event("room-applied", room=room, source=None)
        finally:
            _suppress_publish.reset(token)
    except Exception:
        log.exception("Could not record last-applied look for %r", room)


# ─── Has something else changed this room since we set it? ──────────────────
# LightEmUp is not the only thing driving these lights — the Hue app, the Govee
# app and Google Home routines all touch them (and must: Govee's own engine is
# the only way to run fast animations, which the rate-limited cloud API can't).
# So "what we last set" is NOT the same as "what the room is showing", and the
# strip used to claim the latter while only knowing the former.
#
# THE RULE: this check can PROVE divergence but can never PROVE agreement, so it
# only ever downgrades a claim — it never certifies one. Three verdicts, and
# "unknown" is never dressed up as either of the others.
#
# Comparing colour was previously rejected outright (see `_hue_verify_repair`),
# but that was for REPAIR, where a false positive re-sends forever. Here a false
# positive only mislabels a strip, so a TOLERANT comparison is worth it — and it
# has to be, because mode alone (xy vs ct) can't tell your palette from someone
# else's colour scene.
HUE_XY_TOLERANCE = 0.06    # gamut clamping shifts xy slightly; a different scene shifts it a lot
HUE_CT_TOLERANCE = 25      # mireds


def _hue_state_matches(sent: dict, cur: dict) -> Optional[bool]:
    """True = still what we set, False = definitely changed, None = can't tell."""
    if not cur or not cur.get("reachable", True):
        return None                       # unreachable: no information either way
    want_on = sent.get("on")
    if want_on is not None and bool(cur.get("on")) != bool(want_on):
        return False
    if want_on is False:
        return True                       # asked off and it's off — nothing else matters
    want_bri = sent.get("bri")
    if want_bri is not None and cur.get("brightness") is not None:
        if abs(int(cur["brightness"]) - int(want_bri)) > HUE_VERIFY_BRI_TOLERANCE:
            return False                  # e.g. a routine forced 100%
    mode = cur.get("color_mode")
    if "xy" in sent:
        if mode == "ct":
            return False                  # our colour scene replaced by a white — the common case
        cxy = cur.get("xy")
        if mode == "xy" and isinstance(cxy, (list, tuple)) and len(cxy) == 2:
            dx, dy = abs(cxy[0] - sent["xy"][0]), abs(cxy[1] - sent["xy"][1])
            if max(dx, dy) > HUE_XY_TOLERANCE:
                return False              # still colour, but a DIFFERENT colour
            return True
        return None                       # hs mode or no xy reported — can't judge
    if "ct" in sent:
        if mode == "xy":
            return False
        cct = cur.get("color_temp")
        if cct is not None:
            return abs(int(cct) - int(sent["ct"])) <= HUE_CT_TOLERANCE
        return None
    return True if want_bri is not None else None


async def _room_status(room_name: str, lights_by_id: dict) -> dict:
    """Verdict for one room: match | diverged | unknown (+ how many lights agreed)."""
    entry = (config.get("room_last_applied", {}) or {}).get(room_name)
    if not entry:
        return {"state": "none"}
    expect = entry.get("expect_hue") or {}
    if not expect:
        # Nothing recorded to compare against (a pre-v3.16.0 record, or a look we
        # can't verify such as a Govee-only room). Stay quiet rather than guess.
        return {"state": "unknown", "checked": 0}

    matched = changed = unknown = 0
    changed_names = []
    for light_id, sent in expect.items():
        verdict = _hue_state_matches(sent, lights_by_id.get(str(light_id)))
        if verdict is True:
            matched += 1
        elif verdict is False:
            changed += 1
            nm = (lights_by_id.get(str(light_id)) or {}).get("name")
            if nm and len(changed_names) < 4:
                changed_names.append(nm)
        else:
            unknown += 1

    if changed:
        return {"state": "diverged", "changed": changed, "matched": matched,
                "unknown": unknown, "changed_names": changed_names,
                "can_reapply": bool(entry.get("payload") or entry.get("kind") in
                                    ("white", "color", "power"))}
    if matched:
        return {"state": "match", "matched": matched, "unknown": unknown}
    return {"state": "unknown", "checked": len(expect)}


@app.get("/api/rooms/status")
async def rooms_status():
    """Per-room: does the room still look like what LightEmUp last set?

    One bridge read serves every room. Govee is deliberately NOT judged — LAN
    devStatus reports colour unreliably, and a running Govee-app animation isn't
    a static state at all, so pretending to verify it would manufacture exactly
    the false confidence this endpoint exists to avoid."""
    ip = config.get("hue_bridge_ip")
    username = config.get("hue_username")
    lights_by_id = {}
    if ip and username:
        try:
            for l in await get_hue_lights(ip, username):
                lights_by_id[str(l["id"])] = {**(l.get("state") or {}), "name": l.get("name")}
        except Exception:
            log.warning("Room status: could not read the bridge", exc_info=True)
    out = {}
    for room_name in config.get("rooms", {}):
        out[room_name] = await _room_status(room_name, lights_by_id)
    return {"rooms": out}


class RoomReapplyRequest(BaseModel):
    room_name: str


@app.post("/api/rooms/reapply")
async def reapply_room(req: RoomReapplyRequest):
    """Put back the look LightEmUp last set — the "Set here" button that appears
    once the room has provably drifted (usually a Google Home routine forcing a
    plain colour temperature)."""
    entry = (config.get("room_last_applied", {}) or {}).get(req.room_name)
    if not entry:
        raise HTTPException(404, f"Nothing recorded for '{req.room_name}'")
    kind = entry.get("kind")

    if kind == "scene":
        payload = _freshen_scene_payload(entry.get("payload") or {})
        if payload is None:
            raise HTTPException(409, "That scene's devices can't be resolved any more")
        sreq = SceneApplyRequest(**payload)
        sreq.label = entry.get("label")
        existing = _scene_tasks.get(sreq.room)
        if existing and not existing.done():
            existing.cancel()
            try:
                await existing
            except BaseException:
                pass
        _scene_tasks[sreq.room] = asyncio.create_task(_run_scene_apply(sreq))
        return {"success": True, "kind": kind, "async": True}

    if kind == "white":
        await _apply_room_white(req.room_name, int(entry.get("kelvin") or 2700), 100)
    elif kind == "color":
        sw = (entry.get("swatches") or [[255, 255, 255]])[0]
        await _apply_room_color(req.room_name, sw[0], sw[1], sw[2], 100)
    elif kind == "power":
        await _apply_room_power(req.room_name, "off" not in (entry.get("label") or "").lower())
    else:
        raise HTTPException(400, f"Can't replay a '{kind}' look")
    return {"success": True, "kind": kind}


class RoomAppliedRequest(BaseModel):
    """For looks the frontend fans out CLIENT-side (the "Set room to" white
    shortcuts drive each device directly, so no room endpoint sees them)."""
    room_name: str
    kind: str
    label: str
    swatches: Optional[list] = None
    kelvin: Optional[int] = None


@app.post("/api/rooms/last-applied")
async def set_room_last_applied(req: RoomAppliedRequest):
    record_room_applied(req.room_name, req.kind, req.label,
                        swatches=_dedupe_swatches(req.swatches or []),
                        kelvin=req.kelvin)
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
        "room_last_applied": config.get("room_last_applied", {}),
        "ct_correction": config.get("ct_correction", {}),
        "ct_rgb": config.get("ct_rgb", {}),
        "device_modes": config.get("device_modes", {}),
        "govee_scene_address": config.get("govee_scene_address", {}),
        "segment_fill_modes": config.get("segment_fill_modes", {}),
        "ui_prefs": config.get("ui_prefs", {}),
        "power_recovery": config.get("power_recovery", {}),
        "schedules": config.get("schedules", []),
        "location": config.get("location", {}),
        "zones": config.get("zones", {}),
        "favorites": config.get("favorites") or DEFAULT_FAVORITES,
    }


# ─── Backup / restore (export + import every setting) ───────────────────────
# Everything the user has built — rooms, layouts, nicknames, calibration,
# schedules, zones, fixtures — lives in ONE file on the Pi's microSD card, and
# those cards wear out and die. A backup that sits on the same card is worthless
# for the failure it's meant to survive, so export hands the BROWSER a download:
# the file leaves the machine. (The rolling config.json*.bak files protect
# against a bad write, not against losing the card.)
EXPORT_FORMAT = 1        # envelope version — not the config's schema_version
SUPPORTED_SCHEMA = 2     # highest config schema_version this build understands

# Credentials, not preferences. hue_username is a bridge token: without it a
# restore can't talk to the bridge until someone physically presses its button.
_CREDENTIAL_KEYS = ("hue_username", "govee_api_key")


def _deep_copy(obj):
    """JSON round-trip copy — config is plain JSON data, and this guarantees the
    export can't alias (or accidentally mutate) the live dict."""
    return json.loads(json.dumps(obj))


def _export_envelope(include_credentials: bool = True) -> dict:
    """Wrap the live config in a self-describing envelope.

    The envelope — rather than a raw config.json — is what lets import recognise a
    genuine LightEmUp backup, refuse one written by a NEWER build whose schema we'd
    silently mangle, and state up front whether credentials are inside."""
    import socket
    from datetime import datetime
    cfg = _deep_copy(config)
    had_creds = any(cfg.get(k) for k in _CREDENTIAL_KEYS)
    if not include_credentials:
        for k in _CREDENTIAL_KEYS:
            cfg[k] = None
    return {
        "lightemup_export": EXPORT_FORMAT,
        "app_version": APP_VERSION,
        "schema_version": cfg.get("schema_version", 1),
        "exported_at": datetime.now().isoformat(timespec="seconds"),
        "hostname": socket.gethostname(),
        "includes_credentials": bool(include_credentials and had_creds),
        "config": cfg,
    }


# ─── Restore preview: EVERY setting, without a list to keep in step ──────────
# The export itself can't have gaps — _export_envelope deep-copies the whole live
# config, so a new key ships automatically. The PREVIEW was the gap: it was a
# hand-written list of 14 fields, and every feature since v3.11.0 widened the
# hole. Restoring an older backup silently discarded white calibration, your
# location (which sun schedules need), favourites, per-device segment counts and
# scene addressing — and the diff said nothing, so "replace all settings" was a
# bigger promise than it looked.
#
# So the rows are DERIVED from the config keys themselves, not listed. Anything
# in DEFAULT_CONFIG or in either file appears, whether or not anyone remembered
# it. The tables below only make the output nicer:
#   _SETTING_LABELS   — a human name (unlabelled keys get one generated)
#   _SETTING_RENDER   — a custom cell (unrendered keys get a sensible default)
#   _SETTING_INTERNAL — derived/runtime state a person wouldn't miss, hidden
#   _SETTING_ORDER    — the few that should lead; the rest sort alphabetically
# Adding a setting therefore degrades to "it shows up with a plain label", never
# to "it's invisible".

_SETTING_INTERNAL = {
    "device_state",       # last state we sent each device — rebuilt by use
    "segment_state",      # mirror of the in-memory segment store
    "hue_missing_since",  # a clock, reset the moment a light returns
    "room_last_applied",  # "Now showing" display record
    "schema_version",     # migration marker, not a setting
}

_SETTING_LABELS = {
    "rooms": "Rooms",
    "nicknames": "Custom names",
    "room_layouts": "Room layouts",
    "schedules": "Schedules",
    "zones": "Zones",
    "fixtures": "Fixtures",
    "favorites": "Favourite colours",
    "location": "Location (for sunrise/sunset)",
    "power_recovery": "Power-outage recovery",
    "lightning_scenes": "Saved lightning scenes",
    "room_color_state": "Saved room scenes",
    "room_presets": "Room presets",
    "ct_rgb": "White calibration (RGB)",
    "ct_correction": "White calibration (legacy)",
    "govee_scene_address": "Segments-or-whole per device",
    "govee_segment_counts": "Segment counts set by hand",
    "govee_segment_mode": "Lightning per-segment",
    "segment_fill_modes": "Segment fill modes",
    "device_modes": "Device control modes",
    "ui_prefs": "Interface preferences",
    "known_devices": "Known Govee devices",
    "hue_bridge_ip": "Hue Bridge",
    "hue_username": "Hue Bridge pairing",
    "govee_api_key": "Govee API key",
}

_SETTING_ORDER = ["rooms", "nicknames", "room_layouts", "schedules", "zones",
                  "fixtures", "location", "favorites"]


def _render_setting(key: str, value):
    """One cell of the restore preview. Falls back to a count for containers and
    set/not set for scalars, so an unregistered key still renders something true."""
    if key in ("hue_username", "govee_api_key"):
        return "set" if value else "not set"        # never echo a credential
    if key == "hue_bridge_ip":
        return value or "none"
    if key == "location":
        if isinstance(value, dict) and value.get("lat") is not None:
            return f"{value['lat']:.3f}, {value['lng']:.3f}"
        return "not set"
    if key == "power_recovery":
        mode = (value or {}).get("mode") or "resume_unless_night"
        return {"resume_unless_night": "Resume unless overnight",
                "resume_always": "Always resume",
                "off": "Do nothing"}.get(mode, mode)
    if key == "known_devices":
        return len((value or {}).get("govee") or {})
    if isinstance(value, (dict, list)):
        return len(value)
    if isinstance(value, bool):
        return "on" if value else "off"
    if value is None or value == "":
        return "not set"
    return value


def _config_diff_rows(cur: dict, inc: dict, keep_credentials: bool = True) -> list:
    """Every setting, current vs incoming, for the pre-import preview.

    The key set is the UNION of DEFAULT_CONFIG and both configs, so a setting is
    listed whether it's one this build knows, one only the backup has (imported
    from a newer build), or one only the live config has (about to be lost).

    `keep_credentials` mirrors the import's own flag: a credential-free backup does
    NOT unpair the bridge, so showing "set → not set" for it would be a false alarm
    about the one thing that needs a physical button press to undo."""
    keys = (set(DEFAULT_CONFIG) | set(cur or {}) | set(inc or {})) - _SETTING_INTERNAL
    def sort_key(k):
        return (_SETTING_ORDER.index(k) if k in _SETTING_ORDER else len(_SETTING_ORDER),
                _SETTING_LABELS.get(k, k).lower())
    rows = []
    for key in sorted(keys, key=sort_key):
        current = _render_setting(key, (cur or {}).get(key))
        incoming = _render_setting(key, (inc or {}).get(key))
        changed = str(current) != str(incoming)
        # Match what the import will actually do with credentials: carried over, so
        # the effective state does NOT change and the row must not be flagged.
        if (key in _CREDENTIAL_KEYS and keep_credentials
                and not (inc or {}).get(key) and (cur or {}).get(key)):
            incoming, changed = "kept", False
        rows.append({
            "key": key,
            "label": _SETTING_LABELS.get(key) or key.replace("_", " ").capitalize(),
            "current": current,
            "incoming": incoming,
            "changed": changed,
            # Not in this build's registry — flagged so the UI can say the backup
            # carries a setting this version doesn't know about.
            "unknown": key not in DEFAULT_CONFIG,
        })
    return rows


def _config_summary(cfg: dict) -> dict:
    """Counts for the pre-import preview, so replacing everything is never a leap
    of faith. Room/zone NAMES are listed (not just counted) because that's what
    makes a wrong-backup mistake obvious at a glance."""
    rooms = cfg.get("rooms", {}) or {}
    known = (cfg.get("known_devices") or {}).get("govee") or {}
    return {
        "rooms": sorted(rooms.keys()),
        "hue_lights": sum(len(r.get("hue_light_ids") or []) for r in rooms.values()),
        "govee_devices": sum(len(r.get("govee_devices") or []) for r in rooms.values()),
        "nicknames": len(cfg.get("nicknames") or {}),
        "room_layouts": len(cfg.get("room_layouts") or {}),
        "schedules": len(cfg.get("schedules") or []),
        "zones": sorted((cfg.get("zones") or {}).keys()),
        "fixtures": len(cfg.get("fixtures") or {}),
        "known_govee": len(known),
        "lightning_scenes": len(cfg.get("lightning_scenes") or {}),
        "room_presets": len(cfg.get("room_presets") or {}),
        "hue_paired": bool(cfg.get("hue_username")),
        "govee_api_key_set": bool(cfg.get("govee_api_key")),
        "hue_bridge_ip": cfg.get("hue_bridge_ip"),
    }


def _unwrap_import(payload: dict) -> tuple[dict, dict]:
    """Accept either a full export envelope or a bare config.json — people do pull
    the latter straight off the card — and validate it before anything is touched.
    Raises HTTPException with a plain-language reason rather than half-importing."""
    if not isinstance(payload, dict):
        raise HTTPException(400, "That file isn't a JSON object.")

    if "lightemup_export" in payload or "config" in payload:
        cfg = payload.get("config")
        if not isinstance(cfg, dict):
            raise HTTPException(400, "That export file has no 'config' object in it.")
        meta = {k: payload.get(k) for k in (
            "lightemup_export", "app_version", "schema_version",
            "exported_at", "hostname", "includes_credentials")}
    else:
        # Bare config.json fallback. Require a recognisable key so an unrelated
        # JSON file can't be imported as settings.
        if not any(k in payload for k in ("rooms", "nicknames", "hue_bridge_ip")):
            raise HTTPException(400, "This doesn't look like a LightEmUp backup or config file.")
        cfg = payload
        meta = {"lightemup_export": None, "app_version": None,
                "schema_version": payload.get("schema_version"),
                "exported_at": None, "hostname": None,
                "includes_credentials": bool(payload.get("hue_username"))}

    schema = cfg.get("schema_version", meta.get("schema_version")) or 1
    if isinstance(schema, int) and schema > SUPPORTED_SCHEMA:
        raise HTTPException(400,
            f"That backup uses config schema v{schema}, but this build only understands "
            f"v{SUPPORTED_SCHEMA}. Update LightEmUp first, then import.")
    return cfg, meta


@app.get("/api/config/export")
async def export_config(include_credentials: bool = True):
    """Download every setting as one JSON file. Served as an attachment so it
    lands on the user's machine, not on the Pi's card."""
    from datetime import datetime
    env = _export_envelope(include_credentials)
    stamp = datetime.now().strftime("%Y-%m-%d")
    fname = f"lightemup-config-{env['hostname']}-{stamp}.json"
    # indent=2: a backup you can read, diff and hand-edit is worth the bytes.
    return Response(
        content=json.dumps(env, indent=2),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


class ConfigImportRequest(BaseModel):
    payload: dict            # export envelope, or a bare config.json
    dry_run: bool = False    # preview only — touches nothing
    keep_credentials: bool = True   # see below


@app.post("/api/config/import")
async def import_config(req: ConfigImportRequest):
    """Replace ALL settings with a backup. Destructive by design."""
    new_cfg, meta = _unwrap_import(req.payload)

    # Preview first: the UI shows current-vs-incoming before anything happens.
    # `server_version` rides along so the browser can compare it with the backup's
    # `meta.app_version` and warn about a cross-version restore. The comparison is
    # deliberately NOT made here: a version difference is a caution, not an error,
    # and the only hard refusal is the schema check in _unwrap_import. Raising on a
    # mismatch would block the most valuable restore there is — an old backup onto
    # a rebuilt Pi running the current build.
    if req.dry_run:
        return {"dry_run": True, "meta": meta,
                "server_version": APP_VERSION,
                "rows": _config_diff_rows(config, new_cfg, req.keep_credentials),
                "current": _config_summary(config),
                "incoming": _config_summary(new_cfg)}

    # Merge over defaults so a backup predating a key still yields a complete
    # config; unknown/newer keys in the backup survive verbatim.
    merged = _deep_copy(DEFAULT_CONFIG)
    merged.update(_deep_copy(new_cfg))

    # A credential-free backup would otherwise UNPAIR the bridge, and re-pairing
    # needs a physical button press on the hardware. Carry the live credentials
    # over when the incoming file has none.
    if req.keep_credentials:
        for k in _CREDENTIAL_KEYS:
            if not merged.get(k) and config.get(k):
                merged[k] = config[k]

    # Dedicated pre-import snapshot. _config_backups() globs config.json*.bak, so
    # this automatically joins the pool load_config() restores from. If we can't
    # protect the current settings, don't proceed.
    if CONFIG_PATH.exists():
        import shutil
        from datetime import datetime
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        try:
            shutil.copy2(CONFIG_PATH, CONFIG_PATH.with_name(
                f"{CONFIG_PATH.name}.pre-import-{stamp}.bak"))
        except Exception:
            log.exception("Could not write pre-import backup")
            raise HTTPException(500, "Couldn't write a pre-import backup, so the import "
                                     "was aborted and your current settings are untouched.")

    # Quiesce anything still driving lights from the OLD config — a running storm
    # or staggered scene apply would keep addressing devices this import may have
    # renamed or removed.
    for task in list(_scene_tasks.values()):
        task.cancel()
    _scene_tasks.clear()
    for room_name in list(config.get("rooms", {})):
        try:
            if scene_manager.is_active(room_name):
                await scene_manager.stop_lightning(room_name)
        except Exception:
            log.exception("Import: could not stop lightning in %r", room_name)
    razer_keeper.cancel_all()

    # Swap IN PLACE. Rebinding the global would leave anything holding a reference
    # to the old dict silently reading stale settings.
    config.clear()
    config.update(merged)

    # An older backup may still be IP-keyed (pre-v3.0.0) or carry the room-level
    # scene-addressing setting (pre-v3.18.0); migrate it like a boot would.
    migrate_govee_to_mac(config)
    migrate_scene_address(config)
    save_config(config)          # write through now, not via the coalescing scheduler
    reload_segment_state()       # in-memory store must match the config we just loaded
    publish_event("config")      # every open browser resyncs

    summary = _config_summary(config)
    log.warning("Config imported (from %s, app %s, exported %s): %d rooms, %d schedules, "
                "%d nicknames", meta.get("hostname") or "unknown",
                meta.get("app_version") or "unknown", meta.get("exported_at") or "unknown",
                len(summary["rooms"]), summary["schedules"], summary["nicknames"])
    # No restart needed: bridge creds/IP are read per-call, the scheduler re-reads
    # config["schedules"] every tick, and the segment store was just rebuilt.
    return {"success": True, "meta": meta, "summary": summary, "restart_required": False}


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


# ─── Power-recovery settings ────────────────────────────────────────────────

class PowerRecoveryRequest(BaseModel):
    mode: Optional[str] = None          # "resume_unless_night" | "resume_always" | "off"
    night_start: Optional[str] = None   # 24h "HH:MM"
    night_end: Optional[str] = None     # 24h "HH:MM"


@app.post("/api/power-recovery")
async def set_power_recovery(req: PowerRecoveryRequest):
    """Persist how a fresh boot after a power outage treats the lights. Applied
    on the next boot only — changing it here never drives lights now."""
    pr = config.setdefault("power_recovery", {})
    if req.mode in ("resume_unless_night", "resume_always", "off"):
        pr["mode"] = req.mode
    for field in ("night_start", "night_end"):
        val = getattr(req, field)
        if val is not None:
            h, m = _parse_hhmm(val)
            if h >= 0:
                pr[field] = f"{h:02d}:{m:02d}"
    save_config(config)
    publish_event("config")
    return {"success": True, "power_recovery": pr}


# ─── Schedules + location ───────────────────────────────────────────────────

class ScheduleRequest(BaseModel):
    """Upsert one schedule. `id` absent ⇒ create (a uuid is minted)."""
    id: Optional[str] = None
    name: Optional[str] = None
    enabled: Optional[bool] = None
    trigger: Optional[dict] = None   # see DEFAULT_CONFIG["schedules"] for the shape
    action: Optional[dict] = None
    # Optional OFF half: {"type":"after","after_minutes":90} |
    # {"type":"weekly","time":"23:30"} | {"type":"sun","event":"sunrise","offset_min":10}
    # Send null to remove it. See "Paired on/off schedules".
    end: Optional[dict] = None


class LocationRequest(BaseModel):
    lat: Optional[float] = None
    lng: Optional[float] = None


def _validate_schedule_action(action: dict):
    """Reject impossible action shapes before they're stored. A scene targets one
    room and carries a resolved payload; white/color/power/palette target a room
    OR a zone — but a scene can never target a zone (it's a device-specific
    snapshot). A palette CAN, because it's resolved per-room at fire time."""
    if not isinstance(action, dict):
        raise HTTPException(400, "action must be an object")
    atype = action.get("type")
    if atype not in ("scene", "white", "color", "power", "palette", "colors"):
        raise HTTPException(400, f"unknown action type {atype!r}")
    if action.get("zone"):
        if atype == "scene":
            raise HTTPException(400, "a scene can't target a zone — scenes are room-only")
    elif not action.get("room"):
        raise HTTPException(400, "action needs a room or a zone")
    if atype == "scene" and not action.get("payload"):
        raise HTTPException(400, "a scene action needs a captured payload")
    if atype == "palette":
        # Catch an empty selection HERE rather than at 3am, where the only
        # symptom is a schedule that silently does nothing.
        if not palettes.resolve_candidates(action):
            if action.get("source") == "category":
                raise HTTPException(400, f"no palettes in category {action.get('category')!r}")
            raise HTTPException(400, "pick at least one palette")
    if atype == "colors":
        good = [c for c in (action.get("colors") or [])
                if isinstance(c, (list, tuple)) and len(c) == 3
                and all(isinstance(v, int) and 0 <= v <= 255 for v in c)]
        if not good:
            raise HTTPException(400, "pick at least one colour")


class PaletteApplyRequest(BaseModel):
    """Fire a palette action once, right now — the scheduler's "Try it" button.
    Same shape as the schedule action, so what you preview is literally what
    will run at sunset."""
    room: Optional[str] = None
    zone: Optional[str] = None
    source: str = "list"               # "list" | "category" (legacy)
    category: Optional[str] = None
    palettes: list[str] = []
    # A "My Colors" try: inline colours instead of library palettes. Wrapped as a
    # one-off palette so the same builder runs.
    colors: list[list[int]] = []
    brightness: int = 100
    # No per-schedule segments flag: whether a device is painted per segment is a
    # property of the DEVICE (govee_scene_address, set in the Scenes panel), not
    # of the schedule. A second switch here could only disagree with the room.


@app.get("/api/palettes")
async def get_palettes():
    """The shared palette library. The browser has the same data statically (see
    palette-library.js) and doesn't need this — it exists so the library the
    SCHEDULER will actually draw from can be inspected without ssh'ing to the Pi,
    which is the only way to catch the two copies drifting apart."""
    return {
        "categories": palettes.CATEGORIES,
        "count": len(palettes.PALETTES),
        "palettes": [{"name": p["name"], "category": p["category"],
                      "featured": p["featured"],
                      "colors": [list(c) for c in p["colors"]]}
                     for p in palettes.PALETTES],
    }


@app.post("/api/palettes/apply")
async def apply_palette_now(req: PaletteApplyRequest):
    """Pick from the same candidate set and apply it immediately, so a palette
    schedule can be seen before it's trusted to run unattended."""
    action = req.model_dump()
    inline = [tuple(int(v) for v in c) for c in (req.colors or [])
              if isinstance(c, (list, tuple)) and len(c) == 3]
    if inline:
        chosen = {"name": "My Colors", "category": "custom", "featured": False,
                  "colors": inline}
        candidates = [chosen]
    else:
        candidates = palettes.resolve_candidates(action)
        if not candidates:
            raise HTTPException(400, "no palettes matched that selection")
        chosen = palettes.pick(candidates)
    targets = _zone_rooms(req.zone, "Try palette") if req.zone else ([req.room] if req.room else [])
    if not targets:
        raise HTTPException(400, "pick a room or a zone")
    applied = []
    for target in targets:
        if await _apply_room_palette(target, chosen, brightness=req.brightness,
                                     source="app"):
            applied.append(target)
    if not applied:
        raise HTTPException(400, "nothing addressable in that room")
    return {"success": True, "palette": chosen["name"], "category": chosen["category"],
            "colors": [list(c) for c in chosen["colors"]], "rooms": applied,
            "candidates": len(candidates)}


def _validate_schedule_end(end):
    """Reject an unusable OFF half at save time rather than at 3am."""
    if end is None:
        return
    if not isinstance(end, dict):
        raise HTTPException(400, "end must be an object or null")
    etype = end.get("type")
    if etype not in ("after", "weekly", "sun"):
        raise HTTPException(400, f"unknown end type {etype!r}")
    if etype == "after":
        try:
            mins = int(end.get("after_minutes"))
        except (TypeError, ValueError):
            raise HTTPException(400, "after_minutes must be a number")
        if mins <= 0:
            raise HTTPException(400, "after_minutes must be greater than 0")
    elif etype == "weekly":
        if _parse_hhmm(end.get("time"))[0] < 0:
            raise HTTPException(400, "end needs a time as HH:MM")
    elif etype == "sun":
        if end.get("event") not in ("sunrise", "sunset"):
            raise HTTPException(400, "end event must be sunrise or sunset")
        loc = config.get("location") or {}
        if loc.get("lat") is None or loc.get("lng") is None:
            raise HTTPException(400, "a sunrise/sunset end needs your location set first")


@app.get("/api/schedules")
async def get_schedules():
    return {"schedules": config.get("schedules", []),
            "location": config.get("location", {})}


@app.post("/api/schedules")
async def upsert_schedule(req: ScheduleRequest):
    """Create or update a schedule. A create needs trigger + action; an update
    patches only the fields present, so the UI can flip `enabled` on its own."""
    import uuid
    schedules = config.setdefault("schedules", [])
    existing = next((s for s in schedules if s.get("id") == req.id), None) if req.id else None

    # `end` needs three states — absent (leave alone), an object (set), and an
    # explicit null (remove) — which a plain Optional can't express. pydantic v2
    # records which fields the caller actually sent.
    end_sent = "end" in req.model_fields_set

    if existing is None:
        if not req.trigger or not req.action:
            raise HTTPException(400, "A new schedule needs both a trigger and an action")
        _validate_schedule_action(req.action)
        _validate_schedule_end(req.end)
        sched = {
            "id": req.id or str(uuid.uuid4()),
            "name": req.name or "Schedule",
            "enabled": True if req.enabled is None else bool(req.enabled),
            "trigger": req.trigger,
            "action": req.action,
            "end": req.end,
            "last_fired": None,
            "end_due": None,
        }
        schedules.append(sched)
    else:
        sched = existing
        if req.name is not None:
            sched["name"] = req.name
        if req.enabled is not None:
            sched["enabled"] = bool(req.enabled)
            # Disabling means "this schedule does nothing". Leaving a pending OFF
            # armed would contradict that — a disabled schedule turning lights off
            # an hour later is exactly the sort of thing you can't explain.
            if not sched["enabled"]:
                sched["end_due"] = None
        if req.trigger is not None:
            sched["trigger"] = req.trigger
            sched["last_fired"] = None   # retimed — don't let the old dedupe block it
            sched["end_due"] = None      # …and the armed end belonged to the old timing
        if req.action is not None:
            _validate_schedule_action(req.action)
            sched["action"] = req.action
            sched["end_due"] = None      # the target may have moved
        if end_sent:
            _validate_schedule_end(req.end)
            sched["end"] = req.end
            sched["end_due"] = None

    save_config(config)
    publish_event("config")
    return {"success": True, "schedule": sched}


@app.delete("/api/schedules/{schedule_id}")
async def delete_schedule(schedule_id: str):
    schedules = config.get("schedules", [])
    remaining = [s for s in schedules if s.get("id") != schedule_id]
    if len(remaining) == len(schedules):
        raise HTTPException(404, f"No schedule '{schedule_id}'")
    config["schedules"] = remaining
    save_config(config)
    publish_event("config")
    return {"success": True}


@app.get("/api/location")
async def get_location():
    return config.get("location", {})


@app.post("/api/location")
async def set_location(req: LocationRequest):
    """Lat/long for sun-relative triggers. Without it, sun schedules are inert."""
    if req.lat is None or req.lng is None:
        raise HTTPException(400, "Both lat and lng are required")
    if not (-90 <= req.lat <= 90) or not (-180 <= req.lng <= 180):
        raise HTTPException(400, "lat/lng out of range")
    config["location"] = {"lat": round(req.lat, 5), "lng": round(req.lng, 5)}
    save_config(config)
    publish_event("config")
    return {"success": True, "location": config["location"]}


# ─── Zones ──────────────────────────────────────────────────────────────────
# A zone is a named group of rooms (one level deep; a room may be in several).
# It's a scheduling target only for now — a zone schedule fans a white/color/power
# action out over every member room (see _fire_schedule). Scenes stay room-only.

class ZoneRequest(BaseModel):
    name: str
    rooms: list[str] = []


@app.get("/api/zones")
async def get_zones():
    return {"zones": config.get("zones", {})}


@app.post("/api/zones")
async def upsert_zone(req: ZoneRequest):
    """Create or replace a zone (keyed by name). Unknown room names are dropped
    so a zone never references a room that isn't there."""
    name = req.name.strip()
    if not name:
        raise HTTPException(400, "Zone name is required")
    known = config.get("rooms", {})
    members = [r for r in req.rooms if r in known]
    zones = config.setdefault("zones", {})
    zones[name] = {"rooms": members}
    save_config(config)
    publish_event("config")
    return {"success": True, "zone": {"name": name, **zones[name]}}


class ZoneRenameRequest(BaseModel):
    old_name: str
    new_name: str


@app.post("/api/zones/rename")
async def rename_zone(req: ZoneRenameRequest):
    """Rename a zone, carrying every reference with it.

    `POST /api/zones` upserts by name, so renaming through it would leave the old
    zone behind and silently orphan any schedule pointing at it — the same trap
    `rename_room` exists to avoid. A zone name is referenced in three places:
    the `zones` key itself, `schedules[].action.zone` (held by value), and
    `room_last_applied[*].source_detail` (which credits the zone that set a room —
    cosmetic, but it would otherwise name a zone that no longer exists).
    **Add any new zone-name-keyed structure here.**"""
    zones = config.get("zones", {}) or {}
    old = req.old_name.strip()
    new = req.new_name.strip()
    if old not in zones:
        raise HTTPException(404, f"No zone '{old}'")
    if not new:
        raise HTTPException(400, "New zone name is required")
    if new == old:
        return {"success": True, "zone": {"name": old, **zones[old]}}
    if new in zones:
        raise HTTPException(409, f"A zone named '{new}' already exists")

    # Rebuild in place rather than pop+assign: the zone bar renders in insertion
    # order, so a plain re-add would jump the renamed zone to the end of the row.
    config["zones"] = {(new if k == old else k): v for k, v in zones.items()}

    for sched in config.get("schedules", []) or []:
        action = sched.get("action") or {}
        if action.get("zone") == old:
            action["zone"] = new

    for entry in (config.get("room_last_applied", {}) or {}).values():
        if entry.get("source") == "zone" and entry.get("source_detail") == old:
            entry["source_detail"] = new

    save_config(config)
    publish_event("config")
    log.info("Renamed zone %r → %r", old, new)
    return {"success": True, "zone": {"name": new, **config["zones"][new]}}


class ZoneControlRequest(BaseModel):
    """Drive every room in a zone at once — the "all upstairs off" button.

    Mirrors the schedule action shapes rather than inventing a parallel one, so
    pressing a zone button and a zone schedule firing take the exact same path."""
    zone_name: str
    type: str = "power"                 # power | white | color
    on: Optional[bool] = None           # power
    kelvin: Optional[int] = None        # white
    r: Optional[int] = None             # color
    g: Optional[int] = None
    b: Optional[int] = None
    brightness: int = 100


@app.post("/api/zones/control")
async def control_zone(req: ZoneControlRequest):
    """Fan a live action out over every room in a zone.

    Zones started life as a scheduling target only, but the useful everyday case
    is a panic button — "all downstairs off" on the way to bed. This reuses
    `_apply_action_to_room`, so a zone button and a zone schedule are the same
    code path, and each room's "Now showing" is credited to the zone rather than
    looking like someone set every room by hand."""
    zone = (config.get("zones", {}) or {}).get(req.zone_name)
    if not zone:
        raise HTTPException(404, f"No zone '{req.zone_name}'")
    if req.type not in ("power", "white", "color"):
        raise HTTPException(400, f"Unsupported zone action '{req.type}'")

    action = {"type": req.type, "brightness": req.brightness}
    if req.type == "power":
        action["on"] = True if req.on is None else bool(req.on)
    elif req.type == "white":
        action["kelvin"] = int(req.kelvin or 2700)
    else:
        action["rgb"] = {"r": req.r or 0, "g": req.g or 0, "b": req.b or 0}

    rooms = config.get("rooms", {})
    applied, skipped = [], []
    for member in zone.get("rooms", []):
        if member not in rooms:
            skipped.append(member)      # room deleted/renamed out from under the zone
            continue
        try:
            await _apply_action_to_room(member, action, "zone", req.zone_name)
            applied.append(member)
        except Exception:
            log.exception("Zone %r: room %r failed", req.zone_name, member)
            skipped.append(member)
    log.info("Zone %r %s → %d room(s)", req.zone_name, req.type, len(applied))
    publish_event("room", room=None)
    return {"success": True, "applied": applied, "skipped": skipped}


@app.delete("/api/zones/{zone_name}")
async def delete_zone(zone_name: str):
    zones = config.get("zones", {})
    if zone_name not in zones:
        raise HTTPException(404, f"No zone '{zone_name}'")
    del zones[zone_name]
    save_config(config)
    publish_event("config")
    return {"success": True}


# ─── Safe room rename ───────────────────────────────────────────────────────

class RoomRenameRequest(BaseModel):
    old_name: str
    new_name: str


@app.post("/api/rooms/rename")
async def rename_room(req: RoomRenameRequest):
    """Rename a room, migrating EVERY room-name-keyed structure and reference so
    nothing is orphaned. (POST /api/rooms upserts by name, so a UI 'rename' there
    would create a new empty room and strand the old one's layout/scenes/etc.)"""
    old, new = req.old_name, req.new_name.strip()
    rooms = config.get("rooms", {})
    if old not in rooms:
        raise HTTPException(404, f"Room '{old}' not found")
    if not new:
        raise HTTPException(400, "New room name is required")
    if new == old:
        return {"success": True}
    if new in rooms:
        raise HTTPException(409, f"A room named '{new}' already exists")

    # Move the key in every room-name-keyed sidecar dict.
    for key in ("rooms", "room_layouts", "room_color_state", "lightning_scenes",
                "room_presets", "room_last_applied"):
        d = config.get(key)
        if isinstance(d, dict) and old in d:
            d[new] = d.pop(old)

    # Repoint references held by value elsewhere.
    for sched in config.get("schedules", []) or []:
        action = sched.get("action") or {}
        if action.get("room") == old:
            action["room"] = new
    for zone in (config.get("zones", {}) or {}).values():
        zone["rooms"] = [new if r == old else r for r in zone.get("rooms", [])]

    save_config(config)
    publish_event("config")
    return {"success": True, "old_name": old, "new_name": new}


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
