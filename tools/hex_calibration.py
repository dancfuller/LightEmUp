"""Hex Lights calibration: how much dimmer should the Hex Lights be than the rest
of the Living Room, per color and level?

For each room level (75, 50, 25, 5%) and each color of the rainbow (ROYGBIV), it
sets the whole Living Room to that color at that level, Hex Lights included. You
then adjust the Hex Lights (their card in LightEmUp, or the Govee app) until they
sit right with the room and press Enter. The script reads the Hex Lights' level
back from the Pi, so there's nothing to type. You can also type a number to
record that level instead, or "s" to skip a step.

Results go to hex_calibration.csv beside this script, plus a summary at the end.
When you finish or quit, the room is put back to the look it had before.

Run it from a real terminal (it waits for you between steps):
    python tools/hex_calibration.py
Uses only the standard library. Talks to http://lightemup:8420 by default; pass
another base URL as the first argument.
"""

import csv
import json
import sys
import time
import urllib.request
from pathlib import Path

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://lightemup:8420").rstrip("/")
ROOM = "Living Room"
HEX_SLUG = "2d3acc323233095a"          # govee:2d3acc323233095a = "Hex Lights"
LEVELS = [75, 50, 25, 5]
# Fully saturated, brightest channel at 255 for every color, so a Govee light (which
# takes raw RGB) isn't dimmed by the color itself: a dark-looking RGB like the usual
# indigo (75,0,130) would skew the comparison.
COLORS = [
    ("Red",    (255,   0,   0)),
    ("Orange", (255, 128,   0)),
    ("Yellow", (255, 255,   0)),
    ("Green",  (  0, 255,   0)),
    ("Blue",   (  0,   0, 255)),
    ("Indigo", ( 85,   0, 255)),
    ("Violet", (170,   0, 255)),
]
OUT = Path(__file__).with_name("hex_calibration.csv")


def api(path, body=None, timeout=30):
    req = urllib.request.Request(
        BASE + path, method="POST" if body is not None else "GET",
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"null")


def slug(d):
    return d.get("mac", "").replace(":", "").lower()


def find_hex(devices):
    return next((d for d in devices if slug(d) == HEX_SLUG), None)


def room_lights():
    """The room's Hue light ids and Govee (ip, mac) pairs."""
    room = api("/api/config")["rooms"][ROOM]
    by_slug = {slug(d): d for d in api("/api/discover/govee/cached")["devices"]}
    govee = [(by_slug[s]["ip"], by_slug[s]["mac"]) for s in room.get("govee_devices", [])
             if s in by_slug]
    if HEX_SLUG not in by_slug:
        sys.exit("Couldn't find the Hex Lights on the Pi.")
    return [str(i) for i in room.get("hue_light_ids", [])], govee


def read_hex_level():
    """A live LAN read (a few seconds), so a change made in the Govee app counts too."""
    d = find_hex(api("/api/discover/govee", timeout=60)["devices"])
    return (d or {}).get("state", {}).get("brightness")


def set_step(hue_ids, govee, rgb, level):
    # Light by light, NOT a room command: a room command rewrites the room's
    # "Now showing" record, and the end of the run puts the room back from that
    # record. This way it still names the look from before the test.
    r, g, b = rgb
    for lid in hue_ids:
        api("/api/hue/light", {"light_id": lid, "on": True, "r": r, "g": g, "b": b,
                               "brightness": max(1, round(level * 254 / 100))})
    for ip, mac in govee:
        api("/api/govee/control", {"ip": ip, "mac": mac, "on": True,
                                   "r": r, "g": g, "b": b, "brightness": level})


def summary(rows):
    if not rows:
        return
    print("\nHex Lights level as a share of the room's level:")
    print(f"{'':8}" + "".join(f"{lv:>7}%" for lv in LEVELS) + "   average")
    for name, _ in COLORS:
        cells, shares = [], []
        for lv in LEVELS:
            hit = [r for r in rows if r["color"] == name and r["room_level"] == lv]
            if hit:
                s = hit[0]["hex_level"] / lv
                shares.append(s)
                cells.append(f"{hit[0]['hex_level']:>4} {round(s * 100):>2}%"[-8:])
            else:
                cells.append(f"{'-':>8}")
        avg = f"{round(sum(shares) / len(shares) * 100)}%" if shares else "-"
        print(f"{name:8}" + "".join(cells) + f"   {avg:>6}")
    print(f"\nSaved to {OUT}")


def main():
    if ((api("/api/lightshow").get("shows") or {}).get(ROOM) or {}).get("running"):
        sys.exit("The Living Room has a light show running. Stop it first, or it "
                 "will keep changing the colors under the test.")
    hue_ids, govee = room_lights()
    before = (api("/api/config").get("room_last_applied") or {}).get(ROOM)
    print(f"Living Room calibration — {len(LEVELS) * len(COLORS)} steps.")
    print("At each step: adjust the Hex Lights, then press Enter.")
    print("Or type a level (e.g. 32) to record that, 's' to skip, 'q' to quit.\n")
    rows = []
    try:
        for level in LEVELS:
            for name, rgb in COLORS:
                set_step(hue_ids, govee, rgb, level)
                while True:
                    ans = input(f"[room {level:>2}%] {name:<7} — adjust the Hex Lights, then Enter: ").strip().lower()
                    if ans == "q":
                        raise KeyboardInterrupt
                    if ans == "s":
                        hex_level = None
                        break
                    if ans.isdigit() and 1 <= int(ans) <= 100:
                        hex_level = int(ans)
                        break
                    if ans == "":
                        print("   reading the Hex Lights…", end="", flush=True)
                        hex_level = read_hex_level()
                        if hex_level:
                            print(f" {hex_level}%")
                            break
                        print(" no answer — try Enter again, or type the level.")
                        continue
                    print("   Enter, a number 1–100, 's' or 'q'.")
                if hex_level is None:
                    continue
                rows.append({"color": name, "rgb": "%d,%d,%d" % rgb, "room_level": level,
                             "hex_level": hex_level,
                             "share_pct": round(hex_level / level * 100),
                             "at": time.strftime("%Y-%m-%d %H:%M:%S")})
                with OUT.open("w", newline="") as f:      # rewritten every step
                    w = csv.DictWriter(f, fieldnames=list(rows[0]))
                    w.writeheader()
                    w.writerows(rows)
    except (KeyboardInterrupt, EOFError):
        print("\nStopped.")
    summary(rows)
    if before:
        try:
            api("/api/rooms/reapply", {"room_name": ROOM})
            print(f"Living Room put back to: {before.get('label', 'its previous look')}")
        except Exception as e:
            print(f"Couldn't put the room back ({e}). Use \"Set here\" in its header.")


if __name__ == "__main__":
    main()
