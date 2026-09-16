# backend/ — Server internals

FastAPI app. Entry: `main.py` (all endpoints). Device I/O: `discovery.py`. Scene
engine: `scenes.py`. Version: `version.py`. See the root `CLAUDE.md` for workflow
rules (versioning, commits, deploy). **Keep this file current when behavior changes.**

## Frontend cache-busting (v2.19.8)
`GET /` (`serve_frontend`) doesn't just `FileResponse` index.html — it reads it and
rewrites every local `src="js/*.js"` to `src="js/*.js?v=<GIT_HASH>"`, and serves the
shell with `Cache-Control: no-cache`. The `js/*.js` files have no content hash and
browsers cache them hard, so before this a deploy kept running stale scripts until a
manual hard-refresh (and the footer version comes from the API, so it *looked* updated).
`GIT_HASH` is resolved at import, so it changes when the service restarts — which every
deploy does — auto-busting the cache. CDN `<script src="https://…">` tags are left alone.

## Config persistence
- `config.json` (gitignored; template `config.json.example`) is read at startup and
  rewritten on every mutation. Use the existing save helper in `main.py` — don't
  hand-roll JSON writes.
- **Atomic + crash-safe (v2.19.10)**: `save_config` writes a temp file in the same
  dir, `fsync`s it, copies the current good file to a rolling `config.json.bak`, then
  `os.replace()`s (atomic rename) and fsyncs the directory. A power loss can therefore
  never leave a truncated config — you get either the complete old or complete new file.
  `load_config` tolerates a corrupt/empty config.json by restoring the newest valid
  backup (`config.json*.bak`, incl. manual `.recovered-*.bak`) instead of falling back
  to `DEFAULT_CONFIG` — that fallback would wipe rooms/nicknames on the next mutation.
  This replaced the old `open(...,"w")` path, which truncated the real file *before*
  writing (an outage mid-write = total loss; the fix was prompted by exactly that).
- Keys include: bridge creds, room assignments, nicknames, room layouts, scene
  settings, `ct_correction`, `ct_rgb`, per-room color state (incl. `shuffle_seed`,
  `target_vendor`), device modes, segment fill modes.

## Govee LAN (UDP) — two send paths, pick the right one
- Control commands (turn / brightness / colorwc / color_temp) **get no UDP reply.**
  Use `govee_lan_send()` — fire-and-forget, returns immediately.
  - This is the v2.9.3 fix: the old path waited up to 3s on `recvfrom` for a reply
    that never comes, so every color/brightness command blocked the full timeout and
    sliders/calibration were "brutally slow."
- Only `devStatus` replies. `govee_lan_command()` (with the 3s recv wait) is for
  **status queries only.**
- Port 4002 can only be bound by one socket at a time; status queries must be
  sequential, not parallel. `SO_REUSEADDR` + random-port fallback live in `discovery.py`.

## Govee per-segment (cloud_v2 V2 API) — rate-limited, batch it
- Segmented SKUs (hexa `H6061`, globe `H70C1`, rope `H61D3` — all 15 segments) use
  the cloud V2 API, which is rate-limited. One call per segment overran the limit and
  dropped later segments (they stuck on the base color).
- `govee_v2_segments_color(api_key, sku, mac, segments: list, r, g, b)` sets a **list**
  of segment indices to one RGB in a single call (`segmentedColorRgb` accepts a list).
  Endpoint: `POST /api/govee/segments-multi`. The frontend batches segments by color →
  ~6 calls for a white palette instead of ~30 (v2.10.0). Stagger ~1.8s between calls.
- The Razer per-segment protocol is the alternative but auto-reverts after 60s without
  keepalive packets — prefer cloud_v2 for set-and-leave scenes.
- **Dimming a segmented device is ONE LAN command, not N cloud calls.**
  `POST /api/govee/segments-brightness` sends `govee_lan_brightness` for cloud_v2: the
  persistent `segmentedColorRgb` colors are device state and survive it, so there is no
  reason to pay 1.8s per segment to change a level. Only **razer** needs stored segment
  state (it rebuilds its whole packet from the colors); cloud_v2 no longer 400s without
  it (v3.35.2), since refusing there just left the dimmer dead until a scene had been
  applied once. Anything in the UI offering a brightness control for a segmented device
  should call this — **never** re-run a scene to change brightness.

## Govee discovery reliability & device identity (v2.16.0)
A single UDP scan burst is lossy — Govee devices routinely miss one — so discovery
is built to tolerate that, and to treat IP as ephemeral:
- **Multi-burst scan** (`discover_govee_lan`): one rescan re-broadcasts the scan
  several times across the `timeout` window (default 6s) and keeps listening, deduping
  replies by **device id** (not IP). A dropped packet no longer "loses" a device.
- **Assume-presence** (`discover_govee`): every reply is marked `responding: True`;
  every *known* device (`config.known_devices.govee`, keyed by device id/MAC) that
  didn't reply is appended as a `responding: False` entry rendered from `device_state`
  (last-known color/on/brightness, `state.reachable = False`). Control is fire-and-
  forget UDP to the stored IP, so absent devices stay fully controllable — the UI just
  badges them offline. `missing` is still returned for the Settings forget affordance.
- **Identity is the device id (mac), IP is DHCP — now MAC-keyed (v3.0.0).** Every stored
  Govee association keys by a **colon-free slug of the mac** (`gv_slug` = mac lowercased,
  `:`/`-` stripped); `known_devices.govee` (keyed by pretty mac → current IP) is the
  registry, and the **IP is resolved at send time**, not stored as identity. A DHCP IP
  change no longer orphans anything.
  - **Helpers (main.py):** `gv_slug(mac)`, `gv_key(mac)` → `"govee:<slug>"`,
    `gv_mac_for_ip(ip)` (reverse lookup via known_devices), `gv_key_for_ip(ip, mac=None)`
    and `gv_slug_for_ip(...)` (prefixed / bare key for a device addressed by IP), and
    `gv_ip_for_slug(slug)` (stored slug → current IP; a slug that *is* an IP resolves to
    itself). Persistence helpers (`record_govee_state`, `correct_kelvin`, `ct_rgb_color`,
    `persist_segments`) key by mac via these; `record_govee_state`/segment/identify
    requests carry an optional `mac` (falls back to IP reverse-lookup).
  - **Identity vs address at the boundary:** `control_room` and `start_lightning` resolve
    each room member slug → current IP before driving the device, and `start_lightning`
    also resolves fixtures' govee members slug→IP — so **`scenes.py` stays identity-
    agnostic** (still works in IPs). The in-memory `segment_state` is IP-keyed (the live
    address); it's mapped slug↔IP on `load`/`persist_segments`.
  - **One-time migration:** `migrate_govee_to_mac(cfg)` runs once at load (guarded by
    `schema_version` → 2), backs up to `config.json.pre-mac-migration.bak`, re-keys every
    IP-based structure (rooms lists, `govee:<ip>` dicts, segment mode/counts, room-layout
    device/segment keys, fixture members) to slugs via known_devices, and **drops +
    logs** any IP it can't resolve (device offline / IP changed at migration time). So
    power on all Govee lights + assign them to rooms *before* the migrating deploy, or
    those orphaned references are lost. A DHCP reservation per light is still nice-to-have
    but no longer required.

## Send reliability: Govee double-send + Hue verify-and-repair (v3.10.0)
A bulk "room off" once left a single lamp on **while its PUT logged HTTP 200**. That's
the key insight: the bridge returns 200 as soon as it *queues* a command, so a Zigbee
delivery failure downstream is invisible at the HTTP layer — **retrying on a non-200
fixes nothing.** The two vendors need opposite treatments:
- **Govee = blind repeat.** `govee_lan_send` (discovery.py) is unacknowledged UDP, so a
  dropped datagram silently loses the command. Every control packet is now sent **twice**,
  `GOVEE_RESEND_DELAY_S` (0.12s) apart. The duplicate is scheduled as a background task and
  **not awaited**, so callers pay zero added latency (a room apply issues turn+brightness+
  color per device; awaiting duplicates would add seconds). The gap is deliberate —
  back-to-back datagrams tend to be lost together. `repeat=False` opts out. **Razer segment
  sends (`_govee_lan_send`) are deliberately excluded** — `razer_keeper` already resends
  frames on its own cadence, so doubling there is pure waste.
- **Hue = read it back.** `_hue_verify_repair(expectations)` (main.py) does **one**
  `get_hue_lights()` (a single request no matter how many lights) and re-sends only to
  lights that didn't take. **Only `on` and `bri` are
  compared** — color (xy/ct) is NOT, because the bridge gamut-clamps and rounds it, so
  exact comparison would false-repair forever. Unreachable lights are skipped (a re-send
  wouldn't land either). **`bri` is only compared while the light is ON** — verified live
  that most bulbs simply refuse a level change while off (a brightness-only command to a
  dark room left 7 of 9 lights unchanged, *identically* across 3 retries — deterministic
  device behavior, not packet loss), so checking `bri` on an off light would re-send
  forever for no gain. `control_hue_light` echoes back the `state` it sent so bulk
  callers collect faithful expectations, and the repair re-sends that **full** dict — so a
  repaired light keeps its color, not just on/brightness.

### Govee verify-and-repair — POWER ONLY (v3.31.0)
The Govee half of v3.10.0 was a **blind** double-send, and blind is exactly the problem:
`govee_lan_send` returns when the datagram leaves the box, so `control_room`'s
`"success": True` never meant more than *issued*. A device that isn't on the LAN at all
receives neither copy and nothing noticed.

**The case that forced it (2026-08-13):** the sunrise `Exterior On (end)` turned 7 of 9
outdoor devices off; the two patio bulbs stayed lit all day while the room's strip read
*Turned off*. Both took an identical off instantly that evening, so they were simply
unreachable at 06:10 — and every layer reported success. Addressing was fine (the macs
mapped to the same IPs before and after), so **this was not a DHCP miss**; don't go
looking for one next time.

- **`schedule_govee_verify({ip: (want_on, room)})`** mirrors `schedule_hue_verify`:
  synchronous, coalesced into `_govee_verify_pending`, drained once by
  `_govee_verify_drain` after `GOVEE_VERIFY_SETTLE_S`. A zone off spanning several rooms
  costs one pass. Registered from `control_room` whenever `on` is present — which covers
  the room toggle, `_apply_room_power`, zone control, schedule ends and reapply.
- **ON/OFF ONLY. Never color.** devStatus reports `onOff` reliably; color it does not,
  and a Govee-app animation isn't a static state at all. Verifying color would
  manufacture the false confidence the whole area exists to avoid.
- **Three outcomes, and the last two are different things.** Took it ⇒ silent. Wrong state
  ⇒ the command was lost, so re-send **once** and re-read to confirm (never a loop). **No
  reply ⇒ the device is off the LAN, so do NOT re-send** — a second datagram can't land
  either — and report it. That last case is the one the old code recorded as success.
- **Reads are sequential and that's inherent**: every Govee device answers on port 4002
  and only one socket may hold it. `discovery.py` now owns a `_govee_state_lock` around
  `govee_lan_get_state` so no caller has to remember (the scene engine and discovery both
  read state too). It's O(devices) round-trips ⇒ **background task only, never in a
  request**.
- **`record_govee_state` still records INTENT, deliberately.** It's what power recovery
  replays after an outage, and replaying a command that failed to land is not a recovery.
  What actually happened is reported separately, on the room record.
- **The outcome is ALWAYS logged, including the all-clear (v3.32.0)** —
  `Govee verify: N device(s) - N already correct, N repaired, N unreachable, N still
  wrong`. The happy path used to be silent, which is the worst possible record for the
  fire that matters most: a 6am scheduled off nobody is awake to watch. When the porch was
  found lit hours later, "no warnings in the journal" could not distinguish *read all
  seven back, all off* from *the verify never ran* — so it proved nothing and the
  investigation stalled on an inference. **Don't make this conditional again.**
- **`_mark_room_not_applied` writes `govee_failed: [device labels]` onto
  `room_last_applied[room]`** — stored ON the entry so it dies the moment a new look is
  recorded. A stale "didn't take" outliving the problem would be its own lie.

### The fast verify is BLIND to a silent Zigbee drop (v3.42.2)
`GET /lights` is answered from the **bridge's own state model**, and the bridge
updates that model the moment it accepts a command for a light it believes is
`reachable` — it does not read the bulb back. So a read 0.6s later sincerely
reports `on: true` whether or not the frame ever reached the bulb. The fast verify
catches the bridge **disagreeing** with us (the "bri won't change while off" case
that produced v3.10.0); it cannot catch the mesh **losing** a command.

**2026-09-02, and this is the worked example to keep.** The sunset palette fired at
19:32:02 and PUT `{on, bri:254, xy}` to light 28. Verify passes at 19:32:03 (+0.6s)
and 19:32:14 both found nothing to repair. Nothing else wrote to that light all
evening — and it was dark, with the bridge still holding `bri: 254,
reachable: true`. Light 29 took the same command and sat at `bri: 2`.

**`schedule_hue_late_verify(expectations, reason)`** adds a SECOND pass
`HUE_LATE_VERIFY_S` (150s) later, by which time the bridge has converged on what
the bulbs actually report. It reuses `_hue_verify_repair` unchanged, so the
comparison rules and the unreachable-skip are identical.
- **Scheduled applies ONLY** *(superseded: every apply arms it since v3.42.3, and since v3.48.3 it never reverses a newer command — see "A newer command wins"; every power command arms it too since v3.50.0)*. A late repair re-asserts a look minutes after the
  fact, so if someone had deliberately switched one light off in the meantime it
  would fight them. On a schedule, the firing happened while nobody was in the
  room — exactly when this failure goes unnoticed for hours and when a manual
  change in the window is least likely. Armed from `_run_scene_apply` (covers
  scheduled scenes AND palette fires), `_apply_room_white`, `_apply_room_color`,
  and `_apply_room_power` (which reads the expectation `control_room` just
  recorded, so the sunrise OFF is covered too).
- `_reconcile_expectations` is bounded to `EXPECT_RECONCILE_WINDOW_S` (45s), so at
  150s the late pass repairs without rewriting the stored expectation. That's the
  right split and it falls out for free.
- **Both front-door bulbs are `AE 282 C` — third-party Zigbee, not Philips.** They
  are the two lights that keep producing these reports. Software can recover a
  dropped command; it cannot make a flaky bulb reliable.
- **EVERY whole-room apply arms it now, not just scheduled ones (v3.42.3).** A
  manual palette lost a light on 2026-09-03 with the user watching. Manual applies
  get `HUE_APPLY_VERIFY_S` (25s) — long enough for the bridge to stop echoing us,
  short enough not to fight someone who changed their mind — and schedules keep the
  150s window.
- **The late pass compares COLOR; the fast one still must not (v3.42.3).** That
  case had the light ON at a plausible brightness and simply wearing the PREVIOUS
  scene's color: asked `[0.1597, 0.2084]`, still showing `[0.5172, 0.4457]` from the
  apply before it. `on`/`bri` alone can miss that entirely. `compare_color=True`
  uses `HUE_XY_REPAIR_TOL` (0.15), chosen from measurements on this bridge: every
  light that TOOK the command reported its color back to four decimals **exactly**,
  the worst observed gamut clamp is ~0.08, and this miss was 0.43. The fast 0.6s
  pass stays color-blind on purpose — the bridge is still echoing our own command
  back at that point, so the comparison would prove nothing, and a tight color check
  there is the re-send-forever trap that kept color out of this function originally.
- **`_reconcile_expectations` now refuses to absorb a miss** (same tolerance). It
  exists for CLAMPING, which is small; rewriting the expectation to a wildly
  different color would erase the only evidence of the drop and leave both the
  repair and "Changed since" blind. The brightness guard catches most of these —
  it is what saved the evidence on 2026-09-03 — and the distance guard catches a
  miss that happens to land on the right brightness.
- **`delay` is resolved at CALL time, not as a default argument.** A default binds
  the constant at import, so overriding `HUE_LATE_VERIFY_S` afterwards is silently
  ignored. The test caught exactly that.
- Covered by `test_late_verify.py` (9 assertions), whose fake bridge lies
  optimistically and then tells the truth. **Its state dicts use `brightness`, not
  `bri`** — `get_hue_lights` normalizes the raw v1 shape and the repair reads the
  normalized one, so a fake using the raw key reads brightness as 0 and "repairs" a
  perfectly healthy room. The first draft of that test did exactly that.

### Coalescing + what gets verified (v3.10.1)
Callers never invoke `_hue_verify_repair` directly — they call **`schedule_hue_verify(
{light_id: state_as_sent})`**, which is synchronous and cheap: it merges into a module-level
`_hue_verify_pending` map and ensures the single `_hue_verify_drain` task is running. The
drain waits `HUE_VERIFY_SETTLE_S`, verifies **everything queued in one pass**, then loops if
more arrived meanwhile. So *any* number of commands landing in a settle window share **one**
GET, and no caller ever waits out the settle. This matters because `app.js` fans room and
"Unassigned" controls out **client-side** through `/api/hue/light` — one request per light —
which without coalescing would cost a GET per light. A later expectation for the same light
overwrites the earlier one (more recent intent wins).

**`control_hue_light` now self-verifies, but only when `on` is present in the request.**
That's an exact proxy for "discrete, settled action" in this UI: the card's toggle sends
`{on}` and a color/CT pick sends `{on:true, …}`, whereas the brightness and color-wheel
**drags** send `{brightness}` / `{r,g,b}` with no `on`. Drags commit every 180ms
(`useThrottledControl`), so verifying them would mean a GET per tick against a bridge with a
~10 cmd/sec ceiling. Two consequences worth knowing: a color-only change is **unverifiable**
by design (xy/ct aren't compared), so a color pick only confirms the light turned *on*; and
the repair re-sends via `set_hue_light_state` directly, never `control_hue_light`, so it
cannot recursively re-register — exactly one repair attempt per pass.

Bulk paths (`control_room`, `_run_scene_apply`'s `do_hue`, the scheduler's
`_apply_room_white`/`_apply_room_color`) register **one batch** for the whole run and set the
`_in_bulk_hue` ContextVar so their inner `control_hue_light` calls skip self-verifying. Without
that guard the *staggered* scene apply would trigger a read-back every settle window for the
entire apply. It's a ContextVar, so per-task: `do_hue` runs under `asyncio.gather` (each
coroutine gets its own context copy) and normal concurrent UI requests are unaffected.
**When you add a new bulk Hue path, collect `res["state"]`, set `_in_bulk_hue`, and hand the
batch to `schedule_hue_verify`.**

## Setting a level on an OFF light must not turn it on (v3.45.0)
"Before turning a room on I wanted to set its brightness, so it comes on at that
level. Moving the slider turned the light on instead."

Two different causes wearing one symptom:
- **The ROOM slider sent `on: true` alongside the level.** The app itself switched
  the room on. That was ours, and it is simply gone.
- **The per-light slider sent level only** — but a Govee LAN brightness command
  wakes most devices, so at the wire level there is no "brightness while off" to
  be had. Hue is gentler (this repo's own live test found most bulbs refuse a
  level change while off), which also means the level would not have stuck anyway.

So the only honest fix is to **send nothing at all**. `defer` on the three control
requests means "the caller is showing this device as OFF": the level is stored in
`config["pending_brightness"]` (device-keyed) and applied on the next power-on,
then cleared.
- **The caller reports the state; the backend owns the policy.** Deliberately not
  inferred from `device_state` — that is recorded INTENT and can be stale, so a
  light someone else switched on would get its dim silently swallowed. The client
  renders live bridge/discovery state, so its view is the fresher one.
  **v3.50.0:** only as fresh as its last refresh, it turned out — so for Hue the
  backend now also asks the bridge (see "The Fable review's first five").
- **An explicit level always supersedes a pending one** and clears it, so a scene
  or a white preset can never be undone by a level chosen hours earlier.
- **`control_room` needed the consume logic separately**, because it drives
  `set_hue_light_state` / `govee_lan_*` directly instead of going through
  `control_hue_light` / `control_govee`. Without that, "set the level, then turn
  the room on" silently lost the level — caught by `test_defer.py`, not by reading.
- Config-key checklist: declared in `DEFAULT_CONFIG`, listed in `_SETTING_INTERNAL`
  (it is consumed within minutes and would be noise in a restore preview), not
  room-keyed so `rename_room`/`delete_room` are unaffected, and added to
  `_purge_hue_light` so a removed phantom leaves no orphan level.
- Covered by `test_defer.py` (18 assertions), which asserts on the WIRE: nothing
  is sent while off, the level lands on the next on for Hue, Govee and a whole
  room, an on light still dims live, and an explicit level wins.

## The color check rides with the Hue writes, not the whole apply (v3.47.0)

Reported: *"some lights didn't change today"* — followed by a household
explanation that they "fix themselves if you wait long enough", and a re-apply
that was interrupted by the repair finally firing.

Since v3.44.0 the three transports have been APPLIED concurrently — a Hue command
is Zigbee, a whole-device Govee command is a LAN datagram, a segment change is a
rate-limited cloud call. But only the *fast* on/bri verify moved with them. The
**color-aware** pass was still scheduled after `gather(early, deferred)`, so it
waited out every segment call before looking at bulbs that had finished in under
a second.

Living Room, 2026-09-04:

```
21:10:17  Hue writes complete (9 lights, <1s)
21:10:19  ── cloud_v2 segment calls begin ──
21:10:43  ── segments complete (26s) ──
21:10:43  apply ends → schedule_hue_late_verify(delay=25)
21:11:08  color check finally runs
```

**51 seconds, fifty of them waiting on strips a Zigbee bulb owes nothing.** For a
schedule it was worse: 26 + 150 = ~176s.

The fix is one line in the right place — `do_hue()` now schedules the color check
itself, next to the `schedule_hue_verify` that was already there. The delay is
`HUE_COLOR_VERIFY_S` (8s) and it is timed from the Hue writes, so it is
**independent of how slow the Govee half of the room is**. `_apply_room_white`
and `_apply_room_color` got the same treatment; they have no slow phase, so their
25s was simply an arbitrary wait.

**Why 8s.** Comfortably past the ~0.6s window where the bridge still answers from
its own optimistic model (the reason the fast pass must never judge color), and
well inside the span over which a bridge read has been observed to reflect the
truth — the 2026-09-04 miss was already visible at 27s. Short enough that it
cannot plausibly fight a deliberate change: nobody applies a scene and then
switches one lamp off within eight seconds meaning it to stick.

**The old passes remain as backstops**, not as the primary mechanism: 25s after a
manual apply, 150s after a schedule. They also carry `_reconcile_expectations`,
which needs the `room_last_applied` record that only exists once the apply
finishes. If 8s ever proves too eager, the symptom is visible for free — the
delivery-health count will show color repairs that the backstop then finds were
never wrong.

### A newer command wins — the delayed checks never reverse one (v3.48.3)

The delayed color checks (8 s, 25 s and 150 s after an apply) re-send what that
apply ASKED FOR to any light that doesn't match. Nothing told them whether
something newer had been sent to the same light in between, so a second scene, a
color picked on a light card, a lightshow frame or a lightning flash inside the
window got **reversed** back to the older look. Found while planning the Fable
review and reproduced directly: scene A went to light 16, the light was set to B,
and A's 8-second check put A back. The 25 s and 150 s windows had this since
v3.42.3; v3.47.0's 8 s window made it more likely to bite.

**The fix is exact, not a heuristic: count intended writes per light.**
`discovery.set_hue_light_state` bumps `_hue_write_seq[light]` on every call, before
sending. Every Hue writer passes through that one function — main.py's paths, the
lightning engine in `scenes.py`, the lightshow — so none can be missed. Each check
remembers each light's count from when its expectation was made (`since`), and
`_hue_verify_repair` leaves any light whose count has moved on.
- **A repair's own re-send doesn't count** (`hue_repair_scope()`): it restates the old
  intention rather than expressing a new one. Without that, the 8 s check's repair
  would disarm the 25 s backstop for the same apply.
- **The count is taken when the expectation is MADE, not when the check is
  scheduled.** The scene apply's end-of-run passes are scheduled 10–30 s after its
  Hue writes, once the segment calls finish. A count taken then would already
  include a newer command made during the apply, and the backstop would reverse it.
  So `do_hue` snapshots `hue_since` right after its writes, and all four checks use
  it. `_apply_room_white` / `_apply_room_color` do the same.
  `schedule_hue_verify(..., since=)` and `schedule_hue_late_verify(..., since=)`
  default to "now", which is right only for a caller that has just written.

**Changes made outside LightEmUp can't be counted** — a voice command or the Hue app
talks to the bridge directly. For those there is one rule: **if every light the
check could judge (three or more) disagrees, someone changed the room on purpose**,
and the check leaves it. "Turn off the living room" changes them all, while a
dropped command is partial. The room's "Changed since" / "Set here" is the way back,
which is the stance `/api/rooms/status` already takes on other controllers' changes.

**The threshold is three because of this bridge's history.** On 2026-09-02 *both*
front-door bulbs — a two-light set of third-party AE 282 C bulbs — missed the same
sunset command, one dark and one at brightness 2. For two lights, "all wrong" is a
real miss here, and exactly what these checks exist to repair; `test_late_verify.py`
models that night and fails at a threshold of two. No set of three or more has ever
missed in full (the worst was 5 of 9).

**What it still can't tell apart, stated plainly:** an outside change to one light,
or to both lights of a two-light room, inside the window looks the same as a missed
command, so it is re-sent. And if every light in a 3+ set genuinely misses together,
the check leaves it and the room shows "Changed since". Both are narrower than the
bug this replaces, which reversed every newer command.

Covered by `test_stale_verify.py` (19 assertions). It drives the REAL
`set_hue_light_state`, faking only httpx, so the counter itself is under test.

### The evening hole in the delivery chart (v3.47.0)

`by_day` bucketed each event by the date in *its own* timezone while the axis was
built from LOCAL dates. Since `_now_iso()` writes UTC, every repair after 20:00
EDT — when UTC has already rolled over — got a key one day ahead of anything the
axis rendered, and **vanished from the chart** while still counting toward the
24h/7d totals. The number and the picture disagreed, in the evening, which is
when the lights are actually used. Events are now converted with `.astimezone()`
before bucketing, so both sides of the comparison are in the same frame.

### A light that fell back to WHITE (v3.46.1)

The color check in `_hue_verify_repair` used to require `color_mode == "xy"`,
which quietly excused the single most important failure there is: a bulb that
dropped out of color mode altogether.

**2026-09-04, Living Room.** A palette went to nine lights. The four Philips
LCT014 / AE 282 C bulbs took their colors back to four decimal places. The five
**AE 280 C** bulbs (16/17/18/19/22) all landed on `colormode: ct` at 370 mired —
2700K — and all reported the *identical* xy `[0.4576, 0.41]`. That identity is
the tell: a lost command leaves each bulb on its own previous color, so five
bulbs agreeing exactly is a **fallback**, not radio loss. The late verify read
all nine lights, hit the mode guard, and passed over exactly the five that were
wrong. `/api/rooms/status` had it right the whole time — *diverged, 5 changed /
4 matched* — because `_hue_state_matches` has always judged this case correctly
and even labels it "the common case".

Two functions in this file compare an expectation against bridge state. They
must not reach opposite conclusions:

| state | `_hue_state_matches` (detects) | `_hue_verify_repair` (fixes) |
|---|---|---|
| asked xy, mode `ct` | changed | **now repairs** (was: skipped) |
| asked xy, mode `xy`, far | changed | repairs |
| asked xy, mode `hs` | can't tell | leaves alone |

The fallback is recorded as its own kind, **`white`**, rather than as `color`.
The distinction is diagnostic: a wrong color suggests a lost command and points
at the radio, while a fallback to white points at the *bulb* — third-party
firmware that won't hold an xy. Keeping them apart is what lets the delivery
health card tell those two stories apart.

**This cannot loop.** Only `compare_color=True` reaches the check and only the
LATE pass sets it, so a stubborn bulb costs one extra re-send per apply.

### A 200 from the bridge is not a yes (v3.46.1)

`set_hue_light_state` returned `resp.status_code == 200`. But the Hue v1 API
answers 200 and reports per-**parameter** outcomes in the body, one entry per key
sent:

```json
[{"success": {"/lights/16/state/on": true}},
 {"error": {"type": 6, "address": "/lights/16/state/xy",
            "description": "parameter, xy, not available"}}]
```

So a bulb refusing the one parameter we care about looked like a clean success,
and the refusal was invisible to the verify, to "Now showing", and to the
delivery-health count. It now reads the body, prints what was rejected, and
returns False. An unparseable or unexpected body falls back to the status code
alone — never worse than the old behavior.

**Narrowed in v3.50.0:** a type-6 refusal ("parameter not available" — the light
lacks that ability) alongside at least one success now returns True, and commands
are trimmed to what each light can take before sending. See "The Fable review's
first five".

## The Fable review's first five (v3.50.0)

`docs/fable-review/REPORT.md` ranked five fixes first. Most share the shape the
review kept finding: **a protection added to one path and never to its siblings.**

### Lightning storms have a lifecycle
Only a storm's own Stop button and a config import used to call `stop_lightning`.
Room off, "All lights off", zones, scenes, Soft White, starting a lightshow, and
renaming or deleting the room all left it flashing. A double tap could start two
storms (the "already active" check sat before two awaits) and the first became
unreachable.
- **`SceneManager` serializes start/stop per room** (`_locks`), the fix the
  lightshow got in v3.40.2. The bodies are `_start_lightning_locked` /
  `_stop_lightning_locked`.
- **`stop_room_storm(room, reason, restore)`** sits beside every `stop_lightshow` on
  a whole-room path: `control_room`, `_apply_room_white`, `_apply_room_color`,
  `_start_scene_apply`, `scene_room_apply` (non-scoped), `start_lightshow`,
  `reapply_room`, `rename_room` and `delete_room`. Zones and "All lights" reach it
  through `control_room`. `reapply_room` now goes through `_start_scene_apply`; its
  own copy of the cancel-and-start skipped the lightshow as well. **A new
  whole-room path needs both calls.**
- **`restore`** decides whether the pre-storm snapshot goes back. False when the
  caller is about to set the room (off, a color, a scene, a white), since restoring
  first only flashes the old look on the way. True for a level, a resume, a rename,
  a delete, and the Stop button.
- It settles `LIGHTSHOW_SETTLE_S` after stopping (the storm's Govee datagrams have
  fire-and-forget duplicates) and publishes an **unsourced** `config` event, since
  the session that caused the stop still shows the storm running.
- **Rename stops the storm instead of re-keying it.** Its tasks, thunder
  subscribers and flash patterns are all bound to the old name.

**A storm notices an outside "off"** (`_watch_storm`, every `LIGHTNING_WATCH_S` =
3s, through the shared bridge read). A storm sends `on: true` with every dim and
flash, so a light that reads OFF was switched off by something else. The
complication is the storm's own re-lighting, and the answer is the lightshow's:
only **witnesses** count — lights the storm has not written since the previous look
and that were on at it (`_storm_external_off`).
- Every witness off ⇒ stop without restoring, then `control_room(on=False)` to put
  the off back on whatever the storm re-lit.
- Any witness on ⇒ not a room off. One lamp switched off in the Hue app doesn't
  end a storm.
- Unreachable lights, a failed read and an empty read all mean "can't tell".
- Known gaps: a Govee-only room can't be judged, and a flash landing in the same
  few seconds as the off hides that light until the next look.

### Power commands get the delayed checks
The 25s/150s verifies were schedule-only, and the 0.6s pass is structurally blind
to a dropped Zigbee frame (see v3.42.2). A bedtime "off" that lost one bulb left it
on all night. `control_room` now calls **`_arm_power_backstops`** for any `on`: 25s
for on and off, plus the 150s look for an off. `control_all` arms the unassigned
Hue lights the same way. `_apply_room_power`'s schedule-only block is gone, since
it would now double-arm.
- Both checks carry `since` from right after the writes, so a newer LightEmUp
  command wins.
- **Checks stay per ROOM**, so the whole-set rule still judges each room on its
  own: a room of three or more turned wholly back on by voice is left alone. A one-
  or two-light room turned back on from another app inside the window looks the
  same as a missed off and is re-sent. The scene checks accepted the same trade in
  v3.48.3.
- **`_hue_read_all(max_age)`** shares one bridge read. A caller arriving while a
  read is in flight waits for it, and `max_age` accepts a recent one. Ten rooms'
  checks waking in the same second cost one GET. `_hue_verify_repair` reads
  through it.

### A level on a light "shown as off" asks the bridge (v3.45.0 revisited)
v3.45.0 trusted the caller's `defer` because the client renders live state. That
held only while the client refreshed, and nothing refreshed it when Google or the
Hue app switched a light on. The level was then saved for a power-on that never
came, and the slider seemed dead.
- `control_hue_light` checks `_hue_live_on`, a shared read at most 2s old, so a
  drag costs one GET per two seconds. A light that is actually on and reachable
  gets the level at once, and the answer carries `was_on: true` so the page
  re-reads.
- `_defer_room_level` does the same per Hue member and returns `live: [ids]`.
- **Govee stays deferred on the caller's word**: its state is a blocking LAN read.
- An unreadable bridge keeps the old behavior.

### Only what a light can take; a partial type-6 refusal is success
v3.46.1 made one refused parameter fail the whole command. The Bedroom's two AE 264
dimmable bulbs (14/15) refuse `ct` every night. Their on and level landed, yet both
were dropped from the verify, from "Now showing" and from power recovery.
- **`discovery._hue_caps`** records `{ct, color}` per light on every
  `get_hue_lights` read (state keys plus `capabilities.control`). A type-6 refusal
  teaches it too (`_learn_refusal`).
- **`hue_supported_state(light_id, state)`** trims a command. No color ⇒ drop
  xy/hue/sat/effect. No ct ⇒ drop ct, or convert it to xy for a color bulb
  (`mired_to_xy`, the Planckian locus). An unknown light is left unchanged.
- `set_hue_light_state` trims on the wire and sends nothing when nothing is left.
  `control_hue_light` and `control_room` trim **before recording**, and again after
  sending, so the record and the verify's expectation hold what the light can
  actually show.
- **`set_hue_light_state` returns True when every error is type 6 and something
  landed.** Any other refusal (e.g. 201, a level sent to an off light), or nothing
  landing, is still a failure.

Covered by `test_v350.py` (76 assertions): the Bedroom case end to end, the table,
ct→xy, the double-tap race, every storm stop path and its `restore`, the witness
truth table, a voice off end to end, the per-room backstops, the shared read, and
the bridge-checked defer. `test_hue_body.py` was updated for the narrowed rule.

## The Fable review's item 6 — the smaller S2s (v3.51.1)

Four of the seven are here. The other three are frontend — the device picker's
hook, the shade fallback and the lightshow panel's saves — in
`static/js/CLAUDE.md`.

### A color pick no longer eats the level saved for the next power-on
`control_hue_light` consumes a pending level into `state["bri"]` when a light is
switched on, and the RGB block then overwrote it with the color's own luminance:
it asked `req.brightness is None` rather than "does this command already carry a
level?". So picking a color on an OFF light threw the saved level away — v3.45.0
silently not working, for one gesture. The guard is now `if "bri" not in state`.

### The Govee power verify won't reverse a newer command either
The Hue checks learned this in v3.48.3; the Govee one never did. It captures "this
device should be off", waits `GOVEE_VERIFY_SETTLE_S`, reads the device back and
re-sends — so a device turned back ON inside that window was turned off again.
- **`discovery.govee_write_seq(ip)`** counts **power** commands in `govee_lan_send`,
  the one call every LAN command goes through. Only `turn` counts: a color or a
  level is not a statement about power, and power is all this check judges.
- `schedule_govee_verify(..., since=)` snapshots the count per device (taken at
  registration, which is right for a caller that has just written), and
  `_govee_verify_repair` leaves any device whose count has moved, saying so in the
  outcome line (`N superseded`).
- Its own re-send runs inside **`govee_repair_scope()`**, so it can't disarm the
  re-read that follows it. Same rule as `hue_repair_scope`.

### One light's error no longer abandons a room
`control_room`'s Hue loop had no try/except, so an httpx failure propagated out of
the endpoint and **the Govee loop below it never ran at all**. Each light is now
isolated and reported as `{success: false, error}`, like the loops beside it. The
unassigned-Hue pass in "All lights" got the same treatment (it had one try around
the whole loop; graded S3).

### A cancelled apply stops its own writes
`do_hue` and `do_govee_whole` run as their own TASKS so they don't wait on the seed
phase (v3.44.0). Cancellation lands in `await do_seeds()` — before the gather that
would reach them — so they carried on writing the very devices the replacing apply
was starting on, for about two seconds. The `finally` now cancels and awaits them,
and closes the deferred coroutines (which otherwise log "never awaited").
`_start_scene_apply` and `scene_room_apply` then settle `LIGHTSHOW_SETTLE_S` before
starting the new apply: the cancelled run's last Govee datagram has a
fire-and-forget duplicate 0.12s behind it that cancelling cannot stop.

Covered by `test_v351.py` (19 assertions): the saved level surviving a color pick,
an explicit level still winning, luminance still applying otherwise, a room
surviving one light's error with its Govee device still driven, "All lights"
surviving one loose light, the Govee count (a genuine miss repaired, a newer
command left alone, the repair's own re-send not counting, and a level or color not
counting), and a cancelled apply writing nothing after the cancel.

## Delivery health — a rolling count of commands that didn't take (v3.46.0)

The failure this app fights hardest is **invisible by construction**. The Hue bridge
returns `200` when it *queues* a command; whether the Zigbee mesh delivered it is not
something the HTTP layer knows. `GET /lights` doesn't help either — the bridge answers
from its own optimistic state model rather than reading the bulb back. So a lost
command leaves the light wrong and **nothing in the app disagrees**.

The verify-and-repair passes have caught these since v3.13.0, but they only said so in
the log. Noticing a *trend* therefore meant sshing to the Pi and reading `journalctl`,
which nobody does until something is already annoying. This surfaces the same
information in Settings.

**`record_repair(key, label, kind)`** is called from the two places that already know a
command didn't land:

- `_hue_verify_repair` — kinds `on`, `brightness`, `color`. These used to append a bare
  `light_id` to `repaired`; the list now carries `(light_id, why)` so the reason
  survives to the log line and the record.
- `_govee_verify_repair` — kinds `unreachable` (the device never answered) and `power`
  (it answered, and provably hadn't applied the power command).

It is **best-effort on purpose** — the whole body is wrapped, because a diagnostic that
can break a light command is worse than no diagnostic. It uses `schedule_save()`, so a
burst of repairs during one bad apply costs a single debounced write.

### Why it's a rate, not an incident list

One dropped command is ordinary 2.4 GHz behavior and means nothing. A dozen a day means
something changed — a new access point, a moved router, a bulb that's drifted to the
edge of the mesh. Only the *rate* distinguishes those, so `GET /api/health/delivery`
reports counts (24h, 7d) and a **dense** 14-day series: a day with nothing wrong is an
explicit zero, because a gap in a sparse chart reads as "no data" when it means the
opposite.

The endpoint also reads the bridge's `zigbeechannel` and returns it beside the count.
That pairing is the point: the usual cause of a rising count is a WiFi network moving
onto the Zigbee channel, and neither number diagnoses anything alone. A bridge that
can't be read just omits the field — a diagnostic that fails is not an error worth
surfacing.

### The config key

`repair_log` is a list of `{at, key, label, kind}`, bounded **twice**: `REPAIR_LOG_MAX`
(400) entries and `REPAIR_LOG_DAYS` (14) of age, trimmed on every write. A mesh that is
genuinely struggling hits the count cap first, which is itself a signal.

It is declared in `DEFAULT_CONFIG` and listed in **`_SETTING_INTERNAL`** — it is
diagnostic history, not a setting, so the restore preview doesn't offer to put
last fortnight's radio problems back.

## Usage log — what each device actually uses (v3.49.0)
The interface is being reorganized around real use. Four people use it very
differently: the owner uses everything; Marie mostly sets the Living Room to a scene
and then adjusts the rope, globe and hexa by hand; Drew (Sundays) does the same plus
the exterior scenes, and wants lightshows but finds them hard to use; Nate visits
about monthly. Guessing at frequency is how the app became "a collection of
controls", so `usage_log.py` records it instead, and the redesign pass (Fable pass
10) reads the summary.

- **What is recorded:** `open` (a screen or panel was shown) and `act` (something
  was done), each with a surface (`room:scenes`, `tab:schedules`, `light`), an
  optional action (`apply`, `off`, `soft-white`), and optionally the room or device
  key. `sanitize` keeps exactly those fields plus a few small scalars in `detail`, and
  drops everything else — **no colors, no typed text, no names** beyond room names.
- **Where it lives:** `usage_log.jsonl` (append-only, rotated into `.1` at
  `MAX_BYTES`, so at most about 16 MB) and `usage_devices.json` (id to name, first and
  last seen, width, browser), both beside the module and gitignored. **Deliberately
  not `config.json`**: that is rewritten on every change and ships in every backup,
  and this is a stream of taps. The endpoints never touch `config` and never call
  `publish_event`, or every open browser would refetch everything on each batch.
- **A device is a browser.** The frontend keeps a random id in `localStorage`, and
  the owner names each one in Settings. Until then its browser label and screen width
  identify it (402 px is an iPhone 17 Pro, 440 px a 16 Pro Max, 390 px an iPhone 14).
  `usage_devices.json` is rewritten only when something changes or `last_seen` is
  `LAST_SEEN_WRITE_S` old, not on every batch.
- **Time is the server's.** Each event is back-dated by the age the browser measured
  (`sent_at - at`), clamped to an hour, so a phone with a wrong clock can't reorder
  anything.
- **`opened_then_used`** is the number the redesign needs most. For the surfaces in
  `OPEN_ACT` (Scenes, Controls, Lightshow, Lightning, Schedules) it counts visits
  that opened the screen and visits that then did something there. Opened and never
  used is the signature of a confusing screen, which a plain tap count cannot show.
  A visit ends after `SESSION_GAP_S` (30 min) of silence.
- File I/O runs in `asyncio.to_thread`, so a slow SD card can't stall the loop that is
  driving lights.
- Covered by `test_usage_log.py` (36 assertions): field sanitizing, id validation,
  device labels, the write throttle, server-side timestamps, the batch cap, rotation,
  visit splitting, opened-then-used, and that the endpoints leave config and SSE
  alone.

## Detecting that something ELSE changed a room (v3.16.0)
**LightEmUp is not the only thing driving these lights**, and can't be. The Hue app, the
Govee app and Google Home routines all touch them — and must: Govee's on-device engine is
the only way to run fast animations, which the rate-limited cloud API can't reach. So
"what we last set" ≠ "what the room is showing", and the v3.12.0 strip claimed the latter
while only knowing the former (a daily 1:30pm Home routine forcing 2700K left it lying).

**The governing rule: this check can PROVE divergence but can never PROVE agreement, so it
only ever downgrades a claim — it never certifies one.** Verdicts are `match` /
`diverged` / `unknown` / `none`, and **`unknown` must never be rendered as either of the
others**; a confident tick we can't stand behind is worse than no claim, because it earns
trust it can't keep.
- `record_room_applied(..., expect=…)` stores the per-light state **as sent** — the same
  dict `_hue_verify_repair` already builds, previously discarded. That's what makes a
  later comparison possible at all.
- `_hue_state_matches(sent, cur)` returns True/False/**None**. Color comparison was
  rejected for *repair* (a false positive re-sends forever) — but for *display* a false
  positive only mislabels a strip, so a **tolerant** comparison is worth it, and it has to
  be: mode alone (xy vs ct) can't tell your palette from someone else's color scene.
  `HUE_XY_TOLERANCE` 0.06 (gamut clamping shifts xy slightly; a different scene shifts it
  a lot), `HUE_CT_TOLERANCE` 25 mireds. Unreachable / `hs` mode / no xy reported ⇒ None.
- **Govee COLOR is deliberately not judged.** LAN devStatus reports color unreliably and
  a running Govee-app animation isn't a static state at all, so "verifying" it would
  manufacture exactly the false confidence this exists to avoid.
- **Govee POWER is judged, from evidence already gathered (v3.31.0).** `_room_status`
  reads `govee_failed` off the room record — what the power verify *proved* by reading the
  device — and never queries a device itself. That matters: devStatus is a blocking
  sequential read, so polling every room here would cost tens of seconds per page load.
  It reports `reason: "not_applied"` when the divergence is entirely Govee misses and no
  Hue light changed, because "our command never landed" and "something else set these
  lights" have different remedies and must not wear the same words. Before this, a
  Govee-only room was structurally **`unknown`, forever** — it had no `expect_hue`, so the
  one mechanism built to catch a stale record was blind to exactly the room that needed it.
- `GET /api/rooms/status` does **one** bridge read for all rooms. `POST /api/rooms/reapply`
  replays the stored look — which is why scenes also store their resolved `payload`, the
  same snapshot mechanism a scheduled scene uses (and it's re-freshened through
  `_freshen_scene_payload`, so DHCP drift doesn't break it).
- A **"resume" deliberately records no expectation**: `{on:true}` returns each light to
  whatever it remembers, so there is nothing to compare — better `unknown` than a
  fabricated match.

## Phantom Hue lights (v3.23.0)
A Hue light that's re-paired comes back with a **new id**, and the old one lingers in
every room, layout, nickname and record forever — unreachable, and permanently `unknown`
to the divergence check. `GET /api/hue/phantoms` lists them; `POST /api/hue/phantoms/remove`
(`{light_ids, dry_run}`) purges them via `_purge_hue_light`, which clears **rooms,
nicknames, device_modes, ct_correction/ct_rgb, layout devices+segments, fixture members,
`expect_hue`, AND the stored re-apply `payload.hue`** — miss that last one and "Set here"
keeps driving a light that doesn't exist. Writes a `config.json.pre-phantom-purge.bak`.

- **Absent from the bridge's list ≠ `reachable: false`.** A Hue light on a flipped wall
  switch is still LISTED, just unreachable, and must never be pruned. Only absence from
  the list counts — which works because for Hue the bridge is authoritative. This is the
  exact opposite of the Govee rule, where discovery is lossy and absence proves nothing
  (see "assume presence"). Don't unify them.
- **Both endpoints refuse when the bridge can't be read OR returns an empty list.** A
  bridge that's briefly down, or has just been factory reset, otherwise looks like "every
  light in the house is a phantom" — and acting on that wipes every room. The GET returns
  `ok: false`; the POST raises 503 and changes nothing.
- **Remove re-checks the bridge itself** rather than trusting the ids the client sent: the
  client's list can be seconds stale, which is long enough for a light to have come back.
  A live id in the request lands in `refused`, not in the purge.
- **Detection is automatic; deletion never is.** The UI (`PhantomHueCard`) surfaces them in
  Settings → Hue Bridge with one button. Silent auto-deletion was considered and rejected:
  the upside is saving one click, and the downside is quietly destroying rooms.

### "Gone N days" — the escalation that replaces auto-deletion (v3.24.0)
`GET /api/devices/stale` returns Hue **and** Govee devices missing for
`STALE_MISSING_DAYS` (5) or more, and drives a third header badge next to Hue/Govee.
- **This is a different claim from "not responding", and that's the whole point.** Online
  status flickers — a light on a wall switch is missing every evening and back every
  morning — so an amber badge for it is noise you learn to ignore. "Gone 5+ days" is rare,
  so it's allowed to be loud, and it links straight to Settings where removal lives.
- **Clocks, not live checks.** Hue uses `hue_missing_since` (set by `_track_hue_missing`,
  called ONLY from `/api/hue/phantoms`, which already refuses on a bad bridge read); Govee
  uses the existing `known_devices.govee[*].last_seen`. The stale endpoint itself touches
  **no network at all**, so a bridge or LAN that's down right now can't manufacture a
  stale device. If the app isn't opened for a week the Hue clock starts late —
  under-reporting, the safe direction for something whose only suggestion is "delete this".
- A light coming back **resets** the clock; `_purge_hue_light` clears it too.

## Expectations are pinned to what the BRIDGE settled on (v3.22.0)
`_reconcile_expectations(actual)` runs inside `_hue_verify_repair` (free — those lights
were just read) and rewrites a **just-written** `expect_hue` with the color the bridge
actually reports.

- **Why:** the bridge gamut-clamps. An outdoor bulb asked for xy `[0.184, 0.284]` settled
  at `[0.157, 0.379]` — dy `0.095`, well outside `HUE_XY_TOLERANCE` (0.06). Comparing
  later against what we *asked for* declared the room "Changed since" minutes after
  LightEmUp's own schedule set it: exactly the false alarm the feature exists not to
  raise. Loosening the tolerance enough to swallow a hard clamp (~0.12) would let a
  genuinely different color hide inside it, so the comparison target moves instead.
- **Bounded to `EXPECT_RECONCILE_WINDOW_S` (45s) after the record was written.**
  Reconciling an older record would rewrite the evidence that something *else* changed
  the room — erasing divergence rather than reporting it, which is worse than the bug it
  fixes. Same reason a light whose brightness didn't take is skipped: a repair is in
  flight and baking in the wrong state would hide the miss. A color-MODE mismatch
  (asked xy, reports ct) is never reconciled either — that's the Google Home case.
- **A scene re-verifies after recording.** `_run_scene_apply` fires its Hue verify inside
  `do_hue`, long before the record exists (a segmented room takes ~30s), so it has nothing
  to reconcile against. It now calls `schedule_hue_verify(hue_expect)` again after
  `record_room_applied` — one extra bridge read, which doubles as a late re-check.

## "Now showing" — what each room was last set to (v3.12.0)
`config["room_last_applied"][room]` = `{kind, label, swatches, kelvin, at, source,
source_detail}` (additive). It powers the strip in each room header, so opening a fresh
session on another device answers "what did I set this room to?" without opening the
Scenes panel.
- **This is NOT `room_color_state`, and the difference is the whole point.**
  `room_color_state` stores the Scenes panel's *recipe* so its controls rehydrate, and it
  is only written when someone presses Apply in that panel. It therefore says nothing
  about a schedule that fired overnight, a white shortcut, or the room being switched off
  — a second session reading it can be confidently wrong. `room_last_applied` stores the
  resolved **result** and is written by **every whole-room path**. Keep both; they answer
  different questions.
- `record_room_applied(...)` is the single writer and is **best-effort** — it swallows its
  own exceptions so a display record can never break a light command. Call sites:
  `_run_scene_apply` (**only on completion** — a canceled apply left the room half-set, so
  claiming it's showing that look would be a lie), `control_room`, the scheduler's
  `_apply_room_white`/`_apply_room_color`/`_apply_room_power`, and `start_lightning`.
- **`control_room` deliberately ignores a brightness-ONLY call.** That's the room slider,
  which fires repeatedly while dragging; recording it would churn the record and overwrite
  the scene's name with "brightness".
- **Swatches are derived server-side by `_scene_swatches`** from the already-resolved apply
  payload — the backend can't compute scene colors (that math is browser-only) but the
  payload it receives is fully resolved, so nothing extra has to be sent. Duplicates
  collapse, order is preserved (a palette reads as a sequence), capped at
  `ROOM_SWATCH_LIMIT`. White stores `kelvin` and **no** swatch: the frontend renders that
  chip via `kelvinToRGB`, so the backend needs no color math for a temperature.
- **The `label` comes from the browser** (`describeLook()` in color-mode.js) on
  `SceneApplyRequest.label`, because only the browser knows which mode produced the colors.
  `source`/`source_detail` mark a schedule fire so the header can credit it instead of
  implying a person did it.
- **The event is published UNSOURCED** (`publish_event(..., source=None)`) and temporarily
  lifts `_suppress_publish`. Clients ignore their own echoes, but the session that just
  applied a look is exactly the one that wants the new strip; and a scene apply sets
  `_suppress_publish` for its whole run, which would otherwise swallow the record saying it
  finished.
- It is room-name-keyed, so it's in **both** `rename_room` and `delete_room`.

## Backup / restore — export + import every setting (v3.11.0)
Everything the user has built (rooms, layouts, nicknames, calibration, fixtures, scenes,
schedules, zones) lives in ONE file on the Pi's microSD card, and those cards wear out.
**The rolling `config.json*.bak` files protect against a bad write, not against losing the
card** — so `GET /api/config/export` serves the config as a **browser download**
(`Content-Disposition: attachment`), getting the backup *off the machine*. That's the whole
point; don't "improve" this into writing a backup file on the Pi.
- **The export cannot have gaps, and that's structural** — `_export_envelope` deep-copies
  the *whole* live `config` dict, so a key added by any feature ships without anyone
  remembering. Don't "improve" this into a hand-listed allowlist; see the config-key
  checklist in the root `CLAUDE.md`.
- **The PREVIEW was the gap, and it's now derived (v3.30.0).** `_config_diff_rows(cur,
  inc)` builds one row per key from `set(DEFAULT_CONFIG) | set(cur) | set(inc)`, so a new
  setting shows up whether or not anyone registered it. `_SETTING_LABELS` /
  `_SETTING_RENDER`-style special cases in `_render_setting` only make the output nicer;
  `_SETTING_INTERNAL` hides derived state (`device_state`, `segment_state`,
  `hue_missing_since`, `room_last_applied`, `schema_version`). It replaced eleven
  hand-written `BackupDiffRow`s that had silently fallen behind: white calibration, the
  location sun schedules need, favorites, per-device segment counts and scene addressing
  were all being replaced with **nothing shown in the diff**. A key the build doesn't know
  is rendered with an asterisk rather than dropped — a backup from a newer build still
  previews honestly.
- **Cross-version restores warn, they never block (v3.30.0).** The dry run returns
  `server_version` next to the envelope's `app_version`; the browser compares them and, on
  a difference, gates the destructive button behind an explicit "OK, continue". The
  comparison is deliberately not made server-side: the most valuable restore there is — an
  old backup onto a rebuilt Pi running the current build — is *by definition* a version
  mismatch, so refusing it would break the feature's whole purpose. The only hard refusal
  stays `schema_version > SUPPORTED_SCHEMA`, which is about keys we'd actively mangle.
- **It's an envelope, not raw config.json**: `{lightemup_export, app_version,
  schema_version, exported_at, hostname, includes_credentials, config}`. The wrapper is what
  lets import recognize a real backup, **refuse one written by a newer build**
  (`schema_version > SUPPORTED_SCHEMA`) whose keys we'd silently mangle, and state up front
  whether credentials are inside. `_unwrap_import` still accepts a **bare config.json**
  (people pull that straight off the card), requiring a recognizable key so an unrelated
  JSON file can't be imported as settings.
- **Credentials are included by default** (`?include_credentials=false` strips
  `hue_username` + `govee_api_key`). `hue_username` is a bridge token: without it a restore
  can't talk to the bridge until someone **physically presses the button** on it. The
  exported file can therefore control the lights — the UI says so. Conversely, importing a
  credential-free backup keeps the **live** credentials (`keep_credentials`, default True)
  rather than silently unpairing the bridge.
- **`POST /api/config/import` is destructive by design** and replaces everything, including
  *removing* rooms the backup doesn't have. `dry_run: true` returns
  `{current, incoming}` summaries and touches nothing — the UI always previews first.
- Import order matters: validate → merge over `DEFAULT_CONFIG` (so a backup predating a key
  still yields a complete config, and unknown keys survive verbatim) → carry credentials →
  **write `config.json.pre-import-<stamp>.bak`** (aborts with 500 if that fails; the name
  matches the `config.json*.bak` glob so it automatically joins the pool `load_config()`
  restores from) → **quiesce** in-flight work (cancel `_scene_tasks`, stop any active
  lightning, `razer_keeper.cancel_all()`) so nothing keeps driving devices the import may
  have removed → **swap the config dict IN PLACE** (`clear()`+`update()`; rebinding the
  global would leave anything holding a reference reading stale settings) →
  `migrate_govee_to_mac` (an old backup may still be IP-keyed) → `save_config` →
  `reload_segment_state()` → `publish_event("config")`.
- **No restart is required** — bridge creds/IP are read per call, the scheduler re-reads
  `config["schedules"]` every tick, and the segment store is rebuilt by
  `reload_segment_state()` (factored out of `lifespan` precisely so startup and import can't
  drift apart). **If you add runtime state derived from config at startup, add it there.**
- Restoring onto a **different/re-imaged Pi** works because Govee identity is MAC-keyed
  (v3.0.0): the IPs in the backup are stale but re-resolve after a scan. The Hue bridge IP
  may genuinely differ and need re-discovery.

## White-temperature calibration (Govee renders CT bluer than Hue)
Two mechanisms; `ct_rgb` takes precedence over legacy `ct_correction`:
- `ct_correction` {in→out Kelvin}: remaps a requested Kelvin to a warmer Kelvin still
  sent as native CT. `correct_kelvin(ip, k)`.
- `ct_rgb` {in, out}: `out` is an *effective* warm Kelvin converted to RGB via
  `kelvin_to_rgb()` and sent as an RGB color — this bypasses Govee's blue CT floor
  (the white LEDs can't go that warm; the RGB LEDs can). `ct_rgb_color(ip, k)` returns
  the RGB tuple (mired-space interpolation of `out`), or `None` if uncalibrated.
- On a CT request, `control_govee` and the segment endpoints resolve `ct_rgb_color(...)`
  first; if present, send RGB; else fall back to corrected native CT. Calibration is
  saved via `POST /api/calibration/ct-rgb`; surfaced in `/api/config` as `ct_rgb`.

## Render-ready state (the frontend is "dumb")
The backend returns data the UI can paint directly — derivation/merging lives here,
not in the browser (v2.14.0):
- `GET /api/discover/govee` overlays the last color/temp/on/brightness set via
  LightEmUp (`device_state`) onto each scanned device, so devices come back
  render-ready (LAN devStatus doesn't report color reliably). **This is the slow leg**
  (a fixed ~6s `discover_govee_lan` UDP window + up to ~2s/device sequential state
  reads), so it must NOT gate the initial paint.
- `GET /api/discover/govee/cached` (v3.5.0) returns the same render-ready shape built
  purely from `known_devices` + `device_state` (`_govee_cached_devices`) with **no LAN
  scan** — instant. The frontend paints from this on first load, then fires the live
  `/api/discover/govee` in the background to refresh reachability + state. Devices are
  optimistically `responding: true` (assume-presence); the live scan corrects offline
  ones. `missing` is `[]` (only the live scan can know who's absent).
- `GET /api/hue/lights` attaches `state.color` (RGB from the reported xy via
  `_hue_xy_to_rgb`) so the frontend paints the current color from backend data.
- `GET /api/govee/segment-state` returns the UI shape directly:
  `{ ip: { colors: { idx: {r,g,b} }, brightness } }` (empties omitted).
- Favorite colors live in config (`GET /api/config` → `favorites`, default
  `DEFAULT_FAVORITES`; `POST /api/favorites` to save) instead of browser
  localStorage, so they sync across sessions/devices.
- **Favorite LIGHTS are a separate key (v3.33.0):** `favorite_lights` is an ORDERED
  list of device keys pinned to the strip at the top of Rooms and All Lights.
  `GET/POST /api/favorite-lights` replaces the whole list (the client owns the order —
  **never sort it here**, the array order is the render order) and de-dupes. It's
  device-keyed, not room-keyed, so `rename_room`/`delete_room` don't touch it — but
  `_purge_hue_light` does, or a removed phantom would leave a dead row in the most
  visible place in the app.
- `GET /api/config` also returns `device_modes`, `segment_fill_modes`, `ui_prefs`
  (the frontend reads them on load). `room_color_state` persists the **full** per-mode
  color-tool selection so a fresh UI session rehydrates *every* scene mode, not just
  palette — `RoomColorStateRequest` carries `custom_colors`, `custom_shade_mode`,
  `beacon_source_key`, `max_kelvin`, `ct_preset`, `selected_team/ncaa/flag`, etc. **When
  you add a color-tool setting, add it to all three: the frontend snapshot (`applyColors`),
  `RoomColorStateRequest`, and the hydration effect (`seededRoom`) in color-mode.js** —
  or that mode won't restore.

## Backend-driven room scene apply
- `POST /api/scenes/room-apply` accepts a fully-resolved scene (base seeds, hue,
  govee_whole, razer, cloud segment groups) and runs the **whole staggered apply
  in a background asyncio task** (`_run_scene_apply`), so the browser can close
  right after pressing Apply — the lights keep filling in server-side. This is the
  design goal: the frontend is just an interface that hits this one API.
- The task reuses the existing endpoint handlers (`control_govee`,
  `control_hue_light`, `control_govee_segments_multi`, `control_govee_segments_bulk`)
  so color resolution (ct_rgb), state recording, and persistence stay identical.
  Timing: base seeds in parallel → `SCENE_HOLD_S` → hue (parallel) + govee whole
  (`SCENE_GOVEE_STAGGER_S`) + razer (bulk) + cloud groups (`SCENE_SEG_STAGGER_S`,
  flattened across devices since the V2 rate limit is per-account).
- Progress + cancellation ride the SSE bus as `scene_apply` events
  (`phase`/`done`/`total`/`label`/`device`/`active`/`end_at`). **`device` names which
  device the step touched** (`govee:<slug>`, v3.35.1) so the per-light surfaces — the
  light card header, the Favorites row — can report a ROOM scene that happens to be
  painting one of their devices. Without it a segmented globe or rope looked idle
  through the 1.8s-per-color it was actually being painted, because a room apply is
  scoped to the room. Hue ticks deliberately carry no `device` (no per-card scene
  surface, and Hue applies instantly). `end_at` rides on every tick, not just the
  phase-open event, because a device-matching listener never sees that opener.
  **If you add a Govee step to the apply, give its `tick` a `device`.** During a run the task sets the
  `_suppress_publish` ContextVar so the per-call device events are NOT broadcast
  (no refetch storm); `scene_apply` events are exempt by type, and one `config`
  refresh is emitted at the end. One task per room (`_scene_tasks`); a new apply
  cancels the previous. `POST /api/scenes/room-apply/cancel` cancels by room.

### Three transports, one critical path (v3.44.0)
A room apply drives **three independent transports**, and they are not remotely
alike: a Hue command is Zigbee via the bridge (milliseconds), a whole-device Govee
command is a LAN datagram (milliseconds, fire-and-forget), and a segment change is
a rate-limited cloud call (~1.8s each, per-ACCOUNT limit). None of the three gates
either of the others.

Phase 2 already ran all of them under one `asyncio.gather`. **The base-seed phase
in front of them did not.** Seeds are whole-device Govee commands that exist only
so a segmented strip reads as the scene while its rate-limited segment calls
trickle in, followed by `SCENE_HOLD_S` (2s) to let that settle — and **every Hue
light in the room waited behind both**, for work none of them depend on. A palette
on the Living Room did nothing visible for ~2.6s and then moved all at once.

Now `do_hue()` and `do_govee_whole()` start at t=0 as tasks, `do_seeds()` runs as a
coroutine, and only razer + cloud wait for it. Measured in `test_parallel.py`:
first Hue write `t+0.000s`, first segment call `t+0.423s` (with the hold scaled to
0.4 for the test).

- **Verification moves earlier by exactly the same amount, for free.**
  `schedule_hue_verify` fires from inside `do_hue`, so the Hue read-back now lands
  ~2.6s sooner — before the first segment call, rather than after the whole
  13-second segment run. That was the point of the exercise.
- **The progress counter had to merge.** Seeds counted into their own `done` under
  a `"resetting"` phase; once the phases overlap, two counters make the bar jump
  between totals. There is one phase (`"applying"`) and one total that includes the
  seeds. `"resetting"` no longer appears — `color-mode.js` only ever displayed it.
- **`end_at_ms` is a max, not a sum.** The finish is the longest independent path
  (`base + hold + cloud_time`, `govee_time`, Hue), which is also a more honest
  countdown than the old sum.
- **The one collision guard:** a device should never be in `base_seeds` AND
  `govee_whole` — it is either painted per segment or as one color — but if a
  payload ever says both, `whole_collides` keeps that whole-device command behind
  the hold where it always was, so the two can't race. Covered by a test.

**The wider point, worth keeping:** when work fans out over transports with
order-of-magnitude different latencies, the slow one must not set the pace for the
fast ones. Check for a sequential preamble before assuming a `gather` means
parallel.

### `scope` — the same apply, narrowed to one device (v3.34.0)
The endpoint was never really room-scoped: the payload is fully resolved per device and
`room` is only a label plus a task key. `SceneApplyRequest.scope` makes that explicit so
the light card's scene panel can paint a single Govee strip. **`scope` is the channel;
`room` rides along for context.** Absent ⇒ `scope = room`, which is every pre-v3.34.0
caller and the scheduler, so their behavior is bit-identical.
- **It keys `_scene_tasks`.** One task per *room* would mean painting a hexa cancels its
  room's in-flight scene and vice versa — two applies fighting over devices that don't
  even overlap. Same-scope re-apply still supersedes, which is what you want.
- **It keys the SSE events**, so `ColorMode` and `RoomSection` (which now filter on
  `d.scope`, not `d.room`) don't put a whole room into "Applying…" for 13 seconds
  because one light is being painted.
- **A scoped apply records NOTHING** — no `record_room_applied`, no `expect_hue`, no
  re-verify. "Now showing" is a whole-room claim and one hexa going rainbow doesn't make
  the room rainbow; stamping it would replace an accurate record with a wrong one and
  leave "Set here" replaying a plan that only ever touched one light. This matches every
  other single-device path (picking a color on a light card doesn't touch the record
  either). Consequence to accept: the room's strip is now slightly stale — as it already
  was in that case.
- Covered by the scratch test `test_scene_scope.py` (17 assertions): the record-skip,
  the scope-vs-room event fields, and that a device apply leaves its room's task running.

## Device identify (flash to locate)
`POST /api/identify` flashes one device so the user can physically find it.
- Hue (`light_id`): sends the bridge's native `alert: "lselect"` (~15s breathe). It's
  temporary and the bridge restores the prior state, so we don't touch recorded state.
- Govee (`ip`): there's no native identify and color/brightness animate slowly, so we
  blink on/off (digital, crisp) 3× then restore the last-known state from
  `device_state`. Runs inline (~4s) using the existing `govee_lan_*` fire-and-forget
  helpers. The SKU→name table lives in `discovery.py` (`GOVEE_SKUS`); the frontend
  falls back to backend `device.name` when its small `GOVEE_SKU_NAMES` subset misses.

## Lightning settings: auto-persist + live-apply (v3.2.0)
The frontend has no "Save Settings" button — `updateSetting` debounce-POSTs
`/api/scenes/lightning/settings` ~600ms after the last change. If a storm is running,
that endpoint calls `scene_manager.update_settings(room, updates)`, which mutates the
shared `LightningSettings` object the running device loops read from (single-threaded
asyncio → `setattr` between awaits is safe, no lock). **What applies live depends on
where the loop reads the value:** the Govee whole-device loop reads `settings.*`
per-flash → color/CT/brightness update immediately; Hue reads `color_r/g/b` +
`use_color_temp` per-flash (live) but computes CT/brightness once at start; the flash
**cadence** (`min/max_gap_ms`, `flash_duration_*`, `burst_count_*`) is baked into
patterns generated at start, and segment colors are computed once — so those take
effect on the **next** storm start. Making cadence fully live means regenerating
patterns each cycle (deferred; needs a real-storm test). Endpoint returns `applied_live`.

## Power-recovery after an outage (v3.3.0)
A sudden power loss + restore reboots the Pi, the Hue bridge, and the Govee devices
together; the lights come back to their **hardware/bridge** default (often full-on),
which at 3am lights the whole house. On a **genuine fresh boot** the lifespan schedules
`_apply_power_recovery()` (a background task) to bring them back gracefully.
- **Fresh-boot gate (critical):** it only runs when `/proc/uptime ≤ FRESH_BOOT_MAX_UPTIME_S`
  (600s). A normal deploy / service restart happens long after boot, so it is skipped —
  otherwise deploying at night would kill lights that are intentionally on. On non-Linux
  dev boxes `/proc/uptime` is absent → recovery never fires there (safe for local work).
- **The lights aren't powered by the Pi (v3.4.5 — critical correction):** Hue/Govee run
  on their own wall power, so a Pi reboot (`sudo reboot`, `systemctl restart`, a deploy)
  leaves them untouched — they keep their real state across it, and there is **nothing to
  recover**. Actively driving them on a plain reboot is a bug: v3.4.4 did exactly that and
  turned ON lights that were off after a routine `sudo reboot`. The ONLY event that truly
  de-powers the lights is a house/circuit outage — which also kills the Pi *without* a
  clean shutdown.
- **Planned reboot vs outage (`SHUTDOWN_MARKER`):** a low uptime alone can't tell a
  `sudo reboot` from a power cut. The lifespan shutdown hook writes `.clean_shutdown`
  (SIGTERM runs it — a planned reboot / `systemctl restart` / deploy); startup consumes
  it (`exists()` → `unlink()`). **Present at boot ⇒ clean (planned reboot) ⇒ do NOTHING**
  (leave the lights exactly as they were — the truest "resume", and it never wakes the
  house). **Absent ⇒ the process was killed without a clean stop (a real outage) ⇒ apply
  the policy.** The marker is written *before* `flush_save_now()` so a force-kill after
  SIGTERM still leaves it. This also matches Dan's workflow (commit/push then reboot the Pi
  at night → lights left as-is, never forced off).
- **Settle + resolve:** the task waits `RECOVERY_SETTLE_S` (45s) for the bridge/Govee to
  rejoin the LAN, then runs `discover_govee()` to refresh DHCP-reassigned Govee IPs before
  addressing anything.
- **Policy** (`config["power_recovery"]`, additive — absent ⇒ defaults):
  `mode ∈ {resume_unless_night (default), resume_always, off}`; `night_start`/`night_end`
  are 24h `"HH:MM"`. `_in_night_window()` wraps past midnight (22:00→07:00 default;
  start==end ⇒ never night). On an outage boot only: `resume_unless_night` + inside the
  window ⇒ **force all off** (`_recovery_all_off`: every Hue light + every known Govee
  device → off); otherwise **resume** (`_recovery_resume`: replay `device_state`).
  `_recovery_resume` defaults a Govee entry with no recorded on-state to **off** (not on),
  so an outage never blasts on a device whose state we never captured.
- **`device_state` now holds Hue too.** `record_hue_state(light_id, state)` mirrors the
  last Hue command under `hue:<id>` (on/bri/xy/ct/hue/sat; xy/ct mutually exclusive),
  called from `control_hue_light` + room control, purely so resume can replay it — the
  browser still renders Hue from live bridge state. Govee resume replays exactly what was
  sent (calibrated CT was already stored as r/g/b, so no re-calibration needed).
- Settings persist via `POST /api/power-recovery` (auto-saved from the frontend, no Save
  button); editing never drives lights — it only applies on the *next* boot. **This is
  device-state resume, not scene resume** — resuming an active lightning storm is separate
  (task #46).
- **It can never be seamless, and the UI now says so (v3.29.0).** Watching a real outage
  made the ceiling obvious: the lights come back on their OWN hardware default the instant
  power returns, and the hub can't intervene until it has booted and reconnected — so the
  true sequence is *lights snap on by themselves → Pi boots → recovery applies*. Nothing
  server-side can close that gap; the only real fix is in the vendors' own apps (set each
  light's power-on behavior to come back **off**, so LightEmUp drives the whole resume).
  `PowerRecoveryCard` carries that as an amber caveat block. **Don't quietly drop it** —
  without it the feature reads as "the hub restores my lights" and the gap gets rediscovered
  as a bug.
- **Recovery is followed by span catch-up** (see "Span catch-up" under Time-based
  schedules), which deliberately gets the last word over the overnight force-off.

## Time-based schedules (v3.8.0)
`config["schedules"]` (a list) + `config["location"]` ({lat,lng}) — both additive, read
via `.get`, no `schema_version` bump. A schedule pairs a **trigger** (`weekly` /
`oneoff` / `sun`) with an **action** (`scene` / `palette` / `white` / `color` / `power`)
for one room (or, for everything except `scene`, a zone).
- **`_scheduler_loop()`** is one background task started in the lifespan. It sleeps to
  just past the top of each minute via `asyncio.wait_for(_scheduler_stop.wait(), …)`
  (the cooperative-sleep idiom from `scenes.py`), so shutdown is instant. Each tick it
  fires every due schedule, stamps `last_fired`, disables fired one-offs, then
  `schedule_save()` + `publish_event("config")` once.
- **The FIRST tick waits on `_recovery_done` (v3.29.1).** It used to run immediately at
  startup — ~45s *before* `RECOVERY_SETTLE_S`, the delay that exists precisely because the
  bridge and the Govee devices aren't back on the LAN yet. So on an outage boot an overdue
  end fired into the void, cleared its `end_due`, and power recovery then replayed the
  pre-outage look a minute later with no idea the span had ended. **Worked example:** room
  green 09:00–10:00, power out 09:30, back 10:15. The 10:00 off fired at 10:16 against a
  still-rebooting bridge; `set_hue_light_state` returned false so the success-gated
  `record_hue_state` never recorded it, recovery restored **green**, and with `end_due`
  consumed nothing would ever turn it off again. Ordering it after recovery fixes both
  halves — the off reaches live devices, and it lands after the resume so it *corrects*
  the restored look. On a normal restart/deploy the event is already set, so it's free.
  A start falling due inside the settle window is simply skipped (the no-catch-up rule);
  firing it at a dead bridge would only look like it ran. **Anything you add that drives
  lights at startup belongs behind this same event.**
- **No catch-up for a MOMENT; catch-up for a SPAN (v3.29.0).** A plain schedule missed
  while the Pi was off does NOT retro-fire — waking to a 7am scene at 9am is worse than
  skipping it. But a schedule with an `end` describes an interval, not an instant, and one
  that should be running right now is re-entered at startup — see "Span catch-up" below.
  Dedupe is `last_fired == now.strftime("%Y-%m-%d %H:%M")`, so a schedule fires at most
  once per minute-occurrence.
- **`_schedule_due(sched, now, location, sun_resolver)` is PURE** — no lights, no I/O, and
  `sun_resolver` is injectable. Keep it that way; it's the piece worth unit-testing (see
  the 21-case scratch test written for v3.8.0). `now` is **naive Pi-local**
  `datetime.now()`, so DST is handled by construction: 7 AM is always 7 AM.
- **Sun triggers** use `astral` (pure-Python, in requirements.txt), imported **lazily**
  inside `_sun_hhmm` so the module still loads on a dev box without it. Without
  `config["location"]` sun schedules are simply inert (the UI warns).
- **Scene actions are stored SNAPSHOTS, not recipes.** All scene math lives in the
  browser (`color-mode.js`) — see "No server-side scene preview" — so a scene schedule
  stores the fully-resolved room-apply payload captured by the frontend's
  `buildScenePlan()`. `_fire_schedule` rebuilds a `SceneApplyRequest` from it and runs
  the normal `_run_scene_apply` background task (cancelling any in-flight apply for that
  room), so timing/progress/SSE are identical to a manual Apply.
- **`_freshen_scene_payload` re-resolves Govee IPs from mac at fire time.** The snapshot
  addresses devices by DHCP IP, and a schedule can sit for weeks — a router reboot would
  silently break it (exactly what MAC-keying fixed in v3.0.0). So every stored Govee
  entry carries `mac`/`device_mac`, and firing maps it through `gv_ip_for_slug(gv_slug(
  mac))`; entries that no longer resolve are dropped + logged. **If you add a Govee list
  to the apply payload, add it to the tuple in `_freshen_scene_payload` too.** Hue keys
  by stable `light_id` and needs nothing.
- `white`/`color` actions go through `_apply_room_white` / `_apply_room_color`, which
  reuse `control_hue_light`/`control_govee` and mirror the frontend's per-vendor split
  (Hue mireds + bri 1–254, Govee kelvin + bri 0–100).
- Endpoints: `GET/POST /api/schedules` (POST upserts by id; **a body with only `id` +
  `enabled` patches just that field**, which is how the list's toggle works — changing
  `trigger` resets `last_fired` so a retimed schedule isn't blocked by the old dedupe),
  `DELETE /api/schedules/{id}`, `GET/POST /api/location`.

## Scene addressing: segments vs whole, per device (v3.18.0)
**`config["govee_scene_address"]`** (`{ goveeSlug: "segments" | "whole" }`, additive) is
**the** answer to "does a room scene paint this device per segment or as one color?",
and both sides read it: the browser's scene apply and the scheduler's palette action.
Absent = `"segments"` for any device with >1 segment (the pre-v3.18.0 default).

- **Resolve it through `gv_scene_address(slug, sku)`, never by reading the dict.** It also
  forces `"whole"` for a device with ≤1 segment, so callers can't ask for a per-segment
  spread that has nowhere to go. Segment count comes from `gv_segment_count`, which
  mirrors the browser's `segCountFor` (configured count beats the SKU maximum — a 7-panel
  Hexa, not the SKU's 15). **If you change one, change the other**, or a scheduled scene
  addresses a different number of segments than the same look applied by hand.
- **Why it exists.** The choice used to be one toggle per ROOM
  (`room_color_state[room].address_segments`) that only the browser could read, so a rope
  light you wanted as one color forced the hexa panels to match. Worse, the scheduler had
  no access to it and read `govee_segment_mode` instead — which **only the lightning panel
  writes** — so the same device could be painted per-segment by hand and as one color on a
  schedule. `migrate_scene_address` converts the old room-level setting once at startup
  (only rooms set to `"unit"` need a record); it's guarded by the KEY'S PRESENCE, not its
  contents, so a legitimately empty result can't re-migrate forever.
- **Deliberately NOT unified with `device_modes`** (the LightCard's "show me one picker or
  per-segment pickers" preference) or with `govee_segment_mode` (lightning). Those answer
  different questions and stay separate. Note v3.18.0 also **removed** the old side effect
  where applying a scene bulk-wrote the room-level toggle into `device_modes` — two
  unrelated preferences moving as one.
- **There is no per-schedule segments flag.** Whether a device is segmented is a property
  of the device; a second switch on the schedule could only disagree with the room.
- Endpoint: `POST /api/govee/scene-address` `{ modes: { slug: mode } }` — bulk-shaped
  because the Scenes panel's per-device buttons and its "set all" are the same call.

## Random palettes in the scheduler (v3.17.0)
"Ten minutes before sunset, put the living room on **a** Summer palette." The action
stores a **source, not a snapshot** — the look is resolved when it fires, which is the
whole point: the same schedule has to look different tonight than it did last night.

**Two color actions, one engine (v3.28.0).** `type: "palette"` draws a random pick from a
curated set of LIBRARY palettes; `type: "colors"` carries its colors inline
(`{type:"colors", colors:[[r,g,b],…], brightness}`) for a look with no palette behind it —
alternating red/green at Christmas being the case that prompted it. The colors action is
wrapped as a one-off palette and handed to the SAME `_build_palette_scene`, which is what
makes two colors come out A-B-A-B down a hexa strip (`_ColorDealer` never repeats
consecutively) without its own arrangement logic. `/api/palettes/apply` takes `colors` too,
so "Try it now" exercises the identical path.

**Action shape** (`type: "palette"`), targets a room OR a zone:
```jsonc
{ "type": "palette", "room": "Living Room",   // or "zone": "Inside"
  "source": "category",   // "category" | "list"
  "category": "Summer",   // source=category; "All" and "Featured" also work
  "palettes": ["Tropical", "Noir"],           // source=list, in this order
  "brightness": 80, "segments": true }
```

- **The library is shared, not duplicated.** `backend/palette_library.json` is the single
  source of truth; `backend/static/js/palette-library.js` is **generated** from it by
  `tools/build-palette-library.py`. The 160 palettes lived inline in `color-mode.js` until
  now, which was fine while they were a browser-only idea — the scheduler fires on the Pi
  with no browser attached. **Add a palette to the JSON, re-run the generator, commit
  both.** The generator refuses to write a file that fails its structural checks.
- **The set is a LIST of names, not a category reference (v3.28.0).** `source:"category"`
  is legacy: still honoured by `resolve_candidates` so old schedules keep firing, but the
  editor expands one into its explicit palettes the moment you open it
  (`expandLegacyPalettes`), because a category reference can't be pruned and pruning is the
  whole point. Categories became bulk add/remove INTO the list, which is what makes
  "Summer and Winter" and "Summer minus three" the same gesture.
- **`palettes.py` is pure data + selection** — it knows nothing about rooms or devices.
  `resolve_candidates(action)` mirrors the frontend's `paletteCandidates()`; keep the two
  in step or the editor will preview a set the Pi won't draw from. Unknown names are
  **dropped and logged**, never fatal: a renamed palette must not stop a schedule firing.
- **`pick()` avoids an immediate repeat.** `_last_palette_pick` is keyed by schedule id and
  lives **in memory only** — persisting it would mean an SD-card write every time any
  schedule fires, to defend against a repeat that only matters across a restart. With one
  candidate, repeating is the correct answer.
- **A zone picks ONCE and fans out**, so "random Summer palette" reads as one decision
  across the house rather than six unrelated ones. That's why `_apply_room_palette` takes
  an already-chosen palette instead of choosing per room, and why palette is handled
  directly in `_fire_schedule` rather than via `_apply_action_to_room`.
- **Segments vs whole comes from `gv_scene_address`** — the same per-device setting the
  Scenes panel writes (see the section above), so a scheduled palette paints the room the
  way pressing Apply does. It read `govee_segment_mode` in v3.17.0, which was wrong.
- **`_build_palette_scene` is the only place the backend does scene math**, and it's
  deliberately simpler than the browser's adjacency solver: deal a shuffled pool
  round-robin (`_ColorDealer`, which never repeats consecutively even across cycle
  boundaries) over devices sorted by layout position (`_palette_device_order`). That buys
  the two properties that matter — no two neighbours share a color, and the arrangement
  re-rolls every fire. It emits a normal `SceneApplyRequest`, so **all the existing
  timing, staggering, cloud_v2 color batching, progress SSE and "Now showing" recording
  come for free** (incl. `expect_hue`, so divergence detection works on palette fires).
- **On a LINE, colors are dealt in physical order (v3.48.2).** `_ColorDealer` never
  repeats consecutively — but only in the order it is DEALT. Devices were sorted by their
  layout node and a strip's colors dealt in one block at that spot, while on the real
  Exterior Front line one strip's node sits at x=33 and the two segments it owns are laid
  out at x=2 and x=3. Replaying this function against the Pi's real config, a two-color
  palette produced **80 adjacent repeats over 40 seeds, every one at x=1/2 and x=3/4**;
  three colors, 22. The nightly "Exterior On" palette paints exactly this room. Now the
  function resolves every device first (`plan`), builds the units colors are dealt to (a
  Hue light, a whole Govee device, or one segment), and on a line sorts them with
  `_lightshow_order` / `_lightshow_positions` — the lightshow's own-position sort, reused
  rather than written a third time — before dealing. After: 0 repeats on every seed. **A
  floor plan still deals in device order, byte-identically** (the replay compared the
  payloads): a strip stays one run there, the same call the Scenes panel makes. The
  browser had the same bug by a different route; see `lineOrder` in `static/js/CLAUDE.md`.
- **Why not snapshot ten payloads in the browser and pick one?** A category is ten
  devices-worth of resolved JSON, which would bloat `config.json` (rewritten on every
  mutation, on an SD card) by an order of magnitude, go stale the moment a light is added
  to the room, and freeze each palette into one arrangement forever.
- Endpoints: `GET /api/palettes` (the library **as the Pi sees it** — the browser has it
  statically, so this exists to catch the two copies drifting) and
  `POST /api/palettes/apply` (the editor's "Try one now": same candidate resolution, same
  apply path, immediately).

## Paired on/off schedules — the optional `end` (v3.27.0)
One entry that turns lights on and later off: "sunset−10 until sunrise+10", or "10am for
90 minutes". Optional `end` on a schedule, one of:
`{type:"after", after_minutes}` · `{type:"weekly", time:"HH:MM"}` ·
`{type:"sun", event, offset_min}`.

- **The end is ARMED BY THE START, not scheduled independently.** When the start fires,
  `_resolve_end_due` turns the end into an absolute `"YYYY-MM-DD HH:MM"` stored in
  `end_due`; each tick fires whatever is now due. This is the load-bearing decision:
  - **Overnight needs no special case.** An independent end would have to answer "does
    Monday mean it STARTS Monday, or must be off during Monday?" for every sunset→sunrise
    pair. Armed, the question can't arise — days apply to the START.
  - **It survives a restart**, because `end_due` is persisted. A Pi rebooting at 2am still
    turns the porch off at sunrise, which is the durability case that matters.
  - **A start that never fired arms nothing**, so no stray "off" for a span that never began.
- **A due end fires LATE** if the Pi was down through the moment — deliberately unlike a
  missed start, which is skipped (waking to a 7am scene at 9am is worse than nothing).
  Turning lights off late is harmless and still wanted. **If the end action ever becomes
  configurable beyond "off", revisit this** — catching up on a color change hours later is
  exactly what the no-catch-up rule exists to prevent.
- **Saving clears `end_due`** when the trigger, action or end changes, or when the schedule
  is disabled — a disabled schedule turning lights off an hour later is unexplainable. A
  plain rename deliberately does NOT disturb a running span.
- `end` is three-state in the API (absent = leave alone, object = set, **explicit null =
  remove**), which a plain Optional can't express — `upsert_schedule` reads
  `req.model_fields_set`. The frontend always sends it.
- `_resolve_end_due` takes an injectable `sun_resolver` for the same reason `_schedule_due`
  does: astral is lazily imported and absent on dev boxes, so a test would silently get None.

### Span catch-up — the outage that ate a whole night (v3.29.0)
The armed-end model has one hole, and it cost a full night of exterior lighting: **an
outage across the START loses BOTH halves.** A 19:30–21:45 outage on 2026-08-07 swallowed
the 20:09 sunset fire, so `end_due` was never armed, so the 06:06 sunrise OFF had nothing
to fire either — the porch was left to whatever a human did, all day. The config told the
whole story: `last_fired` still read `2026-08-06 20:11` with `end_due: null`.

`_catch_up_spans()` is a **one-shot task launched from the lifespan** that re-enters any
span which should be running right now, and arms its end.
- **The governing distinction: a span is not a moment.** "No catch-up" is right for a
  point action, and it stays. But "on at sunset, off at sunrise" describes an interval
  that is either currently true or not, and the Pi being down through its first minute
  doesn't make it untrue. **Only schedules with an `end` are eligible** — a moment has no
  "should be running" state to be wrong about.
- **`_active_span(sched, now, location, sun_resolver)` is PURE**, like `_schedule_due`, and
  finds the most recent start occurrence (looking back `SPAN_CATCHUP_LOOKBACK_DAYS`, which
  overnight spans need — at 2am the start is on the previous calendar day) whose
  `_resolve_end_due` is still in the future. Its helper `_start_hhmm_on` is `_schedule_due`
  asked the other way round ("when today?" vs "is it now?"); **the two must agree on day
  filtering** — weekly needs an explicit `days` list, an empty `days` on a *sun* trigger
  means every day. A scratch test brute-forces every minute of two weeks against
  `_schedule_due` to hold that.
- **Two guards, and they're what make it safe to run on EVERY process start** rather than
  only after an outage: `end_due` already set ⇒ skip (a span that fired normally and merely
  outlived a deploy restart is already armed); `last_fired` already at that occurrence ⇒
  **arm the end without re-firing** (the start did happen, only the end was lost — and
  re-applying would re-roll a random palette for nothing).
- **It runs AFTER power recovery**, waiting on the `_recovery_done` event (`_recover_then_
  release` sets it in a `finally`, so recovery's early returns still release; the timeout
  guard is `RECOVERY_WAIT_MAX_S`). Ordering is the point: an outage boot goes recovery →
  catch-up, so a generic "force off overnight" policy can't beat "the porch is on until
  sunrise". A schedule covering this exact hour is the more specific instruction and gets
  the last word. **The scheduler loop's first tick waits on the same event** (v3.29.1, see
  above) — catch-up and the loop can then run in either order without conflict: whichever
  goes first leaves the other a no-op, because an armed `end_due` in the future isn't due
  and a span whose end just fired is no longer active.
- `last_fired` is stamped with the **occurrence**, not the boot time — that's the truth,
  and it keeps the normal tick's dedupe correct.

## Room lightshows (v3.39.0)
"Neat — the last time I looked at the house, these lights were different colors."
`config["lightshows"][room]` drives a background task that re-arranges the room's colors
every N seconds. **It is not synced to anything and can't be**: a cloud_v2 segment call
costs ~1.8s and the V2 rate limit is per-account, so segment addressing sets the tempo and
the interesting cadence is 20–60 SECONDS. Every pattern is therefore designed to look
deliberate at a standstill rather than to animate.

- **`lightshow.py` is pure math**, like `palettes.py`: `plan_frame(pattern, n, colors,
  step, opts, prev)` → `(r,g,b,level)` per cell. It knows nothing about rooms or devices.
  `PATTERNS` (key/name/blurb/opts) is **served** by `GET /api/lightshow` rather than
  duplicated in JS, so the blurb you read in the panel is the one the math implements.
  **`ColorDealer` moved here from main.py** — the palette scheduler and Shuffle/Palette-hop
  need the same "no two neighbors match" shuffle, and two copies of that rule is exactly
  the drift this codebase keeps paying for elsewhere.
- **A CELL is one Hue light, one whole Govee device, or ONE SEGMENT of one**, and it
  carries its `pos` from the room layout. The patterns need POSITIONS, not just indices.

### Geometry: a line and a floor plan are different spaces (v3.40.0)
`_lightshow_geometry(room)` reads `room_layouts[room].mode` and returns
**`"line"` | `"plan"` | `"none"`** (no layout at all). It decides three things:

- **Which patterns the room is offered.** `lightshow.patterns_for(geometry)`: six are
  geometry-neutral (Walk, Alternate, Shuffle, Swap, Palette hop, Accent); a **line** also
  gets **Wipe** and **Comet**, which both need an end to start from and a direction to
  travel; a **floor plan** also gets **Ripple** and **Sweep**, which need a center to
  radiate from and an axis to cross. `"none"` gets exactly the six that never read a
  position — offering a Ripple with no coordinates to ripple through would be a lie.
  `GET /api/lightshow` serves the catalog *and* each room's allowed keys, and **POST
  refuses a pattern the room's layout can't run**, so the editor and the API agree.
- **Whether the striping patterns count cells or read coordinates.** On a line, index IS
  position (the same call `color-mode.js` made for linear palettes: on a strip people
  expect color 1 on the leftmost light, not a color derived from raw coordinates with the
  physical gaps baked in). On a floor plan, Walk reads the real coordinate — so it marches
  actual stripes instead of rotating an arbitrary reading order — and Alternate becomes a
  checkerboard on `(x+y)` parity instead of index parity.
- **The `axis` option**, which only exists on a floor plan (a line has one axis). It is
  stored ABSENT by default, deliberately: each pattern's natural axis differs, and a
  stored `"x"` would mean Alternate could never resolve to the checkerboard that is its
  whole point. `lightshow.default_axis(pattern)` is the resolver, and the panel mirrors it
  so the chip it highlights is the one in effect.

Switching a room from Line to Floor Plan can leave a show holding a pattern that no longer
suits it. `_lightshow_pattern` **falls back** (to Walk, which is in every set) rather than
refusing to start — a show that silently stopped working after an unrelated layout edit is
the worse failure. `_lightshow_status` reports both `pattern` and `effective_pattern`.

**`_lightshow_order` sorts each cell by ITS OWN position, not its device's** — and that is
not a nicety. On the real Exterior Front line, a rope's device node sits at x=33 while the
segments it owns are laid out at x=2 and x=3; ordering by device would put that strip at
the wrong end of the run and make Walk crawl through it in the wrong place. Same rule
`color-mode.js` settled on for its preview swatches. A segment never dragged onto the map
has no position of its own, so it collapses to its parent's spot with ties broken on
segment index, which keeps an un-laid-out strip contiguous and in order. This is why the
lightshow does **not** use `_palette_device_order` (which sorts devices). The palette
scheduler keeps `_palette_device_order` for floor plans but, since v3.48.2, deals a LINE
in this same `_lightshow_order` — it had the identical wrong-end-of-the-run bug.

**Segment positions are stored per DEVICE**, as
`segments[deviceKey] = {expanded, positions: {"<idx>": {x, y}}}` — not under a per-segment
key. `_lightshow_positions` flattens that; get it wrong and every segment silently falls
back to its parent's spot.
- **`segments` is a room-level NARROWING, not a second opinion.** True ⇒ each device is
  addressed the way `gv_scene_address` already addresses it; False ⇒ every device in the
  room is one color. A per-device switch here could only disagree with the Scenes panel's,
  which is the same reason there is no per-schedule segments flag.
- **`exclude`** holds device keys left out entirely (a device takes its segments with it).

### Color roles — which palette color is the background (v3.42.0)
Accent, Comet and Sweep hold the room at `colors[0]` and move a second color across it, so
a six-color palette shows as **two colors at any one moment** and the rest are only reached
over a long run. Reported plainly: *"when choosing a palette, that's effectively a
two-color setup despite palettes being 3+ colors"* — and which two you got was luck.

`color_order` is a list of indices into the resolved palette. Index 0 is the background;
leaving indices out narrows the pool, which is how you get a deliberate two-color Accent
out of a six-color palette. `lightshow.apply_color_order` is pure and **forgiving by
design**: an index that no longer resolves, or an order that would leave fewer than two
colors, falls back to the palette rather than stopping a show.
- **`_lightshow_palette` is the raw palette; `_lightshow_pool` is the ordered one.** The
  status exposes both (`palette_colors` / `pool`) because the editor must show swatches at
  their ORIGINAL index while the show paints from the reordered pool.
- **Palette hop is exempt** — it draws a different palette every step, so an order stored
  against one of them means nothing.
- **Changing the palette clears the order** (`upsert_lightshow`), since the indices point
  into a specific palette. Remapping would be guesswork; clearing fails obviously.
- `lightshow.has_roles(pattern)` drives whether the editor appears at all, from the
  catalog's `roles` field — so the patterns that use a whole palette (Walk, Shuffle,
  Ripple…) don't get a control that would mean nothing to them.
- **Three things make it affordable, and all three matter:**
  1. **Frames DIFF, and write one extra step's worth (v3.41.0).**
     `_lightshow_write_set` writes the cells that changed, PLUS the cells that changed on
     the previous step — re-asserted exactly once. That corrects a command that never
     landed one step later, without repainting the room. `_lightshow_should_full` is now
     only a genuine resync: first paint, the cell list changed, or
     `LIGHTSHOW_RESYNC_S` (900s) elapsed — **wall clock, not frames**, since staleness is
     experienced in minutes.

### The unit that was missing: WRITES, not seconds (v3.41.0)
**Read this before changing anything about how often a show paints.** v3.40.1 decided to
repaint every cell every step whenever that was "cheap", and measured cheapness in
SECONDS — the Govee cloud rate limit was the only cost in the model. A repaint is cheap in
time and expensive in *writes*, and nothing measured writes.

What it cost, from the Pi's own logs:

| | Aug 26 | Aug 27 | Aug 28 | **Aug 29** | **Aug 30** | **Aug 31** | Sep 1 |
|---|---|---|---|---|---|---|---|
| Hue writes/day | 40 | 42 | 15 | **3,225** | **3,029** | **1,328** | 20 |

An Exterior Front show (Alternate, ~40s steps, 10.5 hours overnight) wrote its two outdoor
bulbs **924 times each** over two nights, against a house-wide baseline of 15-42 Hue writes
*per day*. Every one of those is a Zigbee transmission on a mesh **shared by every light in
the house** and an NVRAM write on the bulb. Reported symptoms, all consistent with a
congested mesh: room scenes applying to only some lights, and a scheduled off leaving
lights on — in rooms that had nothing to do with the show.

Three defenses, and the third is the one that generalizes:
1. **`_lightshow_write_set`** — the diff is back, with a one-step re-assert instead of a
   full repaint. Accent went from 12 writes a step to ~3.4, and still self-heals in one
   step. Measured by `test_writes.py`, which counts writes rather than trusting a rule.
2. **`LIGHTSHOW_HUE_MIN_INTERVAL_S` (60s)** — a room containing Hue bulbs floors there
   regardless of what the time-based cost model says. Zigbee is the scarce resource.
3. **The panel states the number.** `writes_per_light_per_day` is on screen, with a caution
   above ~900. A cost nobody can see is a cost nobody can weigh — this one was discovered
   by a mesh misbehaving three days later, which is the worst possible feedback loop.

**The rule to carry forward: a background loop's cost is not one number.** Wall-clock time,
cloud rate limits, radio traffic and device wear are different budgets, and an optimization
that trades one for another has to say so out loud.

### Why the diff had to become conditional — the two-accents bug (v3.40.1)
Reported: *"triple lamp bottom and hex lights were both showing the accent color at the
same time."* The pattern math was innocent (600 simulated steps, always exactly one accent
cell). The **diff** was the bug, and the reasoning behind it was wrong in a way worth
keeping written down:

- Accent moves the accent by repainting exactly **two** cells — the light gaining it and
  the light losing it. Lose the "back to base" command and two lights wear the accent.
- `frame_map` recorded what we **meant to send**. A Govee LAN send is unacknowledged UDP
  and a Hue 200 only means the bridge *queued* it (this repo has known that since v3.10.0),
  so "sent" is not "landed" — and the diff then believed the stale light was already
  correct and never retried it. At 20 frames between full repaints that's **10 minutes** of
  two-accent room.
- **`_lightshow_paint` now returns the cells that failed** and the loop leaves them out of
  `frame_map`, so the next frame retries them. That only catches errors we can *see*, which
  is why the load-bearing fix is the budget rule above: in the room that was reported, every
  step now re-asserts every light and a lost command heals in one step.
- **Seeding was decoupled from `full`.** The whole-device brightness seed for cloud_v2
  devices is a solid flash; now that a cheap room repaints fully every step, seeding with it
  would flash the strip solid every step. It rides the first paint of a run (and a cell-list
  change) only. Brightness doesn't drift on its own and any edit restarts the show.
- **Hue verify-and-repair is still deliberately NOT used here.** It compares only `on` and
  `bri`, never color — the bridge gamut-clamps, so comparing color re-repairs forever — and
  a show's entire content is color. Re-asserting the frame is cheaper and more direct.
  2. cloud_v2 segments are batched by color, exactly as a scene apply does. razer is never
     diffed — its wire protocol carries the whole strip in one packet, and re-sending it
     is also what keeps razer mode from timing out at 60s.
  3. **Per-device events are suppressed for the whole run** (`_suppress_publish`), with one
     `lightshow` event per frame instead — exempt from suppression by type, alongside
     `scene_apply`. Without that, every open browser would `loadAll()` (bridge read,
     phantom sweep, room-status pass) twice a minute for as long as a show runs. The
     frontend answers a `lightshow` event with a **lights-only** refresh.
- **The interval is the user's, floored by what a step actually costs.**
  `_lightshow_floor` derives the floor from the real cell composition and the panel shows
  it; a show whose step costs more than its interval is just a queue of overlapping
  repaints. `interval_s` stores what was asked for, `_lightshow_interval` is what runs, and
  the range is 10s–1h (`LIGHTSHOW_MAX_INTERVAL_S`) because "re-arrange the room every half
  hour" is a perfectly reasonable ask for something this ambient.
- **Brightness reaches a segmented device only on a full repaint**, as a whole-device seed
  before the segment calls (the same trick `_build_palette_scene` uses) — segment calls are
  color-only. Doing it every frame would flash the strip a solid color twice a minute. A
  *resting* segment (Alternate) is dimmed in RGB via `_scale_colors`, because that is the
  only lever a segment has.
- **`enabled` is the RUNNING flag and it is persisted on purpose**, so a show survives a
  restart. `_resume_lightshows` restarts them **behind `_recovery_done`**, like everything
  else that drives lights at startup.
### Something else turned the room off (v3.40.2)
"Turn off the living room lights" to a Google Home turned them off — and a few
seconds later the show turned them back on. Google talks to the bridge directly, so
LightEmUp never hears about it; this is the same reality `/api/rooms/status` exists
for, and a background loop is the worst possible place to be ignorant of it.

**`_lightshow_external_off` asks the bridge once per frame, BEFORE painting**: are
the lights this show most recently lit now off? One GET covers the whole house
regardless of light count, which at a 20s+ cadence is free. If so, the show stops
itself (persisting `enabled: False` — you asked for the room off, so it stays off).
Precision beats coverage, because a false positive stops a show the user wanted:
- **Only cells the show LIT count.** Alternate rests half the room at level 0 by
  design, and those must never read as evidence.
- **Unreachable lights are skipped** — a bulb on a flipped wall switch reports
  `on: false` forever and says nothing about the room.
- **Any lit light still on ⇒ not an external off.** A bridge that can't be read, an
  empty response, or a room with no Hue lights all return False: "can't tell" must
  never become "stop". Same rule as `_room_status`.
- **Known gap:** a Govee-only room can't be checked. LAN devStatus is a blocking
  sequential read holding port 4002 — not something to do every frame of every show.
- **The mid-paint window is now covered too (v3.42.1).** The check above only ever
  saw an off that arrived while the show was ASLEEP. One landing in the half-second
  the show is *painting* got overwritten, and our own writes then masked it for the
  rest of the interval — reported as "the globe came back on a few seconds later"
  and "the hex flashed on, then off again" (that second one is the vendor's slower,
  cloud-routed off for that device landing after our LAN command). So the loop now
  waits in TWO parts: a short `LIGHTSHOW_POST_PAINT_CHECK_S` (4s) window right
  after painting, then the rest of the interval. Both slices go through
  `_lightshow_wait`, which wakes early for a stop or a nudge — an earlier cut used
  a plain `asyncio.sleep` here and made the panel's Next-step button dead for four
  seconds, which the suite caught.
- **The post-paint check must EXCLUDE the cells that frame just wrote** (`skip=write`),
  and this is the subtle part. A mid-paint off darkens the room, then our remaining
  writes light some of it back up — so the cells written *after* the off report "on"
  and the all-must-be-off rule can never fire. The cells we did NOT touch this frame
  are clean witnesses: the show lit them on an earlier frame and nothing inside
  LightEmUp has touched them since. A full repaint leaves no witnesses and simply
  isn't judged.
- **On detection it puts the off BACK** (`_lightshow_restore_off`). Stopping is
  necessary but not sufficient — the lights the frame lit are still lit, and the
  user asked for the room off. The restore is bounded to exactly the cells THIS show
  painted at a level above 0, so a resting Alternate group is never touched, and a
  segmented device is switched off once as a whole (there is no per-segment off).

**Note this got worse before it got better.** With the v3.40.1 budget rule a cheap
room repaints EVERY light every step, so an external off used to bring back two
lights and now brought back the whole room. The check is what makes that safe.

### Two more things that made "off" unreliable (v3.40.2)
- **`stop_lightshow` now settles for `LIGHTSHOW_SETTLE_S` (0.3s) after cancelling.**
  `govee_lan_send` schedules its duplicate datagram as an **independent** task
  (`asyncio.create_task`, `GOVEE_RESEND_DELAY_S` later), so cancelling the show does
  NOT cancel it. A straggling "on + color" from the frame we just killed landed
  after the caller's "off" and switched that light back on — which is why turning a
  room off could take two presses. **Anything that cancels a task mid-send has this
  problem**; the resend is deliberately fire-and-forget and won't change.
- **Start/stop are serialized per room** (`_lightshow_locks`). Both had an `await`
  before registering their task, so two concurrent starts — and the panel
  auto-saves every control you touch, so two quick edits are two overlapping POSTs —
  could each get past it, both create a loop, and the second overwrite the first in
  `_lightshow_tasks`. The orphan then painted forever and nothing could ever stop
  it. `start_lightshow`/`stop_lightshow` take the lock; `_start_lightshow_locked`/
  `_stop_lightshow_locked` are the bodies, since start reuses stop.

- **Every hand-driven WHOLE-ROOM path retires the show** — `control_room`,
  `scene_room_apply` (non-scoped only), `_start_scene_apply`, `_apply_room_white`,
  `_apply_room_color`, `start_lightning` — because a show that repaints 30 seconds after
  you set the room reads as the app ignoring you. A **device-scoped** scene (one light
  card) deliberately does not: that isn't a claim about the room. **A new whole-room path
  needs `await stop_lightshow(room, reason)` AND `await stop_room_storm(room, reason,
  restore=…)`** — storms were missing from every one of these until v3.50.0.
- **"Now showing" is stamped ONCE, at start** (`kind: "lightshow"`), not per frame — an
  SD-card write every 30 seconds for a strip that says the same thing. No `expect`, so
  `/api/rooms/status` answers `unknown` rather than crying divergence at a room that is
  genuinely moving.
- It is room-name-keyed, so it's in **both** `rename_room` and `delete_room` — and
  `rename_room` also **re-keys the running task**, which is keyed by name and would
  otherwise keep painting a room that no longer exists.
- Covered by seven scratch tests. `test_override.py` (9 assertions) fakes a voice
  command landing mid-paint and proves the loop notices within seconds, restores the
  off, stops, and leaves the room dark — plus that it restores only the cells the
  show lit. `test_roles.py` (11 assertions) covers `color_order`. `test_writes.py`
  (9 assertions) counts WRITES per step
  and guards the floor and the reported number — the unit the v3.40.1 model lacked.
  `test_external_off.py` (17 assertions) fakes a
  bridge and covers the detector's whole truth table (lit-only, unreachable, partial,
  unreadable, empty, unpainted), proves the loop stops itself without repainting over
  the off, times the settle, and races three concurrent starts to prove exactly one
  loop survives. `test_accent_bug.py` (9 assertions) is the regression
  guard for the above: it drives the real loop logic over a simulated room, drops one
  command mid-Accent to **reproduce two lit accents**, and proves the next step heals it —
  plus that a segment-heavy room still diffs and still resyncs on the clock.
  `test_lightshow.py` (26 assertions): cell ordering, the
  segments/exclude narrowing, the interval floor, the diff (an unchanged frame sends
  nothing), Alternate's rest handling, the loop + nudge, every stop hook, and the rename
  re-key. `test_geo.py` (24 assertions): geometry detection, own-position ordering with the
  x=33 rope case, the per-geometry catalogs, the fallback, Walk reading indices on a line
  and coordinates on a plan, Alternate's checkerboard, Wipe moving exactly one cell per
  step *including across the wrap*, Comet's fade, Ripple's rings, Sweep's band, and the API
  refusal. Both stub `set_hue_light_state` as well as `control_hue_light` — `control_room`
  builds its own bridge calls, so without that a test reaches the real network.
  **When writing a pattern test, don't let the ring/stripe index alias against the palette
  length** (a distance of 3 against a 3-color palette passes for the wrong reason).

## Whole-room actions belong on the backend (v3.43.0)
Three controls used to fan out **from the browser** — one HTTP request per light,
all issued in the same tick, fire-and-forget: **Soft White**, **Cool White**, and
**All lights off**. That bypassed every reliability mechanism this file describes:
sequential pacing, the `_in_bulk_hue` guard, Hue read-back-and-repair, the Govee
power verify, the `ct_rgb` white calibration, and the "Now showing" record (which
the frontend then had to POST separately to make up for).

It also produced the largest burst the app can aim at a bridge with a **~10
command/second ceiling** — nine simultaneous PUTs for one room, and for "All off"
one per light in the house at once. The log shows the difference plainly: a
client-side fan-out lands out of order (`16, 17, 13, 10, 18…`) because the requests
are concurrent, while a backend path lands in order.

- **`POST /api/rooms/white`** → `_apply_room_white`, which already existed for the
  scheduler. The buttons now point at it, so a scheduled 2700K and pressing Soft
  White are the same code path and can't drift. It records "Now showing" itself,
  which is why `setRoomWhite`'s separate `/api/rooms/last-applied` POST is gone.
- **`POST /api/all/control`** drives every room through `control_room` — so each
  gets the pacing, the record and both verifies for free — then the devices in **no
  room**. "All lights" has to mean all of them, and the unassigned ones are exactly
  the lights nobody is watching. A room that raises is logged and skipped: a panic
  button that gives up halfway is worse than useless (same rule as zone control).
- **Verify coalescing is what makes this cheap.** Every room registers its
  expectations into the same `_hue_verify_pending` map, so the whole house still
  costs **one** bridge read.
- **`_apply_room_white` / `_apply_room_color` now register the Govee power verify
  too.** They had skipped it purely because they were written for the scheduler; a
  white preset is just as capable of not landing.
- **"Unassigned" keeps the client-side fan-out**, because it isn't a backend room
  and there is no endpoint that could take it. That's the one remaining `forEach`
  in `room-section.js`, and it's deliberate.
- Covered by `test_bulk.py` (17 assertions): the bulk guard is set, both verifies
  are registered, "Now showing" is recorded server-side, rooms and unassigned
  devices are each reached exactly once, and one failing room doesn't abandon the
  rest.

## Zones + safe room rename + Power action (v3.9.0, live control v3.15.0)
**Zones** (`config["zones"]`, additive `{ zoneName: { rooms: [name,…] } }`, name-keyed
like `rooms`; a room may be in several) are **both a live-control surface and a scheduling
target**. CRUD: `GET/POST /api/zones` (`ZoneRequest`; upsert by name, drops unknown
rooms), `DELETE /api/zones/{name}`.
- **`POST /api/zones/rename` (v3.15.0)** — `POST /api/zones` upserts by name, so renaming
  through it would leave the old zone behind and orphan any schedule pointing at it (the
  same trap `rename_room` exists to avoid). A zone name is referenced in **three** places
  and all three migrate: the `zones` key, `schedules[].action.zone` (held by value), and
  `room_last_applied[*].source_detail` (which credits the zone that set a room — cosmetic,
  but it would otherwise name a zone that no longer exists). 404 missing / 409 collision /
  400 blank; same-name is a no-op. The dict is **rebuilt in place rather than pop+assign**,
  because the zone bar renders in insertion order and a plain re-add would jump the renamed
  zone to the end of the row. **Add any new zone-name-keyed structure here.**
- **`POST /api/zones/control` (v3.15.0)** drives a zone right now — the "all downstairs
  off" panic button. It builds the same action dict a schedule would and calls
  **`_apply_action_to_room` per member with `source="zone"`**, so a button press and a zone
  schedule are the *identical* code path and each room's "Now showing" is credited to the
  zone instead of looking hand-set. Accepts `power` / `white` / `color` — **not `scene`**,
  for the same reason schedules don't: a scene is a device-specific resolved snapshot.
  A member room that was deleted or renamed away is **skipped and reported** in
  `skipped`, and one room raising doesn't abort the rest — a panic button that gives up
  halfway is worse than useless. Zones started life scheduling-only; that was too narrow,
  and the note here used to say "not a live-control surface (yet)".
- **Schedule actions can target a room OR a zone.** `action.zone` (optional, mutually
  exclusive with `action.room`) fans a **non-scene** action out over every member room.
  A **scene is room-only** — it's a device-specific resolved snapshot, so it can't span a
  zone. `_validate_schedule_action` enforces this at `upsert_schedule` (scene needs
  `room`+`payload`; zone forbids scene; every action needs a room or a zone).
- **New `power` action** `{type:"power", on:bool}` → `_apply_room_power` reuses
  `control_room` (`RoomStateRequest(on=…)`). Works per-room and per-zone.
- `_fire_schedule` dispatch: `scene` → one room (unchanged); `white`/`color`/`power` go
  through `_apply_action_to_room` per target — for a zone, loop `config["zones"][z].rooms`
  (missing zone or member is logged + skipped). **If you add a non-scene action type, add
  it to `_apply_action_to_room` AND the validator's allow-list.**

**Safe room rename** — `POST /api/rooms/rename` (`RoomRenameRequest {old_name,new_name}`;
404 missing old / 409 existing new). `POST /api/rooms` upserts by name, so a UI "rename"
there would create a new empty room and orphan the old one's sidecars. The rename endpoint
migrates the key in **every room-name-keyed structure** — `rooms`, `room_layouts`,
`room_color_state`, `lightning_scenes`, `room_presets` — and repoints references held by
value: `schedules[].action.room` and `zones[].rooms`. `delete_room` was hardened to match
(it now also prunes `room_presets` + zone membership). **When you add a new room-keyed
config structure, add it to BOTH `rename_room` and `delete_room`.**

## SSE live-sync (multi-session)
- `_event_subscribers` queues; `publish_event(type, **fields)` fans out to all open
  clients via `GET /api/events`. Each event is tagged with the originating client
  (`_current_client_id` ContextVar, set by HTTP middleware from the `X-Client-Id`
  header) so clients ignore their own echoes.
- **When you add a mutating endpoint, call `publish_event("config")`** (or a more
  specific type) so other open sessions refresh.
- SSE streams are long-lived requests that never complete. uvicorn is configured with
  `timeout_graceful_shutdown=5` (and the unit has `TimeoutStopSec=10`) so a restart
  force-closes them instead of hanging (v2.9.4). Don't remove these.
