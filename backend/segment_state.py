"""In-memory tracker of last-known per-segment colors per Govee device IP.

Populated whenever the backend sends a per-segment command (razer bulk or
cloud_v2 single). Cleared when a whole-device command overrides segments,
or when a lightning scene takes over the device. Read by the UI so the
LightCard and room map can show real segment state instead of the stale
whole-device color.

Ephemeral — survives only as long as the server process. After a restart
the UI will show "no segment colors known" until the user re-applies.
"""

_state: dict[str, dict[int, tuple[int, int, int]]] = {}


def set_bulk(ip: str, colors: list[tuple[int, int, int]]) -> None:
    _state[ip] = {i: tuple(c) for i, c in enumerate(colors)}


def set_one(ip: str, idx: int, r: int, g: int, b: int) -> None:
    _state.setdefault(ip, {})[idx] = (r, g, b)


def clear(ip: str) -> None:
    _state.pop(ip, None)


def snapshot() -> dict:
    """Returns a JSON-serializable view: {ip: {str(idx): [r,g,b]}}."""
    return {
        ip: {str(idx): list(c) for idx, c in segs.items()}
        for ip, segs in _state.items()
    }
