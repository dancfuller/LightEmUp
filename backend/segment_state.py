"""In-memory tracker of last-known per-segment colors per Govee device IP.

Stores colors at their *full-brightness* (100%) value plus a separate
device-level brightness multiplier (0-100). The actual packet sent to the
device is the colors scaled by brightness. Keeping them separate lets the
brightness slider on the LightCard re-scale and re-send without losing
the segment colors.

Populated whenever the backend sends a per-segment command (razer bulk or
cloud_v2 single). Cleared when a whole-device command overrides segments,
or when a lightning scene takes over the device.

Ephemeral — survives only as long as the server process. After a restart
the UI will show "no segment colors known" until the user re-applies.
"""

# ip -> { "colors": {idx: (r,g,b) at 100% bri}, "brightness": int 0..100 }
_state: dict[str, dict] = {}


def _entry(ip: str) -> dict:
    e = _state.get(ip)
    if e is None:
        e = {"colors": {}, "brightness": 100}
        _state[ip] = e
    return e


def set_bulk(ip: str, colors: list[tuple[int, int, int]], brightness: int = 100) -> None:
    _state[ip] = {
        "colors": {i: tuple(c) for i, c in enumerate(colors)},
        "brightness": max(0, min(100, brightness)),
    }


def set_one(ip: str, idx: int, r: int, g: int, b: int) -> None:
    e = _entry(ip)
    e["colors"][idx] = (r, g, b)


def set_brightness(ip: str, brightness: int) -> bool:
    e = _state.get(ip)
    if not e:
        return False
    e["brightness"] = max(0, min(100, brightness))
    return True


def get(ip: str) -> dict | None:
    return _state.get(ip)


def clear(ip: str) -> None:
    _state.pop(ip, None)


def snapshot() -> dict:
    """JSON-serializable view of every device's segment state."""
    out = {}
    for ip, e in _state.items():
        out[ip] = {
            "colors": {str(i): list(c) for i, c in e["colors"].items()},
            "brightness": e["brightness"],
        }
    return out
