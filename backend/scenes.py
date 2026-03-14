"""
Lightning scene engine for LightEmUp.

Manages lightning storm scenes: pre-generates random 30-second pattern buffers
per light, runs async background tasks to play them in a loop, snapshots light
states before starting and restores on stop.
"""

import asyncio
import logging
import random
from dataclasses import dataclass
from typing import Optional

from pydantic import BaseModel

from discovery import (
    get_hue_lights,
    set_hue_light_state,
    govee_lan_turn,
    govee_lan_brightness,
    govee_lan_color,
    govee_lan_color_temp,
    govee_lan_get_state,
    govee_razer_enable,
    govee_razer_disable,
    govee_razer_set_segments,
)

log = logging.getLogger("lightemup.scenes")

# ─── Settings ──────────────────────────────────────────────────────────────

PATTERN_DURATION_MS = 30_000  # 30 seconds of pre-generated pattern
H6061_SEGMENT_COUNT = 7
RAZER_KEEPALIVE_INTERVAL_S = 50  # re-enable before 60s timeout


class LightningSettings(BaseModel):
    """User-tuneable parameters for the lightning effect."""

    color_temp_kelvin: int = 6500
    use_color_temp: bool = True
    color_r: int = 220
    color_g: int = 240
    color_b: int = 255
    background_brightness: int = 10  # percent 0-100
    background_color_temp_k: int = 2700
    govee_flash: bool = False  # when False, Govee lights hold background color only
    min_gap_ms: int = 15000
    max_gap_ms: int = 60000
    flash_duration_min_ms: int = 50
    flash_duration_max_ms: int = 200
    burst_count_min: int = 1
    burst_count_max: int = 2
    inter_burst_gap_ms: int = 80


# ─── Pattern Generation ───────────────────────────────────────────────────


@dataclass
class Event:
    """A single lightning-pattern event.

    *delay_ms* is the time to sleep BEFORE executing this action.
    *action* is either ``"flash"`` (bright flash) or ``"dim"`` (return to
    background level).
    """

    delay_ms: int
    action: str  # "flash" | "dim"


def generate_pattern(settings: LightningSettings, seed: int = 0) -> list[Event]:
    """Generate ~30 seconds of lightning events for ONE light.

    The sequence alternates between dark gaps and bursts of rapid flashes.
    Deterministic for a given *seed*.

    Structure::

        [dim] -> gap -> [burst] -> gap -> [burst] -> ... until ~30 000 ms
    """
    rng = random.Random(seed)
    events: list[Event] = []
    elapsed_ms = 0

    # Start dim (no initial delay).
    events.append(Event(delay_ms=0, action="dim"))

    while elapsed_ms < PATTERN_DURATION_MS:
        # ── dark gap ───────────────────────────────────────────────────
        gap_ms = rng.randint(settings.min_gap_ms, settings.max_gap_ms)
        elapsed_ms += gap_ms

        if elapsed_ms >= PATTERN_DURATION_MS:
            break

        # ── burst ──────────────────────────────────────────────────────
        burst_count = rng.randint(settings.burst_count_min, settings.burst_count_max)
        first_flash = True
        for i in range(burst_count):
            # Delay before flash.
            if first_flash:
                flash_delay = gap_ms  # the dark gap precedes the first flash
                first_flash = False
            else:
                # Small inter-burst gap before subsequent flashes.
                flash_delay = rng.randint(30, settings.inter_burst_gap_ms)
                elapsed_ms += flash_delay

            if elapsed_ms >= PATTERN_DURATION_MS:
                break

            events.append(Event(delay_ms=flash_delay, action="flash"))

            # Flash duration (how long the flash stays bright).
            flash_dur = rng.randint(
                settings.flash_duration_min_ms, settings.flash_duration_max_ms
            )
            elapsed_ms += flash_dur

            if elapsed_ms >= PATTERN_DURATION_MS:
                # End with a dim so we don't leave a light blaring.
                events.append(Event(delay_ms=flash_dur, action="dim"))
                break

            events.append(Event(delay_ms=flash_dur, action="dim"))

    return events


# ─── Colour helpers ────────────────────────────────────────────────────────


def _kelvin_to_mirek(kelvin: int) -> int:
    """Convert colour temperature in Kelvin to mirek, clamped to Hue range."""
    mirek = 1_000_000 // max(kelvin, 1)
    return max(153, min(500, mirek))


def _scale_brightness_hue(pct: int) -> int:
    """Scale 0-100 percentage to Hue brightness range 1-254."""
    return max(1, min(254, round(pct * 254 / 100)))


# Warm amber used as Govee background when *use_color_temp* is False.
_GOVEE_BG_COLOR = (255, 180, 80)


# ─── SceneManager ─────────────────────────────────────────────────────────


class SceneManager:
    """Manages lightning storm scenes across rooms.

    Instantiated once at module level and imported by ``main.py``.
    """

    def __init__(self) -> None:
        # room_name -> scene state dict
        self.active_scenes: dict[str, dict] = {}
        # Hue bridge rate-limit guard (~10 req/s, allow max 8 concurrent).
        self._hue_semaphore = asyncio.Semaphore(8)

    # ── public API ─────────────────────────────────────────────────────

    async def start_lightning(
        self,
        room_name: str,
        room_config: dict,
        hue_ip: Optional[str],
        hue_username: Optional[str],
        settings: Optional[LightningSettings] = None,
    ) -> bool:
        """Start a lightning scene for *room_name*.

        *room_config* is the dict from ``config["rooms"][room_name]`` with
        keys ``hue_light_ids`` (list[str]) and ``govee_devices`` (list[str]).

        Returns ``True`` on success, ``False`` if the room is already active.
        """
        if room_name in self.active_scenes:
            return False

        if settings is None:
            settings = LightningSettings()

        hue_ids: list[str] = room_config.get("hue_light_ids", [])
        govee_ips: list[str] = room_config.get("govee_devices", [])

        # ── snapshot current state ────────────────────────────────────
        hue_snapshots: dict = {}
        govee_snapshots: dict = {}

        if hue_ip and hue_username and hue_ids:
            hue_snapshots = await self._snapshot_hue_lights(
                hue_ip, hue_username, hue_ids
            )

        if govee_ips:
            govee_snapshots = await self._snapshot_govee_devices(govee_ips)

        stop_event = asyncio.Event()
        tasks: list[asyncio.Task] = []

        # ── Hue tasks ─────────────────────────────────────────────────
        if hue_ip and hue_username:
            for idx, light_id in enumerate(hue_ids):
                pattern = generate_pattern(settings, seed=hash((room_name, "hue", light_id, idx)))
                task = asyncio.create_task(
                    self._run_hue_light(light_id, pattern, hue_ip, hue_username, settings, stop_event),
                    name=f"lightning-hue-{room_name}-{light_id}",
                )
                tasks.append(task)

        # ── Govee tasks ───────────────────────────────────────────────
        for idx, ip in enumerate(govee_ips):
            if not settings.govee_flash:
                # Background-only: set Govee lights to ambient background and leave them.
                task = asyncio.create_task(
                    self._set_govee_background(ip, settings),
                    name=f"lightning-govbg-{room_name}-{ip}",
                )
                tasks.append(task)
                continue

            # Determine if this is an H6061 that should use segment mode.
            segment_count = room_config.get("govee_segments", {}).get(ip, 0)

            if segment_count > 0:
                # Per-segment mode (H6061).
                seg_patterns = [
                    generate_pattern(settings, seed=hash((room_name, "seg", ip, s)))
                    for s in range(segment_count)
                ]
                task = asyncio.create_task(
                    self._run_govee_segments(ip, seg_patterns, settings, stop_event),
                    name=f"lightning-govseg-{room_name}-{ip}",
                )
                tasks.append(task)

                # Keepalive task.
                ka_task = asyncio.create_task(
                    self._razer_keepalive(ip, stop_event),
                    name=f"lightning-keepalive-{room_name}-{ip}",
                )
                tasks.append(ka_task)
            else:
                # Whole-device mode.
                pattern = generate_pattern(settings, seed=hash((room_name, "govee", ip, idx)))
                task = asyncio.create_task(
                    self._run_govee_device(ip, pattern, settings, stop_event),
                    name=f"lightning-govee-{room_name}-{ip}",
                )
                tasks.append(task)

        self.active_scenes[room_name] = {
            "tasks": tasks,
            "stop_event": stop_event,
            "snapshots": {
                "hue": hue_snapshots,
                "govee": govee_snapshots,
            },
            "settings": settings,
            "hue_ip": hue_ip,
            "hue_username": hue_username,
        }

        log.info("Lightning started for room %r (%d tasks)", room_name, len(tasks))
        return True

    async def stop_lightning(self, room_name: str) -> bool:
        """Stop a running lightning scene, restore prior light states.

        Returns ``True`` if a scene was stopped, ``False`` if the room was
        not active.
        """
        scene = self.active_scenes.pop(room_name, None)
        if scene is None:
            return False

        # Signal all tasks to stop.
        stop_event: asyncio.Event = scene["stop_event"]
        stop_event.set()

        # Wait for tasks to finish (with a safety timeout).
        tasks: list[asyncio.Task] = scene["tasks"]
        if tasks:
            await asyncio.wait(tasks, timeout=5.0)
            # Cancel any stragglers.
            for t in tasks:
                if not t.done():
                    t.cancel()

        # ── restore state ─────────────────────────────────────────────
        hue_ip = scene.get("hue_ip")
        hue_username = scene.get("hue_username")
        snapshots = scene.get("snapshots", {})

        if hue_ip and hue_username and snapshots.get("hue"):
            await self._restore_hue_lights(hue_ip, hue_username, snapshots["hue"])

        if snapshots.get("govee"):
            await self._restore_govee_devices(snapshots["govee"])

        log.info("Lightning stopped for room %r", room_name)
        return True

    def is_active(self, room_name: str) -> bool:
        return room_name in self.active_scenes

    def get_active_rooms(self) -> list[str]:
        return list(self.active_scenes.keys())

    # ── snapshot / restore ─────────────────────────────────────────────

    async def _snapshot_hue_lights(
        self, hue_ip: str, username: str, light_ids: list[str]
    ) -> dict:
        """Query and store current state for each Hue light.

        Returns ``{light_id: state_dict, ...}``.
        """
        snapshots: dict = {}
        try:
            all_lights = await get_hue_lights(hue_ip, username)
            by_id = {l["id"]: l["state"] for l in all_lights}
            for lid in light_ids:
                if lid in by_id:
                    snapshots[lid] = by_id[lid]
        except Exception as exc:
            log.warning("Failed to snapshot Hue lights: %s", exc)
        return snapshots

    async def _snapshot_govee_devices(self, device_ips: list[str]) -> dict:
        """Query Govee devices sequentially (port 4002 constraint).

        Returns ``{ip: state_dict, ...}``.
        """
        snapshots: dict = {}
        for ip in device_ips:
            try:
                state = await govee_lan_get_state(ip)
                if state is not None:
                    snapshots[ip] = state
            except Exception as exc:
                log.warning("Failed to snapshot Govee %s: %s", ip, exc)
        return snapshots

    async def _restore_hue_lights(
        self, hue_ip: str, username: str, snapshots: dict
    ) -> None:
        """Restore Hue lights to their snapshotted state."""
        for light_id, state in snapshots.items():
            try:
                restore: dict = {"on": state.get("on", False)}
                if state.get("on", False):
                    if state.get("brightness") is not None:
                        restore["bri"] = state["brightness"]
                    color_mode = state.get("color_mode")
                    if color_mode == "ct" and state.get("color_temp") is not None:
                        restore["ct"] = state["color_temp"]
                    elif color_mode == "hs":
                        if state.get("hue") is not None:
                            restore["hue"] = state["hue"]
                        if state.get("saturation") is not None:
                            restore["sat"] = state["saturation"]
                    elif color_mode == "xy" and state.get("xy") is not None:
                        restore["xy"] = state["xy"]
                    restore["transitiontime"] = 10  # 1 second fade-back

                async with self._hue_semaphore:
                    await set_hue_light_state(hue_ip, username, light_id, restore)
            except Exception as exc:
                log.warning("Failed to restore Hue light %s: %s", light_id, exc)

    async def _restore_govee_devices(self, snapshots: dict) -> None:
        """Restore Govee devices to their snapshotted state."""
        for ip, state in snapshots.items():
            try:
                was_on = state.get("on", False)
                if was_on:
                    await govee_lan_turn(ip, True)
                    if state.get("brightness") is not None:
                        await govee_lan_brightness(ip, state["brightness"])
                    color = state.get("color", {})
                    color_temp = state.get("color_temp", 0)
                    if color_temp and color_temp > 0:
                        await govee_lan_color_temp(ip, color_temp)
                    elif color:
                        await govee_lan_color(
                            ip,
                            color.get("r", 255),
                            color.get("g", 255),
                            color.get("b", 255),
                        )
                else:
                    await govee_lan_turn(ip, False)
            except Exception as exc:
                log.warning("Failed to restore Govee %s: %s", ip, exc)

    # ── per-light async runners ────────────────────────────────────────

    async def _set_govee_background(
        self, ip: str, settings: LightningSettings
    ) -> None:
        """Set a Govee device to the background color/brightness (no flashing)."""
        try:
            await govee_lan_turn(ip, True)
            await govee_lan_brightness(ip, settings.background_brightness)
            if settings.use_color_temp:
                await govee_lan_color_temp(ip, settings.background_color_temp_k)
            else:
                await govee_lan_color(ip, *_GOVEE_BG_COLOR)
        except Exception as exc:
            log.warning("Failed to set Govee background for %s: %s", ip, exc)

    async def _run_hue_light(
        self,
        light_id: str,
        pattern: list[Event],
        hue_ip: str,
        username: str,
        settings: LightningSettings,
        stop_event: asyncio.Event,
    ) -> None:
        """Loop *pattern* on a single Hue light until *stop_event* is set."""
        bg_bri = _scale_brightness_hue(settings.background_brightness)
        bg_ct = _kelvin_to_mirek(settings.background_color_temp_k)
        flash_ct = _kelvin_to_mirek(settings.color_temp_kelvin)

        while not stop_event.is_set():
            for event in pattern:
                if stop_event.is_set():
                    return

                # Sleep for the event's delay.
                if event.delay_ms > 0:
                    try:
                        await asyncio.wait_for(
                            stop_event.wait(), timeout=event.delay_ms / 1000.0
                        )
                        # If we get here the event was set — stop.
                        return
                    except asyncio.TimeoutError:
                        pass  # Normal — delay elapsed.

                # Build Hue state payload.
                if event.action == "flash":
                    if settings.use_color_temp:
                        state = {
                            "on": True,
                            "bri": 254,
                            "ct": flash_ct,
                            "transitiontime": 0,
                        }
                    else:
                        h, s = _rgb_to_hue_sat(
                            settings.color_r, settings.color_g, settings.color_b
                        )
                        state = {
                            "on": True,
                            "bri": 254,
                            "hue": h,
                            "sat": s,
                            "transitiontime": 0,
                        }
                else:
                    # dim
                    if settings.use_color_temp:
                        state = {
                            "on": True,
                            "bri": bg_bri,
                            "ct": bg_ct,
                            "transitiontime": 2,
                        }
                    else:
                        h, s = _rgb_to_hue_sat(*_GOVEE_BG_COLOR)
                        state = {
                            "on": True,
                            "bri": bg_bri,
                            "hue": h,
                            "sat": s,
                            "transitiontime": 2,
                        }

                try:
                    async with self._hue_semaphore:
                        await set_hue_light_state(hue_ip, username, light_id, state)
                except Exception as exc:
                    log.debug("Hue command failed for %s: %s", light_id, exc)

    async def _run_govee_device(
        self,
        ip: str,
        pattern: list[Event],
        settings: LightningSettings,
        stop_event: asyncio.Event,
    ) -> None:
        """Loop *pattern* on a whole Govee device until *stop_event* is set."""
        # Ensure the device is on before we start.
        try:
            await govee_lan_turn(ip, True)
        except Exception:
            pass

        while not stop_event.is_set():
            for event in pattern:
                if stop_event.is_set():
                    return

                if event.delay_ms > 0:
                    try:
                        await asyncio.wait_for(
                            stop_event.wait(), timeout=event.delay_ms / 1000.0
                        )
                        return
                    except asyncio.TimeoutError:
                        pass

                try:
                    if event.action == "flash":
                        await govee_lan_brightness(ip, 100)
                        if settings.use_color_temp:
                            await govee_lan_color_temp(ip, settings.color_temp_kelvin)
                        else:
                            await govee_lan_color(
                                ip, settings.color_r, settings.color_g, settings.color_b
                            )
                    else:
                        # dim
                        await govee_lan_brightness(ip, settings.background_brightness)
                        if settings.use_color_temp:
                            await govee_lan_color_temp(
                                ip, settings.background_color_temp_k
                            )
                        else:
                            await govee_lan_color(ip, *_GOVEE_BG_COLOR)
                except Exception as exc:
                    log.debug("Govee command failed for %s: %s", ip, exc)

    async def _run_govee_segments(
        self,
        ip: str,
        segment_patterns: list[list[Event]],
        settings: LightningSettings,
        stop_event: asyncio.Event,
    ) -> None:
        """Run merged per-segment lightning on an H6061 via Razer protocol.

        Each segment has its own pattern.  We merge all events onto a single
        timeline and call ``govee_razer_set_segments`` with the full colour
        array whenever any segment changes state.
        """
        num_segments = len(segment_patterns)

        # Determine flash / dim colours.
        if settings.use_color_temp:
            # Approximate white at colour-temp as RGB for Razer.
            flash_color = (255, 255, 255)
            dim_color = (60, 40, 20)  # warm amber approximation at low brightness
        else:
            flash_color = (settings.color_r, settings.color_g, settings.color_b)
            dim_color = (
                _GOVEE_BG_COLOR[0] * settings.background_brightness // 100,
                _GOVEE_BG_COLOR[1] * settings.background_brightness // 100,
                _GOVEE_BG_COLOR[2] * settings.background_brightness // 100,
            )

        # Build a merged timeline: list of (absolute_ms, segment_index, action).
        @dataclass
        class TimelineEvent:
            abs_ms: int
            segment: int
            action: str

        timeline: list[TimelineEvent] = []
        for seg_idx, pat in enumerate(segment_patterns):
            abs_time = 0
            for ev in pat:
                abs_time += ev.delay_ms
                timeline.append(TimelineEvent(abs_ms=abs_time, segment=seg_idx, action=ev.action))
        timeline.sort(key=lambda e: e.abs_ms)

        # Enable Razer mode.
        try:
            await govee_razer_enable(ip)
        except Exception as exc:
            log.warning("Failed to enable Razer mode for %s: %s", ip, exc)
            return

        while not stop_event.is_set():
            # Track per-segment state: start all dim.
            seg_states = ["dim"] * num_segments
            prev_abs = 0

            for tev in timeline:
                if stop_event.is_set():
                    return

                # Sleep the delta from the previous event.
                delta_ms = tev.abs_ms - prev_abs
                prev_abs = tev.abs_ms
                if delta_ms > 0:
                    try:
                        await asyncio.wait_for(
                            stop_event.wait(), timeout=delta_ms / 1000.0
                        )
                        return
                    except asyncio.TimeoutError:
                        pass

                seg_states[tev.segment] = tev.action

                # Build colour array.
                colors = []
                for s in range(num_segments):
                    if seg_states[s] == "flash":
                        colors.append(flash_color)
                    else:
                        colors.append(dim_color)

                try:
                    await govee_razer_set_segments(ip, colors)
                except Exception as exc:
                    log.debug("Razer segment command failed for %s: %s", ip, exc)

    async def _razer_keepalive(
        self, ip: str, stop_event: asyncio.Event
    ) -> None:
        """Send Razer enable every ~50 seconds to prevent auto-disable."""
        while not stop_event.is_set():
            try:
                await asyncio.wait_for(
                    stop_event.wait(), timeout=RAZER_KEEPALIVE_INTERVAL_S
                )
                return  # stop_event was set
            except asyncio.TimeoutError:
                pass

            try:
                await govee_razer_enable(ip)
                log.debug("Razer keepalive sent to %s", ip)
            except Exception as exc:
                log.debug("Razer keepalive failed for %s: %s", ip, exc)


# ─── RGB → Hue/Sat conversion ─────────────────────────────────────────────
# Duplicated from main.py to avoid circular imports.


def _rgb_to_hue_sat(r: int, g: int, b: int) -> tuple[int, int]:
    """Convert RGB (0-255) to Hue's hue (0-65535) and saturation (0-254)."""
    r_n, g_n, b_n = r / 255.0, g / 255.0, b / 255.0
    max_c = max(r_n, g_n, b_n)
    min_c = min(r_n, g_n, b_n)
    diff = max_c - min_c

    if diff == 0:
        hue = 0.0
    elif max_c == r_n:
        hue = (60.0 * ((g_n - b_n) / diff) + 360.0) % 360.0
    elif max_c == g_n:
        hue = (60.0 * ((b_n - r_n) / diff) + 120.0) % 360.0
    else:
        hue = (60.0 * ((r_n - g_n) / diff) + 240.0) % 360.0

    sat = 0.0 if max_c == 0 else diff / max_c

    return int(hue / 360.0 * 65535), int(sat * 254)


# ─── Module-level singleton ───────────────────────────────────────────────

scene_manager = SceneManager()
