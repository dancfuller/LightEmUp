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
  used by Palette/Gradient/Beacon/CT-pool modes — don't delete it. Each custom seed
  slot can be Color (hue) or White (a `kelvin` temperature); `applyMinSat` must not
  saturation-clamp `kelvin` entries.
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

## app.js — orchestration
State, routing, API calls. `controlHueLight` / `controlGoveeDevice` spread `cmd` into
the POST body, so passing CT keys (`color_temp` mireds / `color_temp_kelvin`) works
without new endpoints. Opens the EventSource on mount and coalesces incoming SSE into a
debounced `loadAll`. `ctCalibrated = {...ctCorrection, ...ctRgb}` drives the badges.
