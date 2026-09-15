"""Usage log (v3.49.0): which screens and actions each device actually uses.

The interface is being reorganized around how the household really uses it, and
four people use it very differently — one uses everything, two mostly set the
living room, one visits monthly. Guessing at frequency is how it became "a
collection of controls" in the first place, so this records it instead.

**It records WHAT was used, never content.** An event is a surface ("room:scenes",
"tab:schedules"), an optional action ("apply", "off"), and optionally the room or
device key it touched. No colors, no text anyone typed, no names beyond the room's.

**It lives OUTSIDE config.json, deliberately.** config.json is rewritten on every
change and ships in every backup; this is a stream of taps. Two files sit next to
this module instead, both gitignored:
  usage_log.jsonl     append-only, one event per line, rotated into .1 at MAX_BYTES,
                      so it can never take more than about 2 x MAX_BYTES of SD card
  usage_devices.json  device id -> name, first/last seen, screen width, browser

A device is a browser: the frontend keeps a random id in localStorage and the
owner names each one once in Settings. No logins.

Best-effort throughout. A diagnostic that can break a control is worse than none,
so nothing here raises into a request except a malformed device id.
"""
import json
import os
import re
import threading
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

HERE = Path(__file__).parent
LOG_PATH = HERE / "usage_log.jsonl"
DEVICES_PATH = HERE / "usage_devices.json"
MAX_BYTES = 8 * 1024 * 1024
MAX_EVENTS_PER_BATCH = 200
SESSION_GAP_S = 30 * 60        # a pause this long starts a new visit
LAST_SEEN_WRITE_S = 600        # don't rewrite the device file on every batch
MAX_EVENT_AGE_S = 3600         # an event queued longer than this is clamped

_ID_RX = re.compile(r"^[A-Za-z0-9_-]{6,64}$")
_EVENT_KINDS = {"open", "act"}
_lock = threading.Lock()
_devices_cache: Optional[dict] = None

# An OPEN of the surface on the left counts as "used" when an ACT on one of the
# surfaces on the right happens in the same visit. Opened-but-never-used is the
# number that says a screen is confusing — a plain tap count can't.
OPEN_ACT = {
    "room:scenes": {"scenes"},
    "room:controls": {"room", "light"},
    "room:lightshow": {"lightshow"},
    "room:lightning": {"lightning"},
    "tab:schedules": {"schedules"},
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def valid_id(device_id) -> bool:
    return isinstance(device_id, str) and bool(_ID_RX.match(device_id))


def browser_label(ua: str) -> Optional[str]:
    """'iPhone · Safari' from a user-agent — enough, with the screen width, to
    tell the household's phones apart before anyone names them."""
    ua = ua or ""
    dev = ("iPhone" if "iPhone" in ua else "iPad" if "iPad" in ua
           else "Android" if "Android" in ua else "Mac" if "Macintosh" in ua
           else "Windows" if "Windows" in ua else "Linux" if "Linux" in ua else "")
    br = ("Edge" if "Edg" in ua
          else "Chrome" if ("Chrome/" in ua or "CriOS" in ua)
          else "Firefox" if ("Firefox/" in ua or "FxiOS" in ua)
          else "Safari" if "Safari/" in ua else "")
    return " · ".join(x for x in (dev, br) if x) or None


def _clean_str(v, n: int = 48) -> Optional[str]:
    if v is None:
        return None
    s = str(v).strip()[:n]
    return s or None


def sanitize(ev) -> Optional[dict]:
    """Keep only the fields the log is for, bounded in size. Anything else —
    including any field that could carry content — is dropped, not stored."""
    if not isinstance(ev, dict) or ev.get("ev") not in _EVENT_KINDS:
        return None
    out = {"ev": ev["ev"]}
    for k in ("s", "a", "room", "key"):
        v = _clean_str(ev.get(k))
        if v:
            out[k] = v
    if "s" not in out:
        return None
    n = ev.get("n")
    if isinstance(n, int) and not isinstance(n, bool) and 1 < n <= 10000:
        out["n"] = n
    det = ev.get("detail")
    if isinstance(det, dict):
        clean = {}
        for k, v in list(det.items())[:8]:
            if isinstance(v, bool) or v is None or isinstance(v, (int, float)):
                clean[str(k)[:24]] = v
            elif isinstance(v, str):
                clean[str(k)[:24]] = v[:48]
        if clean:
            out["detail"] = clean
    return out


def _width(width) -> Optional[int]:
    try:
        w = int(width)
    except (TypeError, ValueError):
        return None
    return w if 0 < w < 10000 else None


def record(device_id: str, width, events, user_agent: str = "",
           sent_at: Optional[float] = None) -> int:
    """Append one batch from one browser. Returns how many events were kept.

    Times are the SERVER's clock, back-dated by each event's age as the browser
    measured it (`sent_at - at`), so a phone with a wrong clock can't scramble the
    order and a batch held for 15 seconds isn't all stamped at the same second."""
    if not valid_id(device_id):
        raise ValueError("bad device id")
    now = _now()
    w = _width(width)
    lines = []
    for raw in (events or [])[:MAX_EVENTS_PER_BATCH]:
        ev = sanitize(raw)
        if not ev:
            continue
        age = 0.0
        at = raw.get("at") if isinstance(raw, dict) else None
        if isinstance(sent_at, (int, float)) and isinstance(at, (int, float)):
            age = min(max((sent_at - at) / 1000.0, 0.0), MAX_EVENT_AGE_S)
        stamped = {"t": (now - timedelta(seconds=age)).isoformat(timespec="seconds"),
                   "d": device_id}
        if w:
            stamped["w"] = w
        stamped.update(ev)
        lines.append(json.dumps(stamped, separators=(",", ":")))
    with _lock:
        if lines:
            _append(lines)
        _touch_device(device_id, w, user_agent, now)
    return len(lines)


def _append(lines):
    try:
        if LOG_PATH.exists() and LOG_PATH.stat().st_size > MAX_BYTES:
            os.replace(LOG_PATH, LOG_PATH.with_suffix(".jsonl.1"))
    except OSError:
        pass
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def devices() -> dict:
    global _devices_cache
    if _devices_cache is None:
        try:
            _devices_cache = json.loads(DEVICES_PATH.read_text(encoding="utf-8"))
            if not isinstance(_devices_cache, dict):
                _devices_cache = {}
        except (OSError, ValueError):
            _devices_cache = {}
    return _devices_cache


def _save_devices(d: dict):
    try:
        tmp = DEVICES_PATH.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(d, indent=1, sort_keys=True), encoding="utf-8")
        os.replace(tmp, DEVICES_PATH)
    except OSError:
        pass


def _touch_device(device_id: str, width: Optional[int], ua: str, now: datetime):
    d = devices()
    iso = now.isoformat(timespec="seconds")
    e = d.get(device_id)
    changed = False
    if e is None:
        e = d[device_id] = {"first_seen": iso, "last_seen": iso}
        changed = True
    if width and e.get("width") != width:
        e["width"] = width
        changed = True
    b = browser_label(ua)
    if b and e.get("browser") != b:
        e["browser"] = b
        changed = True
    try:
        stale = (now - datetime.fromisoformat(e.get("last_seen"))).total_seconds() >= LAST_SEEN_WRITE_S
    except (TypeError, ValueError):
        stale = True
    if changed or stale:
        e["last_seen"] = iso
        _save_devices(d)


def set_name(device_id: str, name: Optional[str]):
    if not valid_id(device_id):
        raise ValueError("bad device id")
    with _lock:
        d = devices()
        iso = _now().isoformat(timespec="seconds")
        e = d.setdefault(device_id, {"first_seen": iso, "last_seen": iso})
        name = (name or "").strip()[:40]
        if name:
            e["name"] = name
        else:
            e.pop("name", None)
        _save_devices(d)


def _read(since: datetime) -> list:
    out = []
    for p in (LOG_PATH.with_suffix(".jsonl.1"), LOG_PATH):
        try:
            f = open(p, encoding="utf-8")
        except OSError:
            continue
        with f:
            for line in f:
                try:
                    e = json.loads(line)
                    t = datetime.fromisoformat(e["t"])
                except (ValueError, KeyError, TypeError):
                    continue
                if t >= since:
                    e["_t"] = t
                    out.append(e)
    out.sort(key=lambda e: e["_t"])
    return out


def _visits(events: list) -> list:
    visits, cur, last = [], [], None
    for e in events:
        if last is not None and (e["_t"] - last).total_seconds() > SESSION_GAP_S:
            visits.append(cur)
            cur = []
        cur.append(e)
        last = e["_t"]
    if cur:
        visits.append(cur)
    return visits


def summary(days: int = 42) -> dict:
    """Per device: visits, what it opened, what it did, which rooms, when, and —
    for the screens in OPEN_ACT — how often it opened one and did nothing there."""
    events = _read(_now() - timedelta(days=days))
    known = devices()
    per = defaultdict(list)
    for e in events:
        per[e.get("d")].append(e)

    rows = []
    for did in set(per) | set(known):
        evs = per.get(did, [])
        visits = _visits(evs)
        opens, acts, rooms = Counter(), Counter(), Counter()
        hours = [0] * 24
        for e in evs:
            if e["ev"] == "open":
                opens[e["s"]] += 1
            else:
                acts[e["s"] + (f" · {e['a']}" if e.get("a") else "")] += e.get("n", 1)
            if e.get("room"):
                rooms[e["room"]] += 1
            hours[e["_t"].astimezone().hour] += 1
        follow = {}
        for v in visits:
            opened = {e["s"] for e in v if e["ev"] == "open"}
            acted = {e["s"] for e in v if e["ev"] == "act"}
            for surface, uses in OPEN_ACT.items():
                if surface in opened:
                    f = follow.setdefault(surface, {"opened": 0, "used": 0})
                    f["opened"] += 1
                    if acted & uses:
                        f["used"] += 1
        meta = known.get(did, {})
        rows.append({
            "id": did,
            "name": meta.get("name"),
            "browser": meta.get("browser"),
            "width": meta.get("width"),
            "first_seen": meta.get("first_seen"),
            "last_seen": meta.get("last_seen"),
            "visits": len(visits),
            "active_days": len({e["_t"].astimezone().date() for e in evs}),
            "events": len(evs),
            "opens": opens.most_common(15),
            "acts": acts.most_common(20),
            "rooms": rooms.most_common(8),
            "by_hour": hours,
            "opened_then_used": follow,
        })
    rows.sort(key=lambda r: (-r["events"], r["last_seen"] or ""))
    return {"window_days": days, "total_events": len(events), "devices": rows}
