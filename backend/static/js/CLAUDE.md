# backend/static/js/ — Frontend internals

In-browser React 18 + Babel standalone. **No build step.** Each file runs in the
global scope; top-level `function`/`const` declarations are effectively global. Files
load in the dependency order set by `<script>` tags in `../index.html` — that order is
authoritative (utils first, app last). See root `CLAUDE.md` for the mobile/responsive
rules that apply to every UI change. **Keep this file current when behavior changes.**

## Load order (from index.html)
utils → audio → components-shared → light-card → lightning-panel → room-map →
palette-data → color-mode → segment-reset-debug → room-section → room-assignment →
setup-wizard → server-logs → ct-calibration → app

A new file must be added to index.html in the correct slot (after its dependencies).

## utils.js — shared foundation
- React hooks destructured here for everyone: `const { useState, useEffect, ... } = React`.
- `api(path, opts)` wrapper — injects the per-tab `X-Client-Id` header (`CLIENT_ID`).
- Color math: `hueXYToRGB`, `kelvinToRGB`, `kelvinToMired`, `spreadKelvin`, `hslToRgb`.
- `useIsMobile()` — 640px breakpoint. Required for all responsive forks.
- `hashStr` / `seededRng` (mulberry32) — deterministic PRNG for palette assignment.
- `useThrottledControl(value, onCommit, ms=180)` — instant local thumb/label +
  trailing-throttled commit + drag guard so external updates don't yank the thumb back.
  Every slider that drives a light routes through it (wired into the shared Slider /
  ColorTempSlider / RgbSliderInput). This is why sliders feel instant despite slow
  LAN apply — don't fire raw commands on every onChange tick (that floods the LAN).

## color-mode.js — the room color tool (most complex file)
Assigns colors/temperatures across a room's devices and applies them.
- **Deterministic assignment:** all assignment randomness goes through
  ``seededRng(`${roomName}|<mode>|${shuffleSeed}`)``, never `Math.random`. This keeps
  the same layout across sessions (phone vs PC). `shuffleSeed` is persisted; the
  Shuffle button bumps it.
- **Color vs White space:** `colorSpace` is `"color"` or `"white"`. White mode emits
  entries with a `kelvin` field; whole-device/Hue apply sends real CT, segments send
  the K→RGB approximation (calibrated server-side via `ct_rgb`).
- **Teams / NCAA / Flags modes** are preset-color modes backed by `palette-data.js`
  (`PRESET_TEAMS` NFL/NBA/MLB/NHL, `PRESET_NCAA` Power 5, `PRESET_FLAGS` ~195
  countries). A searchable `PresetPicker` selects one entity by name; its hex colors
  (near-black filtered via `isNearBlack`) are assigned with the shared `cycleAssign`
  — the same positional cycle as Custom mode — and honor the shared `ShadeToggle`
  (`customShadeMode`: exact colors, or tonal shades per color). These modes are
  color-only: they ignore the Color/White space (the toggle is hidden via
  `isPresetMode`). Selection persists as `selected_team`/`selected_ncaa`/`selected_flag`.
- **Custom mode assignment is a positional cycle, not an adjacency graph.**
  `computeCustom` sorts devices spatially (linear → left-to-right; floor plan →
  row-major) and colors them `A,B,C,A,B,C…` along that order, shifting each row by one
  so neighbors differ (clean `ABAB` instead of clumped `AABB`). Shuffle rotates the
  start color; "shades" mode advances a shade on each wrap. `buildAdjacency` is still
  used by Palette/Gradient/Beacon/CT-pool modes — don't delete it. **Segments now
  spatially constrain neighbors (v2.14.2):** the old relaxation skipped every spatial
  edge that touched a segment of a different device, so two side-by-side strips (and a
  strip next to a bulb) had *no* adjacency constraint and palette colors clumped. Now a
  segment constrains nearby segments of other devices and nearby whole lights; only
  same-parent segment pairs are still handled purely by the intra-device rule. A lone
  hexa close to other lights may over-constrain a small palette, but the relax
  fallbacks resolve it. Each custom seed
  slot can be Color (hue) or White (a `kelvin` temperature); `applyMinSat` must not
  saturation-clamp `kelvin` entries.
- **Palette is a shuffle pool, not a per-light list (v2.17.0):** do NOT trim the palette
  down to the light/segment count. `computePalette` already picks a distinct, room-sized
  subset from the full `paletteColors` and Shuffle (`shuffleSeed`) re-rolls which colors
  are used — so a 2-light room with an 8-colour palette cycles through all 8 across
  shuffles. Trimming to slot count strands the rest of the palette and makes Shuffle
  repeat the same two colors — don't reintroduce it. The room only ever *shows* as many
  colors as it has lights; the extras stay in the pool. (Stepper/seeds keep their plain
  caps: palette ≤24, custom seeds ≤4.)
- **Selectable before layout (v2.17.0):** the mode/palette UI is gated on
  `hasColorLights`, not `hasLayout`, so a palette/scene can be chosen (and persisted)
  before the room map is laid out — a warning banner ("Finish setting up the room layout
  in Controls…") shows above it. Preview + Apply still require a layout (`generatePreview`
  no-ops without one, and Apply is disabled while `preview` is null).
- **Target vendor:** `targetVendor` (`"all"`/`"hue"`/`"govee"`) filters which devices
  apply (toggle only shown when both vendors are present). Persisted as `target_vendor`.
- **Apply is backend-driven (v2.13.0).** `applyColors` resolves the preview into a
  plan (base seeds, hue, govee_whole, razer, cloud segment groups batched by color)
  and sends it in **one** `POST /api/scenes/room-apply`. The backend owns all the
  timing/staggering in a background task, so the browser can be closed right after
  Apply. The frontend does NOT schedule the sends anymore.
- **Progress + cancel over SSE:** the backend emits `scene_apply` events; `app.js`
  re-broadcasts them as a `window` `"lightemup-scene-apply"` CustomEvent, and a
  ColorMode effect (filtered by `roomName`) drives `applying`/`applyPhase`/`applyDone`/
  `applyTotal`/`applyLabel`/`applyEndAt`. So any open session shows live progress, not
  just the one that pressed Apply. Cancel → `POST /api/scenes/room-apply/cancel`.

## ct-calibration.js — RGB-space white calibration UI
Drives the device by **RGB** while tuning (so it warms past Govee's blue CT floor),
with a warmer slider reaching down to 1200K and live swatches. Saves `{in, out}` to
`POST /api/calibration/ct-rgb`. Props: `ctRgb`, `onSaved`.

## State comes from the backend (don't re-derive in the browser)
The frontend paints what the backend returns; it does not merge or reshape device
state (v2.14.0). Govee devices arrive with color already overlaid, Hue lights carry
`state.color` (RGB from xy), segment state arrives in `{ip:{colors:{idx:{r,g,b}},
brightness}}` shape, and favorites come from config (`POST /api/favorites` to save —
no more localStorage). `getInitialColor`/`hueXYToRGB` remain only for the interactive
color picker; the *displayed current color* now comes from backend `state.color`.

## Settled architecture decisions (do not "fix" these)
The goal is a thin frontend: the backend owns all derivation, scheduling, and
state-of-record. Two deliberate exceptions stay client-side — they are display
conveniences, not logic, and the backend is still the single source of truth:

- **KEEP optimistic UI.** Control actions (toggle, brightness, color) update local
  React state immediately and fire the API in the background (fire-and-forget); the UI
  does not wait for the backend. Any disagreement self-corrects on the next load/SSE
  refresh. Making the UI wait for backend + SSE confirmation would make every control
  feel laggy (esp. slow Govee LAN) for no architectural gain. Do not remove this.
- **No server-side scene preview.** The room color tool computes its preview locally so
  slider/shuffle/mode edits stay instant. The preview is just a "what will this look
  like" visualization; the actual apply is already server-side
  (`POST /api/scenes/room-apply`), so there's nothing to gain by round-tripping the
  preview. Do not move preview computation to the backend.

## Govee devices: assume-presence (v2.16.0)
`GET /api/discover/govee` returns a `responding` flag on each device and includes
known-but-silent devices (`responding: false`, rendered from last-known state). The
frontend puts **all** of them in `goveeDevices`, so a device that missed a scan still
appears in rooms / the color tool / the map and stays controllable (control is
fire-and-forget UDP by IP); `light.state.reachable === false` drives the existing
"offline" badge + dimming on the LightCard. Settings filters its main Govee list to
`responding !== false` (absent devices show in the "not responding" section instead).
Don't gate per-device UI on the live scan — the backend already assumes presence.

## Settings device list (app.js — `SettingsDeviceRow`)
Settings → Hue Bridge / Govee Devices render each device through `SettingsDeviceRow`,
which gives every device (Hue or Govee, present or missing) inline nickname editing
(same `POST /api/nicknames` as the light cards) and a **Flash** button that hits
`POST /api/identify` to locate it physically. `flashBody` is the payload
(`{light_id}` for Hue, `{ip}` for Govee); pass `null` to hide Flash (unreachable/
missing devices). `extra` injects per-row buttons (the missing-device Re-scan/Forget).

## Full-window room-layout editor + numbered dots/legend (room-map.js, v2.19.0)
The map was unusable crammed into the ~416px controls drawer (`ControlSurface`). Now
`RoomMap` has an `expanded` state (`fullScreen = expanded`, all devices — the old
`isMobile && isEdit` trigger is gone):
- **Collapsed** (in the drawer): renders a compact **legend** (color swatch + number +
  name, ordered row-major) + an "Open layout editor" launcher button. No cramped map.
- **Expanded**: the whole editor renders in a fixed full-window overlay (`zIndex 1000`,
  above the drawer) with a sticky header (room + Done→`setExpanded(false)`). The SVG
  renders at a fixed on-screen cell size (`FS_CELL`=66 px, `fsScale = FS_CELL/gridSize`)
  in a pannable container; viewBox stays in user units so `getScreenCTM()` drag math is
  unaffected. `touchAction` is `pan-x pan-y` here (canvas finger-pan; an active node drag
  still wins via its non-passive `touchmove` `preventDefault`).
- **Nodes are numbered colored dots** (`compact` prop, both layouts). `DeviceNode`/
  `SegmentNode` size the dot/number as a fraction of the cell (`gridSize*0.36`) so it
  renders at a constant readable px size under `fsScale`. Named pills were dropped — long
  device names made them unwieldy. The legend renders below the map too.
- **Dot color is a DISTINCT identification color, not the light's real color** (v2.19.1).
  Real light colors repeat (two green spotlights, all segments of one strip the same),
  which is useless for telling entries apart. `distinctColor(i)` assigns each legend
  entry (every device AND every segment) a color from a curated max-contrast palette
  (`DISTINCT_COLORS`), used for BOTH the dot and its legend swatch so they glance-match.
  Don't revert dots to `getDeviceColor` here.
- **Numbering/coloring must be STABLE (v2.19.2)** — number and color derive from the
  legend index, so the ordering of `legend` determines them. Floor Plan numbers by
  **device insertion order** (no `sort` — a fixed ID per light that never changes on
  drag); a line numbers by **position** (`sort` by x — reads 1..N, stable across the
  order-preserving compaction, changes only on a deliberate reorder). Do NOT sort the
  floor-plan legend by position — that renumbers/recolors dots every time you move one.
- **Line compaction** (`compactLinearLayout`): a line is an *ordering*, so arbitrary
  x-gaps (e.g. devices at x=1,12,33,50 on a length-52 strip) just push most dots off
  screen. On opening the editor, line entries (placed devices + each segment of an
  expanded device) are renumbered to consecutive positions `1..N` by order and the
  boundary shrunk to fit — so every dot is visible and big. No-op once compact (doesn't
  loop or fight drags). Start at 1, not 0, so the first dot isn't clipped at the edge.

## app.js — orchestration
State, routing, API calls. `controlHueLight` / `controlGoveeDevice` spread `cmd` into
the POST body, so passing CT keys (`color_temp` mireds / `color_temp_kelvin`) works
without new endpoints. Opens the EventSource on mount and coalesces incoming SSE into a
debounced `loadAll`. `ctCalibrated = {...ctCorrection, ...ctRgb}` drives the badges.
