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
  compared** — colour (xy/ct) is NOT, because the bridge gamut-clamps and rounds it, so
  exact comparison would false-repair forever. Unreachable lights are skipped (a re-send
  wouldn't land either). **`bri` is only compared while the light is ON** — verified live
  that most bulbs simply refuse a level change while off (a brightness-only command to a
  dark room left 7 of 9 lights unchanged, *identically* across 3 retries — deterministic
  device behavior, not packet loss), so checking `bri` on an off light would re-send
  forever for no gain. `control_hue_light` echoes back the `state` it sent so bulk
  callers collect faithful expectations, and the repair re-sends that **full** dict — so a
  repaired light keeps its colour, not just on/brightness.

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
`{on}` and a colour/CT pick sends `{on:true, …}`, whereas the brightness and colour-wheel
**drags** send `{brightness}` / `{r,g,b}` with no `on`. Drags commit every 180ms
(`useThrottledControl`), so verifying them would mean a GET per tick against a bridge with a
~10 cmd/sec ceiling. Two consequences worth knowing: a colour-only change is **unverifiable**
by design (xy/ct aren't compared), so a colour pick only confirms the light turned *on*; and
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
- `_hue_state_matches(sent, cur)` returns True/False/**None**. Colour comparison was
  rejected for *repair* (a false positive re-sends forever) — but for *display* a false
  positive only mislabels a strip, so a **tolerant** comparison is worth it, and it has to
  be: mode alone (xy vs ct) can't tell your palette from someone else's colour scene.
  `HUE_XY_TOLERANCE` 0.06 (gamut clamping shifts xy slightly; a different scene shifts it
  a lot), `HUE_CT_TOLERANCE` 25 mireds. Unreachable / `hs` mode / no xy reported ⇒ None.
- **Govee is deliberately not judged.** LAN devStatus reports colour unreliably and a
  running Govee-app animation isn't a static state at all, so "verifying" it would
  manufacture exactly the false confidence this exists to avoid.
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
were just read) and rewrites a **just-written** `expect_hue` with the colour the bridge
actually reports.

- **Why:** the bridge gamut-clamps. An outdoor bulb asked for xy `[0.184, 0.284]` settled
  at `[0.157, 0.379]` — dy `0.095`, well outside `HUE_XY_TOLERANCE` (0.06). Comparing
  later against what we *asked for* declared the room "Changed since" minutes after
  LightEmUp's own schedule set it: exactly the false alarm the feature exists not to
  raise. Loosening the tolerance enough to swallow a hard clamp (~0.12) would let a
  genuinely different colour hide inside it, so the comparison target moves instead.
- **Bounded to `EXPECT_RECONCILE_WINDOW_S` (45s) after the record was written.**
  Reconciling an older record would rewrite the evidence that something *else* changed
  the room — erasing divergence rather than reporting it, which is worse than the bug it
  fixes. Same reason a light whose brightness didn't take is skipped: a repair is in
  flight and baking in the wrong state would hide the miss. A colour-MODE mismatch
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
  `_run_scene_apply` (**only on completion** — a cancelled apply left the room half-set, so
  claiming it's showing that look would be a lie), `control_room`, the scheduler's
  `_apply_room_white`/`_apply_room_color`/`_apply_room_power`, and `start_lightning`.
- **`control_room` deliberately ignores a brightness-ONLY call.** That's the room slider,
  which fires repeatedly while dragging; recording it would churn the record and overwrite
  the scene's name with "brightness".
- **Swatches are derived server-side by `_scene_swatches`** from the already-resolved apply
  payload — the backend can't compute scene colours (that math is browser-only) but the
  payload it receives is fully resolved, so nothing extra has to be sent. Duplicates
  collapse, order is preserved (a palette reads as a sequence), capped at
  `ROOM_SWATCH_LIMIT`. White stores `kelvin` and **no** swatch: the frontend renders that
  chip via `kelvinToRGB`, so the backend needs no colour math for a temperature.
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
- **It's an envelope, not raw config.json**: `{lightemup_export, app_version,
  schema_version, exported_at, hostname, includes_credentials, config}`. The wrapper is what
  lets import recognise a real backup, **refuse one written by a newer build**
  (`schema_version > SUPPORTED_SCHEMA`) whose keys we'd silently mangle, and state up front
  whether credentials are inside. `_unwrap_import` still accepts a **bare config.json**
  (people pull that straight off the card), requiring a recognisable key so an unrelated
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
  (`phase`/`done`/`total`/`label`/`active`/`end_at`). During a run the task sets the
  `_suppress_publish` ContextVar so the per-call device events are NOT broadcast
  (no refetch storm); `scene_apply` events are exempt by type, and one `config`
  refresh is emitted at the end. One task per room (`_scene_tasks`); a new apply
  cancels the previous. `POST /api/scenes/room-apply/cancel` cancels by room.

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
- **No catch-up.** A schedule missed while the Pi was off does NOT retro-fire — waking
  to a 7am scene at 9am is worse than skipping it. Dedupe is `last_fired ==
  now.strftime("%Y-%m-%d %H:%M")`, so a schedule fires at most once per minute-occurrence.
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
**the** answer to "does a room scene paint this device per segment or as one colour?",
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
  light you wanted as one colour forced the hexa panels to match. Worse, the scheduler had
  no access to it and read `govee_segment_mode` instead — which **only the lightning panel
  writes** — so the same device could be painted per-segment by hand and as one colour on a
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

**Two colour actions, one engine (v3.28.0).** `type: "palette"` draws a random pick from a
curated set of LIBRARY palettes; `type: "colors"` carries its colours inline
(`{type:"colors", colors:[[r,g,b],…], brightness}`) for a look with no palette behind it —
alternating red/green at Christmas being the case that prompted it. The colours action is
wrapped as a one-off palette and handed to the SAME `_build_palette_scene`, which is what
makes two colours come out A-B-A-B down a hexa strip (`_ColorDealer` never repeats
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
  the two properties that matter — no two neighbours share a colour, and the arrangement
  re-rolls every fire. It emits a normal `SceneApplyRequest`, so **all the existing
  timing, staggering, cloud_v2 colour batching, progress SSE and "Now showing" recording
  come for free** (incl. `expect_hue`, so divergence detection works on palette fires).
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
  configurable beyond "off", revisit this** — catching up on a colour change hours later is
  exactly what the no-catch-up rule exists to prevent.
- **Saving clears `end_due`** when the trigger, action or end changes, or when the schedule
  is disabled — a disabled schedule turning lights off an hour later is unexplainable. A
  plain rename deliberately does NOT disturb a running span.
- `end` is three-state in the API (absent = leave alone, object = set, **explicit null =
  remove**), which a plain Optional can't express — `upsert_schedule` reads
  `req.model_fields_set`. The frontend always sends it.
- `_resolve_end_due` takes an injectable `sun_resolver` for the same reason `_schedule_due`
  does: astral is lazily imported and absent on dev boxes, so a test would silently get None.

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
