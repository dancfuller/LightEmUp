# backend/static/js/ — Frontend internals

In-browser React 18 + Babel standalone. **No build step.** Each file runs in the
global scope; top-level `function`/`const` declarations are effectively global. Files
load in the dependency order set by `<script>` tags in `../index.html` — that order is
authoritative (utils first, app last). See root `CLAUDE.md` for the mobile/responsive
rules that apply to every UI change. **Keep this file current when behavior changes.**

## Load order (from index.html)
utils → audio → components-shared → light-card → lightning-panel → room-map →
color-mode → segment-reset-debug → room-section → room-assignment → setup-wizard →
server-logs → ct-calibration → app

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
- **Apply pipeline (two phases):**
  1. *Fast base seed* — one whole-device LAN command per device, set to one of its own
     scene colors (the middle segment), **not** white. The strip looks right
     immediately and never flashes blue-white during the slow part (v2.9.7).
  2. *Batched segment apply* — group each device's segments by color, send one
     `POST /api/govee/segments-multi` call per distinct color, staggered ~1.8s.
     Per-segment brightness is folded into the color (no separate brightness calls).
- **Cancelable + live label:** `applyLabel` shows "Updating <name> · N panels/segments"
  — `panel` for hexa `H6061`, `segment` otherwise (see `nameForKey`). The Cancel button
  stops remaining staggered sends (`applyCancelRef`, `clearApplyTimers`).

## ct-calibration.js — RGB-space white calibration UI
Drives the device by **RGB** while tuning (so it warms past Govee's blue CT floor),
with a warmer slider reaching down to 1200K and live swatches. Saves `{in, out}` to
`POST /api/calibration/ct-rgb`. Props: `ctRgb`, `onSaved`.

## app.js — orchestration
State, routing, API calls. `controlHueLight` / `controlGoveeDevice` spread `cmd` into
the POST body, so passing CT keys (`color_temp` mireds / `color_temp_kelvin`) works
without new endpoints. Opens the EventSource on mount and coalesces incoming SSE into a
debounced `loadAll`. `ctCalibrated = {...ctCorrection, ...ctRgb}` drives the badges.
