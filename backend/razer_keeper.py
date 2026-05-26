"""Keeps Govee razer-protocol devices showing the last-applied segment state.

The Govee razer LAN protocol auto-disables ~60 seconds after the last LED
data packet, after which the device reverts. For static palette/gradient
output we want the colors to persist, so we re-send the same segment
array every ``REFRESH_INTERVAL_S`` (well under the timeout).

Any whole-device V1 LAN command (turn/color/brightness) cancels the keeper
for that IP — the user has explicitly overridden segments and we don't
want a stale refresh fighting their new command. Lightning scenes also
cancel before they start.
"""

import asyncio
import logging

from discovery import govee_razer_enable, govee_razer_set_segments

log = logging.getLogger("lightemup.razer_keeper")

REFRESH_INTERVAL_S = 45  # well under the ~60s razer auto-disable


class RazerKeeper:
    def __init__(self) -> None:
        # ip -> {"sku": str, "colors": list[tuple[int,int,int]], "task": Task}
        self._state: dict[str, dict] = {}

    async def apply(self, ip: str, sku: str, colors: list[tuple[int, int, int]]) -> None:
        """Record the segment state for *ip* and start refreshing it.

        Caller is expected to have already sent the first razer packet; this
        spawns a task that re-sends the state every REFRESH_INTERVAL_S
        seconds. Replaces any prior keeper for the same IP.
        """
        self.cancel(ip)
        task = asyncio.create_task(self._refresh_loop(ip), name=f"razer-keeper-{ip}")
        self._state[ip] = {"sku": sku, "colors": list(colors), "task": task}

    def cancel(self, ip: str) -> None:
        """Stop refreshing *ip* (if it was being refreshed)."""
        entry = self._state.pop(ip, None)
        if entry and not entry["task"].done():
            entry["task"].cancel()

    def cancel_all(self) -> None:
        for ip in list(self._state.keys()):
            self.cancel(ip)

    def has(self, ip: str) -> bool:
        return ip in self._state

    async def _refresh_loop(self, ip: str) -> None:
        try:
            while True:
                await asyncio.sleep(REFRESH_INTERVAL_S)
                entry = self._state.get(ip)
                if not entry:
                    return
                try:
                    await govee_razer_enable(ip)
                    await govee_razer_set_segments(ip, entry["colors"])
                    log.debug("Razer keepalive refreshed %s", ip)
                except Exception as exc:
                    log.warning("Razer keepalive refresh failed for %s: %s", ip, exc)
        except asyncio.CancelledError:
            pass


razer_keeper = RazerKeeper()
