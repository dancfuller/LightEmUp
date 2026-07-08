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
