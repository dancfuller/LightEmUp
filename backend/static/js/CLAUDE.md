# backend/static/js/ — Frontend internals

In-browser React 18 + Babel standalone. **No build step.** Each file runs in the
global scope; top-level `function`/`const` declarations are effectively global. Files
load in the dependency order set by `<script>` tags in `../index.html` — that order is
authoritative (utils first, app last). See root `CLAUDE.md` for the mobile/responsive
rules that apply to every UI change. **Keep this file current when behavior changes.**

## Load order (from index.html)
utils → audio → components-shared → light-card → favorite-lights → lightning-panel →
room-map → palette-data → palette-library → color-mode → light-scene → location-data →
schedules → lightshow → segment-reset-debug → room-section → zones → room-assignment →
setup-wizard → server-logs → ct-calibration → delivery-health → usage-log → backup-restore →
app

A new file must be added to index.html in the correct slot (after its dependencies).

## utils.js — shared foundation
- React hooks destructured here for everyone: `const { useState, useEffect, ... } = React`.
- `api(path, opts)` wrapper — injects the per-tab `X-Client-Id` header (`CLIENT_ID`).
- Color math: `hueXYToRGB`, `kelvinToRGB`, `kelvinToMired`, `spreadKelvin`, `hslToRgb`.
- **Hex ⇄ RGB (v3.7.0):** `hexToRgb(hex)` / `rgbToHex(r,g,b)` live here (canonical —
  `color-mode.js` used to carry its own `hexToRgb` for the preset palettes; that copy is
  gone). `hexToRgb` takes the `#` as **optional** and accepts 3-digit shorthand
  (`#1e90ff`, `1e90ff`, `#19f`, `19f`), returning `null` for anything unparseable — that
  null is what the manual hex input uses to tell a half-typed draft from a real value.
  `rgbToHex` always emits canonical uppercase `#RRGGBB`.
- `useIsMobile()` — 640px breakpoint. Required for all responsive forks.
- `hashStr` / `seededRng` (mulberry32) — deterministic PRNG for palette assignment.
- **Device identity keys (v3.0.0):** `deviceKey(device)` → `hue:<id>` or
  `govee:<slug>`, where `goveeSlug(device)` = `normMac(device.mac)` (colon-free, lower;
  falls back to the IP for a device with no mac). A Govee device's identity is its stable
  **mac**, NOT its DHCP IP — so ALL association lookups (nicknames, room membership,
  layouts, `device_modes`, `segment_fill_modes`, `configured_counts`/`segment_mode`,
  `ct_rgb`) key by the slug, and `rooms[*].govee_devices` stores slugs. Mirrors backend
  `gv_slug`/`gv_key`. **Never build a Govee key from `.ip` again — use `deviceKey`/
  `goveeSlug`.** The live UDP address is still `device.ip`: control POSTs send both
  (`{ ip, mac }`), and the transient `segmentState`/`segment-state` map stays IP-keyed.
- **Govee segment-count precedence — `configured_counts` WINS over the SKU default
  (v3.5.2):** a device's real segment count is `configured_counts[slug] || sku_table[sku]
  .count`. The SKU count is only the product-line *max* (e.g. Glide Hexa H6061 = 15) and is
  a fallback; the configured count is the user's ground truth (a 7-panel Hexa). Every count
  consumer must use this order — `room-map`, `room-section` (`segmentCountFor`),
  `segment-reset-debug`, `light-card` (`segCount`), and `color-mode` (`segCountForDevice`).
  `light-card` used to prefer the SKU count and rendered 15 segment boxes for a device laid
  out + scened as 7 — don't reintroduce SKU-first precedence anywhere.
- **Setting the count — the LightCard stepper (v3.6.0):** the LightCard's Segments section
  has a "Segments on this device" −/+ stepper (`onSegmentCountChange` → app's
  `updateSegmentCount` → `POST /api/govee/segment-count`, optimistic on
  `segmentInfo.configured_counts`). This is the **trustworthy** way to set the real panel
  count. **Do NOT try to auto-detect from Govee's API** — a probe confirmed the v2
  `segment_color_setting` capability returns a blanket `elementRange 0–14` (15) for nearly
  every SKU and a `size.max` that's a per-request batch limit, not the panel count (a
  2-pack reported 15, a 7-panel Hexa reported 21). Neither reflects reality; manual is the
  only reliable source.
- **`useSceneProgress(scope)` + `<SceneProgressBar>` (v3.35.0)** — one listener for the
  `lightemup-scene-apply` window event, filtered by **scope** (a room name, or a device
  key for a one-light scene). Returns `[state, begin, clear]`; `begin(total, endAt)` lets
  a caller show progress the instant it presses Apply, because the backend spends ~2.6s
  on the base seed + settle hold before the first segment event lands and a silent panel
  reads as a dead button.
  - **It's a hook because three surfaces need the same answer** — the scene panel, the
    light card's header, and the favorites row. A segmented apply runs 13+ seconds, so
    "is this still working?" has to be answerable from wherever the user is looking.
  - **An event is ours two ways (v3.35.1).** Either `scope` matches — the run is ABOUT
    us — or `device` matches, meaning a **room** scene's current step is touching us. A
    room apply is scoped to the room, so before the device match a segmented globe or
    rope sat visibly idle through the 1.8s-per-color it was actually being painted.
    Backend side: `tick(..., device=gv_key_for_ip(...))` on every Govee step (Hue is
    left unnamed on purpose — it has no per-card scene surface and applies instantly).
  - **A room run's terminal event names NO device**, so a listener that only ever
    matched via `device` would never see the end and would stay "applying" forever. The
    hook remembers which room adopted it (`adoptedRoom`) and accepts that room's close.
    **Keep that if you touch the matching logic** — it's the difference between a status
    that clears and one that sticks until reload.
  - **Always pass the backend's `label` through.** It names what is being set *right
    now* ("Hex Lights · 2 panels"). The first per-light implementation hand-rolled its
    own listener and dropped it, leaving a bare count buried at the bottom of an open
    panel — which is why the per-light status was reported as missing entirely while the
    room's looked fine. That's the drift this hook exists to prevent.
- `useThrottledControl(value, onCommit, ms=180)` — instant local thumb/label +
  trailing-throttled commit + drag guard so external updates don't yank the thumb back.
  Every slider that drives a light routes through it (wired into the shared Slider /
  ColorTempSlider / RgbSliderInput). This is why sliders feel instant despite slow
  LAN apply — don't fire raw commands on every onChange tick (that floods the LAN).
- **An accidental TOUCH must never drive a light (v3.32.0).** Two separate gestures could,
  and the fixes are separate too — **a new light-driving slider needs BOTH**:
  1. **`touchAction: "pan-y"` on the `<input type="range">`.** Range inputs default to
     `touch-action: auto`, so a swipe that *begins* on a slider is captured by the slider
     instead of scrolling the page. `pan-y` gives vertical gestures back to the page and
     keeps horizontal ones for the control.
  2. **Spread the hook's third return value, `guard`, onto the input.**
     `const [local, onInput, guard] = useThrottledControl(...)`. A range input's TRACK is
     tappable — landing a finger anywhere on it jumps the thumb, which the browser reports
     as input, which `onInput` committed **immediately** (the throttle only ever governed
     the *second* command onward). So on touch the guard waits for `TAP_SLOP_PX` of real
     travel before anything is sent; the thumb still follows the finger, and a tap that
     never moved snaps back to the device's real value.
  **A mouse is deliberately exempt** — clicking a track to jump to 60% is a normal desktop
  interaction, and a pointer can't brush a control while scrolling. Verified with
  synthetic pointer sequences: touch-tap ⇒ 0 commands, touch-drag ⇒ 1, mouse-click ⇒ 1.
  This came from a real report: scrolling the All Lights list to reach the hexa panels
  sent a command to the patio bulb sitting directly above them.
- **The color bar and wheel got the same rule in v3.50.0.** The Fable review found
  `HueBar` — the default color control on every light card — still picked on touch-DOWN
  and called `preventDefault`, so a scroll starting on it was swallowed and sent a color,
  one command per finger movement. Neither is a range input, so the guard is hand-rolled
  in `components-shared.js` rather than taken from the hook:
  - `HueBar` has `touchAction: pan-y`. Touch-down picks nothing; a mostly-vertical move
    lets go and the page scrolls; a horizontal move past `TAP_SLOP_PX` is a drag. A tap
    **does** pick, on release — tapping a hue is a real gesture here, unlike tapping a
    slider's track — and it is **judged from where the finger lifted**
    (`changedTouches`), because a browser may stop reporting moves once it starts
    scrolling, and a scroll must never read as a tap. A `touchcancel` never picks.
  - `ColorWheel` keeps `touchAction: none` (it is a 2D surface) but likewise picks on a
    tap's release or after real travel, never on touch-down.
  - Both ignore a mousedown within 800 ms of a touch. Phones follow a tap with
    compatibility mouse events, which picked a second time.
  - Both throttle through `useCommitThrottle` (180 ms, trailing): the sliders' cadence.
  Verified with real CDP touch sequences (`tools/preview/_shoot_touch.mjs`, scratch).
  The old bar: a scroll starting on it sent **12** commands, a tap sent 2, a 40-move
  drag sent 39. The new one: 0, 1, and one per 180 ms; a desktop mouse click still
  sends 1.
  **This is not stage-then-apply, and shouldn't become it** — a dimmer you have to confirm
  stops being a dimmer. The `ColorPicker`'s staging exists because picking a color has a
  discrete "I chose this" moment; brightness has none.

## components-shared.js — manual color entry (v3.7.0)
The ColorPicker's **RGB** tab is not slider-only: each channel has a number box, and a
`HexColorInput` row underneath takes a full hex code. All three paths (wheel/hue bar,
sliders, hex) converge on the same `onColorSelect(r,g,b)`. `HexColorInput` is also used by
`lightning-panel.js` (where it commits `color_r/g/b` as three `updateSetting` calls).
- **Draft state is the whole trick.** Both the RGB number box and the hex field keep a
  local `draft` string while the user types and only commit when it *parses*. Without it,
  clearing the field to retype instantly commits `0` (`Number("") || 0`) and fires that at
  the light — the old number box did exactly this. An unparseable hex draft renders red and
  is never sent; `onBlur` drops the draft so the field snaps back to the real value.
- The `#` is a fixed prefix glyph and the input holds the bare digits, but a pasted
  `#RRGGBB` still works because `hexToRgb` strips it. Never require the user to match a
  format.
- **Stage-then-Apply (opt-in, v3.7.2):** ColorPicker takes `stageApply` + `onApply` +
  `applyLabel`. **Default off** — the picker keeps its immediate `onColorSelect` behavior
  everywhere it's used (per-device LightCard, room map, and the color-tool *base-color*
  pickers, which must live-preview into `baseColor` and must NOT be given staging). Only
  the **room Controls** picker (`room-section.js`) opts in: there, picking a wheel/RGB/hex
  color or tapping a favorite **stages** a pending color (updates the local preview, drives
  no lights) and a prominent "Apply to {room}" bar commits it via `onApply` (the old
  immediate-apply gave zero feedback that a color was set — the reported bug). The staged
  favorite shows a dashed indigo ring + "Staged" chip; the favorite equal to the live
  `currentColor` shows a solid ring + "Applied" chip. Both chips are judged against
  `currentColor` (the real light state) / the staged pick — **never** the default local
  RGB, so the 255/180/100 default never falsely flags the "Warm" favorite. A `stagedRef`
  guards the `currentColor`→local sync effect so an SSE refresh mid-edit can't clobber an
  unapplied pick. The bar reads "Pick a color to apply" until a color is known/applied.

## components-shared.js — the color clipboard (v3.38.0)
Copy a color off one light or segment and paste it onto another ("make the Triple Lamp's
bottom bulb match its top"). The store is `utils.js`; the UI is two rows inside
**ColorPicker**, so all eleven call sites got it at once — per-light card, per-segment
editor, room map, room Controls, the scene base pickers, schedules.
- **It's a stack of recent copies, not one slot.** The job is nearly always "make these
  three match" or "reuse the two colors I just set", where one copy is pasted repeatedly
  and the previous one still needs to be reachable. Cap is `COLOR_CLIPBOARD_MAX` (8),
  newest first, and re-copying a color you already hold moves that entry to the front
  rather than duplicating it. The newest swatch wears an indigo ring — that's the one a
  plain system paste would have given you.
- **Copy takes the LOCAL pick (`localR/G/B`), not `currentColor`.** Otherwise dragging the
  hue bar and hitting Copy would silently copy the color you just moved away from.
- **Paste goes through `chooseColor`**, so it obeys `stageApply`: in the room Controls it
  *stages* like any other pick instead of jumping straight to the lights. Don't shortcut it
  to `onColorSelect`.
- **The PASTE row only renders once something has been copied.** That keeps it free until
  the feature is used, and appearing on the very first Copy is how it teaches itself —
  there is no empty state to explain.
- `sourceLabel` (optional prop) is what the paste tooltip credits the color to. `light-card.js`
  passes the device name, or `"{device} · Segment C"` in segment mode; `room-map.js` passes
  the selected dot's label. The scene/schedule pickers omit it on purpose — their color is
  an input to a look, not a color that came off a device — and the tooltip is just the hex.
- **Why this one is in `localStorage` when favorites deliberately are not** — see the
  comment block in `utils.js`. Favorites are curated, durable, synced, and belong in a
  backup; the clipboard is churn from the last few minutes, is scoped to the browser you're
  copying in, and would be noise in an export. It is NOT a config key and there is nothing
  for the config-key checklist to do. The ★ Save button next to Copy is the promotion path
  from "used it a second ago" to "keep it forever". Don't "fix" this by moving it to the
  server.
- Cross-tab sync is real: same tab hears the `leu-color-clipboard` CustomEvent (the native
  `storage` event fires only in OTHER tabs, so on its own the copying tab would show a
  stale strip), other tabs hear `storage` and re-read. Every storage access is wrapped —
  it throws outright when site data is blocked, and a corrupt entry must cost an empty
  strip, not a crash.
- `copyTextToSystemClipboard` mirrors the hex to the real clipboard as a bonus. The Pi is
  served over plain `http://`, which is **not** a secure context, so `navigator.clipboard`
  is usually undefined and the deprecated `execCommand` fallback is the path that actually
  runs. It fails silently on purpose — the in-app clipboard has already succeeded by then.

## The "Live" bar (app.js, above `<main>`)
The always-present strip holding **All lights off** + `ZoneBar`. It renders on every tab,
which is the point — a panic button has to be reachable from wherever you are.
- **It must announce ITSELF, not just its buttons (v3.19.1).** With only sub-labels
  ("All Lights", "Zones") and no background of its own it read as the top of whatever page
  you were on: landing on **Schedules**, the first thing you saw was an unexplained row of
  on/off controls with no hint that it wasn't part of scheduling. The `● LIVE` pill names
  the thing that separates it from every page below — these act on the house *right now* —
  and the darker tint plus bottom border make it chrome rather than content.
- Keep the region label if you restyle this. The sub-labels are the expendable part; the
  "this is not the page" signal is not.

## Interface fixes from the review (v3.51.6)
Thirteen small ones, with the rules worth keeping:
- **Tap-to-place on a floor plan uses the cell-center rule**, `round(p / grid - 0.5)`,
  the same as dragging (v2.19.5). A line has no offset.
- **Zone buttons are busy per zone** (`zones.js`). One zone in flight disabled them all.
- **An unknown brightness reads "—"** (`Slider`'s `valueLabel`), for both vendors, until
  someone moves it. It read 0% for Hue and 50% for Govee. A Hue level of 0 means the
  bridge reported none, since Hue levels are 1–254.
- **Govee light cards are keyed by `goveeSlug`**, not IP — a DHCP change remounted the
  card and dropped whatever was open on it. Never key a Govee device by IP.
- **The header ↻ also runs the live Govee scan**, in the background. Its title promised
  all device states; after the first load `loadAll` only reads the cached Govee list.
- **The Scenes panel:** Beacon re-picks its source when the vendor filter changes which
  lights are placed; the per-device segment rows hide while the filter is Hue-only; and
  a trimmed palette saves `palette_source`, so + regrows its own colors after a reload.
  **`palette_source` is part of the three-place rule** (snapshot, `RoomColorStateRequest`,
  hydration). The panel also says that − hides a color and × removes it for good — the
  preset modes' tap-to-restore swatches made removal look reversible everywhere.
- **Schedules:** the "days above" note is hidden for a one-off (it has a date, not days),
  and the location banner counts only enabled sun schedules.
- **The log viewer follows new lines only while you're at the bottom.**
- `hueXYToRGB` returns null for y = 0.

## lightning-panel.js — `StormStopBar`, the app-wide Stop (v3.51.0)
A storm is the one thing here people start out of curiosity and then want OFF *right
now* — reported plainly: everyone is fascinated for about ten seconds and then urgently
wants it to stop. Its Stop lived inside that room's drawer, two taps deep and invisible
from every other tab.
- **It is APP CHROME, like the Live bar and the Favorites strip**, rendered from `app.js`
  above `<main>` — but `position: fixed` at the **bottom** of the viewport, because that
  is where a thumb already is and the top is full of tabs. `zIndex: 1100` clears the
  drawers and the full-window map editor (1000). `bottom` adds
  `env(safe-area-inset-bottom)` so an iPhone's home indicator can't sit on it.
- **It renders `null` when no storm is running**, so it costs nothing the rest of the
  time. `rooms` is `lightningActiveRooms` — the backend's own status, refreshed by SSE —
  so a storm someone ELSE started shows the Stop in every open session.
- One room ⇒ one wide "Stop the storm". Several ⇒ a "Stop all storms" plus one per room,
  because stopping the right room has to stay possible. Buttons are ≥48px tall on mobile:
  this gets pressed in a dark room.
- Stopping restores what the storm replaced, so it isn't instant — the button reads
  "Stopping…" until the room leaves `rooms`, and a failed stop hands the button back
  rather than leaving a dead control.
- Verified in the harness with the status GET faked (`tools/preview/_shoot_storm.mjs`,
  scratch) at 1440 and 402px: no real storm is started and no light in the house flashes.

## zones.js — live zone controls + zone management (v3.15.0)
A zone is a named group of ROOMS. It shipped in v3.9.0 as a **scheduling target only**,
with its editor collapsed inside the Schedules tab. That was the wrong shape twice: the
everyday use of a zone is a **panic button** ("all downstairs off" on the way to bed), and
grouping rooms is an organizational act that belongs beside assigning devices to rooms,
not buried under automation. So the file owns two components:
- **`ZoneBar`** — On/Off per zone, rendered in the **global bar next to "All Off"**, which
  means every tab. That placement is the feature: a panic button has to be reachable from
  wherever you already are. It renders **nothing** when no zones exist, so the bar stays
  clean for anyone not using them. Buttons disable while a command is in flight (a zone
  press fans out over several rooms and isn't instant).
- **`ZoneManager`** — create/edit/**rename**/delete, rendered at the top of **Assign
  Rooms**. Zones group rooms the same way rooms group devices, so both live on the
  organizational tab. It's a plain always-open card here, not the old collapsed disclosure.
  The name field is editable for existing zones (it used to be disabled because renaming
  wasn't supported); `saveDraft` compares against `_original` and, when they differ,
  **renames FIRST and only then saves membership** — the other order would upsert a second
  zone and strand the first. `onRenameZone` resolves to `true` or an error *string* rather
  than throwing, so a name collision keeps the editor open with the backend's reason
  showing instead of silently discarding the edit.

`app.js`'s `controlZone` POSTs `/api/zones/control` then `loadAll()` — a zone changes
several rooms at once, so resync rather than trying to predict the result optimistically.
**The Schedules tab no longer owns zones**; it still targets them (the Room/Zone toggle in
`ScheduleEditor`) and shows a pointer to Assign Rooms instead of a second editor, so
membership has exactly one place it can change.

**A pointer to another tab must BE a link (v3.28.1).** Naming a destination in prose and
then making the reader walk there is the layout apologizing for itself. Both places that
did it — the Schedules zones note and the empty-room text in `room-section.js` — now
render "Assign Rooms" as an underlined indigo button wired to `onNavigate(tab)`, which
`app.js` supplies as `setActiveTab`. **Any new copy that names a tab gets the same
treatment**; thread `onNavigate` down rather than reaching for a global. It's optional
everywhere it's used (the control renders inert, never broken, if a call site omits it).

**A tab opens at ITS top (v3.28.2).** `setActiveTab` in app.js is a `useCallback` wrapping
`setActiveTabRaw` + `window.scrollTo(0)` — the scroll offset belongs to the page you left.
Switching tabs is a route change with no route, so nothing reset it: following the zones
link from the bottom of Schedules (scrollY 255) landed on Assign Rooms at **scrollY 2836**,
because it's a far taller page and the retained offset was still valid there. **Wrapped at
the single setter, not at each link**, so no future call site can forget — use
`setActiveTab` and never the raw setter.

## Recovering an unreachable light (v3.14.0)
A Hue light wired to a wall switch reports `state.reachable: false` while the switch is
off. Flip it back and the **bridge** sees it immediately — but the app only learns by
asking again, and nothing said so, which read as "you must reload the page".
- **Nothing was broken.** `/api/hue/lights` is a live bridge query with no caching, and
  `loadAll()` calls it on **every** run (not just the first), so the header's ↻ already
  recovered a returning light. The gap was purely discoverability: ↻ is an unlabelled
  global icon, while Govee had an explicit **Re-scan** button. Don't "fix" this by adding
  caching or a bridge-side rescan — there is nothing to discover, the bridge already
  knows every paired light.
- **The OFFLINE badge on a LightCard IS the recheck control** (`onRecheck`). That puts the
  fix where the problem is visible rather than in Settings — the same idiom as
  click-the-name-to-rename. It falls back to a plain label when no handler is passed.
- `onRecheck` is dispatched by device type in app.js (`recheckDevice`): Hue re-queries the
  bridge (`rescanHue` — `/hue/lights` + `/hue/groups`, one round-trip, far cheaper than a
  full `loadAll`), Govee re-runs the LAN scan (`rescanGovee`). **A new LightCard render
  site should pass `onRecheck`**, or its offline devices become dead ends.
- Settings → Hue Bridge has a **Re-scan** button mirroring Govee's, and the list header
  reads "N of M reachable" with an unreachable count, so the state is visible there too.

## light-card.js — rename by clicking the name (v3.10.0)
The card **title itself is the rename control** — click it (a faint ✎ sits beside it) and
it becomes an inline input; Enter or blur saves, Escape abandons, and an `×` clears the
nickname back to the device's real name. `onFocus` **selects the whole name** so typing
replaces it (the rename-a-file behavior); without that the caret lands at the end and
you silently append to the old name. `saveEdit` skips the POST when the value is
unchanged, because blur fires on every dismissal.
- **Why it moved:** renaming used to live *only* inside the collapsed
  "Hue details / Govee details" disclosure. That label promises model/IP/MAC, so nobody
  looked there and it felt like Settings was the only place to rename. The disclosure is
  now metadata-only — **don't put naming back into it.** Settings
  (`SettingsDeviceRow`) keeps its Rename button; both hit the same `POST /api/nicknames`.
- This matches room rename in `room-assignment.js`, so the app has one rule: **click the
  name (or its pencil) to rename it.**

## favorite-lights.js — the pinned Favorites section (v3.33.0, promoted v3.35.0)
Star a light and it's pinned to the top of the app, on screen before any scrolling
happens. Config key `favorite_lights` (an ORDERED list of device keys — array order is
render order, so starring appends and nothing sorts it).
- **It is APP CHROME, not page content (v3.35.0).** It renders between the Live bar and
  `<main>`, so it's on **every** tab. It shipped inside the Rooms and All Lights tabs,
  which made it a sub-section of a page and meant it vanished the moment you went
  anywhere else — while its entire reason to exist is being the shortest path to a few
  specific lights. Same argument as the Live bar: a control you reach for constantly has
  to be reachable from where you already are. `FavoriteBand` gives it a full-bleed band
  (matching the Live bar's border) with the card constrained to `<main>`'s 1200px column,
  so it still lines up with the page below.
- **Each row reports scene progress** via `useSceneProgress` — a scene on the hexa runs
  13+ seconds, and this strip is where that light is actually reached, so a silent row
  would look inert mid-change.
- **The problem is distance, not discoverability.** With 26 devices, All Lights renders
  13 Hue cards then 13 Govee ones — single-column on a phone — so the three accent
  lights someone uses nightly sit past twenty they don't. The Rooms tab buries the same
  three inside a twelve-light room. Neither is fixable by tuning; the lights have to move.
- **Rows are compact and carry NO slider** — name + room + power toggle. Six favorites
  still fit above the fold, and there's no drag surface to brush past (see the
  `useThrottledControl` note above for why that matters on this exact list). Tapping the
  name expands the full card underneath.
- **The expanded card comes from `renderLightCard` in app.js** — the same function All
  Lights maps over. That's deliberate: the Govee segment context (`segmentColors`,
  `controlMode`, `segmentFillMode`, …) is a long prop list, and a hand-copied second one
  would fall behind and quietly give the hexa whole-light brightness. **New LightCard
  props go in `renderLightCard`, not at a call site.**
- **`All on` / `All off` over the strip is the point of it being a group**, not just a
  shortcut list: "turn on the hexa, globe and rope" is one press.
- **Deliberately a FLAT list, not named groups.** Starring needs nothing named or
  managed, and in practice the list *is* the group ("the lights I reach for"). Named
  groups stay a clean superset if several sets are ever wanted. Note `fixtures` was
  considered and rejected for this: fixture membership feeds scene adjacency (mates are
  forced distinct and borrow each other's spatial edges), so overloading it would
  silently change how every room scene colors those lights.
- The empty-state hint renders **only on All Lights** (`showEmptyHint`), because that's
  the one tab where the star it names is actually visible — on Rooms it's inside a
  collapsed room drawer. An unresolvable key renders a muted row with an **Unpin**
  button rather than vanishing.

## color-mode.js — the room color tool (most complex file)
Assigns colors/temperatures across a room's devices and applies them.
- **Deterministic assignment:** all assignment randomness goes through
  ``seededRng(`${roomName}|<mode>|${shuffleSeed}`)``, never `Math.random`. This keeps
  the same layout across sessions (phone vs PC). `shuffleSeed` is persisted; the
  Shuffle button bumps it.
- **Color vs White space:** `colorSpace` is `"color"` or `"white"`. White mode emits
  entries with a `kelvin` field; whole-device/Hue apply sends real CT, segments send
  the K→RGB approximation (calibrated server-side via `ct_rgb`).
- **Segments vs whole is PER DEVICE (v3.18.0)** — `addressModeFor(key)` reads the
  `sceneAddress` prop (config `govee_scene_address`, backed by
  `POST /api/govee/scene-address`), and the **scheduler reads the same map**, so a
  scheduled palette paints the room the way Apply does. It was one toggle per room until
  now, which meant a rope light you wanted as one color forced the hexa panels to match.
  Devices with >1 segment get a row each in the panel, plus a "set all" shortcut.
  - `segCountFor(light)` must mirror the backend's `gv_segment_count` (configured count
    beats the SKU maximum). Diverge and a schedule addresses a different segment count.
  - This is NOT the light card's `device_modes` (which controls are shown) and NOT
    lightning's `govee_segment_mode`. Applying a scene used to bulk-write `device_modes`
    from the room toggle; that side effect is gone.
  - Setting a device to "whole" is the deliberate way to give a strip a single color,
    instead of relying on the arithmetic that used to produce it by accident.
- **A segmented device is colored AS A STRIP — `splitStrips` + `assignStrips` (v3.21.0).**
  Every segment of one device is held OUT of the room's positional walk / adjacency graph
  and cycles on its own `segIndex`: ABABABA for two colors, ABCABCA for three, whatever
  else is near it in the room. Applies to the **discrete-color modes only** — palette,
  custom, teams/ncaa/flags. **Gradient, Tonal and Beacon are deliberately untouched**:
  they're spatial by design, and a gradient sweeping across a laid-out hexa row must
  follow position.
  - **Why:** segments were just more entries in the shared walk, so any other light in the
    same row band stole a column index and flipped the parity mid-run. A Triple Lamp at
    y=7 sitting between hexa panels at y=8 turned ABABABA into **ABBABAB** — two adjacent
    panels the same color, halfway along a 7-panel run. The linear branch had the same
    flaw via x-interleaving. This also subsumes the older "synthetic strips" carve-out:
    laid-out and un-laid-out segments are now treated identically.
  - **The trade:** a strip's cycle wins over harmony with its neighbours, so a panel can
    match the lamp beside it. For a run that reads as one object that's right, but it is a
    change of priority — don't "fix" it by folding strips back into the graph.
  - Per-device seeded phase, so Shuffle still re-rolls which color a strip opens on and
    two strips in a room don't lock-step.
  - **FLOOR PLANS ONLY (v3.48.2) — a LINE is one walk, end to end.** v3.21.0 applied the
    split to lines too, reasoning that "a lamp interleaved by x shifts everything after
    it". On a line that shift is exactly right — position IS the order — and splitting
    produced the one thing a line must never show: neighbors the same color wherever a
    strip met a loose light. Reported on Exterior Front with the LA Rams (two colors):
    Lampost blue → Outdoor A blue, Outdoor D gold → Garage gold. Every strip alternated
    within itself and the loose lights alternated among themselves; nothing alternated
    across the seam. `lineOrder(placed, devices)` now orders every whole device AND
    every segment by its own position (a synthetic segment collapses to its parent's
    spot, ties by device then segment) and Palette / My Colors / Teams / NCAA / Flags
    each walk that list once on a line. **It is the preview swatches' own sort, on
    purpose** — the order colors are dealt in and the order they're shown in must be one
    order, or the preview displays repeats the dealer never meant. Verified against the
    old code on the live data: Exterior Front went from 2 repeats (Rams) and 1 (France)
    to 0, and Living Room, a floor plan, rendered identically in all four modes.
- **Teams / NCAA / Flags modes** are preset-color modes backed by `palette-data.js`
  (`PRESET_TEAMS` NFL/NBA/MLB/NHL, `PRESET_NCAA` Power 5, `PRESET_FLAGS` ~195
  countries). A searchable `PresetPicker` selects one entity by name; its hex colors
  (true black filtered via `isNearBlack` — brightest-channel test, so dark-but-vivid
  colors like navy `#041E42` are kept) are assigned with the shared `cycleAssign`
  — the same positional cycle as Custom mode — and honor the shared `ShadeToggle`
  (`customShadeMode`: exact colors, or tonal shades per color). These modes are
  color-only: they ignore the Color/White space (the toggle is hidden via
  `isPresetMode`). Selection persists as `selected_team`/`selected_ncaa`/`selected_flag`.
  - **Colors can be left out (v3.48.0).** Reported: *"I can remove colors from a palette
    but I can't remove colors from a team or flag scene."* Palette removes by editing its
    own working copy; a preset's hex list is fixed data, so here removal is an
    **exclusion** — `presetExcluded = {kind: {name, idx}}`, indices into
    `presetColors()`. It is **keyed by the name it was made against** (`presetExclusion`),
    so an exclusion made on France can't leak onto Italy, and switching back to France
    finds it again. `keepPresetColors` never returns an empty set, and the picker disables
    the last remaining swatch — a scene needs one color. The cycle's seed key ignores the
    exclusion on purpose, so dropping a color keeps the room's phase instead of
    re-rolling the layout.
  - **The UI is `RemovableSwatches`** (color-mode.js), which `PresetPicker` renders under
    the selected name when given `onToggleColor`: the Palette block's 32px swatch + corner
    × so the two read as one gesture. A left-out color stays on screen, faded and dashed
    (the lightshow's OFF style), because unlike a palette there's no + stepper to get it
    back; tapping it restores, and "Use all colors" resets. It's a standalone component
    because the per-light panel uses it for modes that have no `PresetPicker` at all.
  - Persisted as `preset_excluded` through the usual three places (snapshot in
    `applyColors`, `RoomColorStateRequest`, the `seededRoom` hydration). With that, every
    room-panel mode that holds a color LIST can drop one: Palette, My Colors, Teams, NCAA,
    Flags. Gradient, Tonal and Beacon are built from a single base color, so there is
    nothing to remove.
- **Custom mode assignment is a positional cycle, not an adjacency graph.**
  `computeCustom` sorts devices spatially (linear → left-to-right; floor plan →
  row-major) and colors them `A,B,C,A,B,C…` along that order, shifting each row by one
  so neighbors differ (clean `ABAB` instead of clumped `AABB`). **In a LINEAR layout the
  cycle starts on color 0 with no rotation (v2.19.7)** — the custom colors map in order
  to lights left-to-right (color 1 → leftmost light/segment), which is what people
  expect from a strip; Shuffle does not reorder a line. Floor plans still use a
  shuffle-seeded `offset` + per-row shift. "shades" mode advances a shade on each wrap. `buildAdjacency` is still
  used by Palette/Gradient/Beacon/CT-pool modes — don't delete it. **Segments now
  spatially constrain neighbors (v2.14.2):** the old relaxation skipped every spatial
  edge that touched a segment of a different device, so two side-by-side strips (and a
  strip next to a bulb) had *no* adjacency constraint and palette colors clumped. Now a
  segment constrains nearby segments of other devices and nearby whole lights; only
  same-parent segment pairs are still handled purely by the intra-device rule. A lone
  hexa close to other lights may over-constrain a small palette; the palette cost model
  (below) degrades gracefully rather than failing. Each custom seed
  slot can be Color (hue) or White (a `kelvin` temperature); `applyMinSat` must not
  saturation-clamp `kelvin` entries.
- **Curated palettes are VARIABLE length (4–8) — never pad to a fixed count (v3.13.0).**
  Every library palette used to be exactly 8 colors, so any theme with fewer real ideas
  was filled out with tints of colors already in it: "Watermelon" was 2 hues across 8
  slots (four reds, four greens), and an audit found near-duplicates in **152 of 160**
  palettes ("Fourth of July" listed `#f0f0f0` twice). Since the palette is a *pool* the
  room draws from, those tints surfaced as "one light is just a paler version of that
  other one". The library was re-cut with a **hue-family** test — not overall perceptual
  distance, which can't see the problem (a red and a lighter red have zero hue difference,
  so any hue-weighted metric scores them "far apart" on lightness alone). Two colors
  within ~15° of hue earn separate slots only with a real tonal gap (~0.15 lightness);
  near-neutrals are judged on lightness alone; floor of 4. Deliberately monochromatic
  themes (Cranberry, Noir, Snowfall) are legitimate — they're just shorter now.
  **When adding a palette, list only genuinely distinct colors.**
- **The library itself moved OUT of this file in v3.17.0.** `paletteLibrary` is now just
  `PALETTE_LIBRARY` from the generated `palette-library.js`, because the scheduler's
  random-palette action needs the same table on the Pi. Add palettes in
  `backend/palette_library.json` and re-run `python tools/build-palette-library.py` —
  editing the generated JS is silently undone by the next regeneration.
- **Picking a library palette adopts ITS length**, replacing both `paletteColors` and
  `paletteSource`. It used to keep whatever count was showing and pad the difference via
  `extendPalette` — whose first extension round is a *lighter tint* of an existing color,
  which would re-create exactly what the re-cut removed. The +/− stepper still grows a
  palette deliberately (and still generates tints when it runs out of real colors —
  that's the user asking for more slots, not the library deciding for them).
- **Palette is a shuffle pool, not a per-light list (v2.17.0):** do NOT trim the palette
  down to the light/segment count. `computePalette` already picks a distinct, room-sized
  subset from the full `paletteColors` and Shuffle (`shuffleSeed`) re-rolls which colors
  are used — so a 2-light room with an 8-color palette cycles through all 8 across
  shuffles. Trimming to slot count strands the rest of the palette and makes Shuffle
  repeat the same two colors — don't reintroduce it. The room only ever *shows* as many
  colors as it has lights; the extras stay in the pool. (Stepper/seeds keep their plain
  caps: palette ≤24, custom seeds ≤4.)
- **ONE continuous cost model decides every palette assignment (v3.37.0). Read this
  before touching adjacency.** `computePalette`'s floor-plan branch is a standard
  constraint solve — greedy seed (most-constrained entry first) → local-search swap pass
  → single-entry repair pass. The *search* was never the problem. The **cost model** was,
  and it had been patched three times without being made coherent, which is why
  "adjacency" kept coming back.
  - What was wrong: the three phases judged "conflict" three incompatible ways — a hard
    boolean gate with a relax-1/relax-2 ladder in the greedy pass, a binary 1-or-100 cost
    in the swap pass, and a *recolor only if some color violates nothing* rule in the
    repair. Worst of all, **an exact repeat and a merely-similar pair cost the same.** So
    on a 3-bulb fixture the optimizer was genuinely indifferent between
    `(crimson, crimson, yellow)` and `(orange, crimson, pink)`. A person is not.
  - Compounding it, the old `colorDist` **clamped** any pair within 0.15 hue of each other
    to `Math.min(0.13, …)` — below the 0.15 conflict gate — no matter how far apart their
    lightness was. On the reported palette (orange / pale gold / crimson / pink) that left
    only THREE legal adjacent pairs out of six, and those three contain no triangle: a
    valid 3-coloring of a 3-bulb fixture **did not exist**. The room wasn't unlucky, it
    was unsatisfiable, and the code had no way to say so.
  - What replaced it: one `conflict(ci, cj)` used by all three phases.
    `perceptualDist` is unclamped (`dh*2 + dl*0.9 + ds*0.35`, with a near-grey branch
    where hue is meaningless); the penalty is `0` at/above `COMFORT_DIST` (0.28) and rises
    smoothly to `DISTINCT_CAP` (0.8) as colors converge — while an **exact repeat always
    costs 1**. That gap is the invariant: *a repeat is worse than any two distinct
    colors.* It is what makes three colors across three bulbs win when the palette holds
    no perfect answer, which is the normal case. `pairCost` multiplies by
    `FIXTURE_VIOL_COST` (100) for fixture mates / segment siblings.
  - Consequences worth knowing: usage balance is now a **tie-break, not the outer loop**
    (balanced-but-ugly used to beat slightly-lopsided-but-clean); the greedy pass can
    never run out of candidates, so relax-1/relax-2 are gone; and the repair takes the
    least-bad color under a strict-improvement test, so it always makes progress and can
    never make a room worse. Net −54 lines.
  - **If you change any constant here, run `tools/preview/fixture-check.mjs`** — it
    sweeps palettes against the real room and fails if a fixture ever gets fewer distinct
    colors than it has bulbs. The reported palette scored 2-of-3 on 12/12 shuffles before
    this change and 3-of-3 on 12/12 after; typical library palettes (Cotton Candy, Pop
    Art, Frostbite, Autumn) passed both before and after, which is exactly why this class
    of bug kept slipping through hand-testing.
- **Palette on a LINEAR layout uses a positional cycle, NOT graph-coloring (v3.7.1):**
  `computePalette` branches on `isLinear`. Floor plans keep the graph-coloring + swap +
  repair path. But a compacted line seats entries ~1 unit apart, so the spatial adjacency
  graph (threshold 8) makes each node adjacent to ~7 others per side; with a small palette
  (e.g. the user drops to 3 colors via the stepper) that graph is uncolorable and the
  relax fallbacks emit *adjacent repeats* (the reported bug). The linear branch instead
  lays colors down as a repeating cycle `ABCABC…` along the left-to-right order (same
  proven approach as Custom/`cycleAssign`), which guarantees distinct neighbours whenever
  N≥2 → clean `ABAB` / `ABCABC` / `ABCDABCD`. `orderPaletteForCycle()` (module scope)
  first orders the palette so consecutive cycle positions are perceptually distinct — the
  "which color is A/B/C" decision — which matters at N≥4 (a no-op for N≤3). Shuffle still
  rotates the starting phase so short strips re-roll which colors appear. Don't route
  linear palette back through the graph-colorer.
- **Un-laid-out segments cycle too, even on a FLOOR PLAN (v3.8.1):** a segmented device
  whose individual segments were never dragged onto the map gets SYNTHETIC positions (a
  short horizontal spread at the device's spot in `placedColorLights`, flagged
  `synthetic: true`) purely so gradient/beacon vary. Those positions carry no real spatial
  info, so `computePalette` now holds them OUT of the graph-colorer (`buildAdjacency`/the
  forward pass run over `anchored` = non-synthetic only) and instead lays a per-device
  positional cycle (`ABCD…`, via `orderPaletteForCycle` + a phase seeded on
  `…|${parentKey}`) over each strip afterward. Before this, two un-laid-out strips dropped
  at the same corner (e.g. a globe at (14,1) + a rope at (14,2)) produced ~30 mutually-
  adjacent nodes a small palette couldn't color, so the relax fallback emitted an
  arbitrary assignment (the reported "odd adjacency" bug). Laid-out segments (real
  positions) stay anchored and graph-colored normally — their cross-device borders still
  matter. **Preview swatch order (v3.8.2):** each swatch sorts by its entry's OWN placed
  position (via `placedByKey`) so the list mirrors the physical run of lights — on a
  LINEAR strip that means laid-out segments interleave with whole devices exactly as they
  sit on the map (the true left-to-right order), and the cycle reads as a clean ABAB/ABCD
  with no false adjacencies. ONLY a **synthetic** segment (a segmented device never
  dragged out — its segments would otherwise share an x-coordinate and interleave
  meaninglessly) collapses to its parent's spot so that strip stays contiguous + in
  segIndex order. Ties break by device then segIndex. (v3.8.1 grouped EVERY segment by
  device, which was right for synthetic floor-plan strips but reordered laid-out linear
  strips and showed false adjacent repeats — don't go back to unconditional grouping.)
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

- **Tonal and the White modes fall back to the LEAST BAD shade (v3.51.1).** Both assign
  most-constrained-first and prefer a shade ≥2 steps from every assigned neighbor; when
  nothing satisfied that, they took the first SHUFFLED shade — which could hand a segment
  the very shade its neighbor already had. On a strip every segment neighbors every
  other, so any run longer than the number of gap-respecting shades ends up there: the
  same neighbor-repeat class as the v3.48.2 line bug, in the two modes that fix never
  touched. `furthestShade` takes the index furthest from every assigned neighbor, ties
  broken by the existing shuffle so Shuffle still re-rolls the arrangement. It cannot
  give eight distinct shades to ten lights; it does stop repeating while a shade is free.

## light-scene.js — scenes for ONE segmented light (v3.34.0)
`LightScenePanel` renders inside a LightCard's Segments section (any Govee device with
>1 segment) and offers Rainbow / Palette / My colors / Shades / Beacon / One color /
Teams / College / Flags / Last colors across that device's segments.
- **Why it's not ColorMode with a filter.** A room is a 2D arrangement needing an
  adjacency graph, fixtures, a vendor filter and a spatial walk; one strip is a **1D run
  where segment index IS position**. That makes Shades and Beacon meaningful here (the
  direction is *along* the run — forward / reverse / middle-out / ends-in) at a fraction
  of the machinery. Threading a `restrictToKey` through color-mode.js's ~2800 lines and
  hiding half its UI would have been worse in both directions.
- **The backend needed almost nothing.** `/api/scenes/room-apply` already takes a fully-
  resolved device payload; `room` was only ever a label and a task key. The panel builds
  the same plan shape for one device and adds `scope` — see the backend note for what
  that keys. **Nothing is recorded to "Now showing"**: one hexa going rainbow does not
  make the room rainbow.
- **Reuses the pure helpers from color-mode.js** (`orderPaletteForCycle`,
  `presetColors`, `PresetPicker`) rather than copying them, which is why it must load
  after it. **`orderPaletteForCycle` returns INDICES, not colors** — treating the
  return as colors renders every segment transparent, and that shipped-looking bug was
  caught only by screenshotting the preview.
- **Rainbow deliberately skips that re-ordering** (`preserveOrder`). The function
  maximises contrast between adjacent positions, which is right for a palette and wrong
  here: it turns ROYGBIV into R,G,V,Y,B,O,I — seven nice colors that aren't a rainbow.
  For Rainbow the *sequence* is the look.
- **`ROYGBIV` is LED-tuned, not textbook.** Pigment indigo (#4B0082) and violet
  (#9400D3) are ~7° apart in hue and both dark, so on a panel they read as two dim
  purples and one band looks nearly off. The constant keeps the seven named bands but
  spreads them across the hue circle at full saturation.
- **The cost is stated in the UI, on purpose.** Segments go over Govee's **cloud** V2
  API (every segmented SKU in `GOVEE_SEGMENT_INFO` is `cloud_v2`), rate-limited to about
  one color change every 1.8s. Colors are batched — each distinct color is one call —
  but a 7-color rainbow on 7 panels is the worst case for batching and genuinely takes
  ~13s. **Don't remove the estimate**; a user who isn't told assumes it hung. The LAN
  razer protocol would be instant and is deliberately not used (it reverts after 60s
  without keepalives).
- **Every list mode can leave colors out (v3.48.1)** — Rainbow, Palette, My colors,
  Teams, College, Flags — with the same `RemovableSwatches` row and the same
  `presetExclusion` / `keepPresetColors` helpers as the room panel, so there is one
  rule, not two. `listSource` is the single place a mode says which list it draws from
  and what that list is called; the exclusion is `{[mode]: {name, idx}}` keyed by that
  name — the palette's name, the team's, and for My colors a **fingerprint of the saved
  colors**, so editing favorites can't point stale indices at different colors. Rainbow
  keeps its sequence with a band left out (`preserveOrder` still applies). Unlike the
  room panel nothing here persists, matching the rest of this panel's choices — the
  applied look is what's remembered. One color, Shades and Beacon are built from one
  base color and Last colors replays what's stored, so none of them has a row.
- "Last colors" re-sends the stored `segment_state`, which survives restarts — the
  useful case being a device that was power-cycled, clearing its segments while the hub
  still remembers them.
- **Brightness dims LIVE; it is not a scene parameter (v3.35.2).** It used to only take
  effect on the next Apply, so nudging the level re-ran the whole 13-second
  segment-by-segment scene — the Pi's log from the first real rainbow test shows exactly
  that, a second `room-apply` and another seven cloud calls. It now posts
  `/govee/segments-brightness`, which is ONE whole-device LAN command that leaves the
  per-segment colors alone. The value still rides along on the next Apply. Beacon is the
  one mode where it also shapes the falloff, and that's still baked in at apply time —
  the live dim is a master level on top, so both remain true. The slider seeds from
  `segmentBrightness`, because a control that dims live must not misreport the level.
- **The segment-state re-read is keyed to the DONE event, never a timer.** It was
  `setTimeout(onApplied, (etaSec + 1) * 1000)` and it lost the race by about a second:
  the log shows the seven segment calls at `:29 :31 :33 :35 :37 :39 :41` and the re-read
  at `:40`, so the card's strip captured six of seven and drew the last segment as "not
  set" while the light itself was correct. The backend emits `done` only after every
  call has completed and persisted. **Don't replace this with the run's `config` event
  either** — that one carries the applying client's id, and a client ignores its own
  echoes, so the session that pressed Apply would never refresh.
- **Status is reported in THREE places, deliberately (v3.35.0):** the panel footer (bar +
  the backend's live label + countdown, replacing the Apply button), the **light card's
  own header** ("Applying scene" + a compact bar), and the **favorites row**. The room
  equivalent has always had this — the room header strip says "Applying…" whether or not
  the Scenes panel is open — and the per-light version originally had progress only at
  the bottom of an open panel, on a card tall enough that it's off-screen on a phone. For
  a 13-second operation that reads as no feedback at all. All three go through
  `useSceneProgress`, so there is one listener implementation, not three.

## schedules.js — Schedules tab + Settings Location card (v3.8.0)
`SchedulesTab` (its own nav tab) lists schedules with a human trigger summary, a
next-run hint, an enable toggle, edit, and a two-step delete; `ScheduleEditor` is the
add/edit form; `LocationCard` renders in Settings.
- **Scene actions are captured, never authored here.** All the scene math lives in
  `color-mode.js` in the browser, so a scene schedule stores the resolved apply plan.
  The editor shows a captured scene read-only ("build it again in that room's Scenes
  panel and capture it") and **locks the room select** — the plan is device-specific.
  White and Color actions ARE authored here (presets / `ColorPicker` + brightness).
- **`buildScenePlan()` in color-mode.js is the single source of the apply plan.**
  `applyColors` POSTs it and "⏰ Schedule this look" snapshots it — extracted from
  `applyColors` precisely so the two can't drift. It stamps **`mac` on every Govee
  entry** (`base_seeds`/`govee_whole`/`razer`; `cloud` already had `device_mac`) so the
  backend can re-resolve DHCP IPs at fire time. **Anything you add to the plan must be
  added inside `buildScenePlan`, not in `applyColors`.**
- **Handoff:** the button calls `onScheduleLook(plan)` → `room-section` adds the room
  name → app's `handleScheduleLook` stashes `pendingScheduleScene` and switches to the
  Schedules tab; a `SchedulesTab` effect opens the editor pre-filled and calls
  `onConsumePending()` so revisiting the tab doesn't reopen it.
- **Palette actions ARE authored here — they're recipes, not snapshots (v3.17.0).**
  `PaletteActionEditor` builds `{type:"palette", source:"category"|"list", category,
  palettes[], brightness, segments}`; the Pi picks one candidate and assigns it to the
  room's lights *when it fires*, so the same schedule looks different each night. This is
  the opposite of a scene action, and both belong: a scene is exact and frozen, a palette
  is varied and survives room edits.
  - **The preview is the feature, not decoration.** You will never watch this schedule
    fire, so every surface shows the actual colors: the editor grids the whole candidate
    set as `PaletteCard`s, chosen palettes appear as removable chips **that stay visible
    while you browse other categories** (picks span categories; the grid shows one), and
    each saved row gets a `PaletteCandidatePeek` — up to four color bars plus "+N".
  - **No segments checkbox here (removed v3.18.0).** Whether a Govee device is painted per
    segment is a property of the device, set in that room's Scenes panel and shared with
    the backend — a switch on the schedule could only disagree with the room.
  - **`paletteCandidates()` must mirror the backend's `palettes.resolve_candidates()`.**
    If they drift, the editor previews a set the Pi won't draw from. Same for the two
    virtual categories, `Featured` and `All` — the backend understands both.
  - `actionSummary` refuses to overstate: one candidate reads "always <name>" (it isn't
    random), and a list whose palettes no longer exist says so rather than "0 palettes".
  - **"Try one now"** (`POST /api/palettes/apply`) resolves and applies through the exact
    path the scheduler uses, so what you see is what will run. It drives real lights —
    the button says so.
- **`palette-library.js` is GENERATED — never hand-edit it.** Source of truth is
  `backend/palette_library.json`; regenerate with `python tools/build-palette-library.py`
  and commit both. It defines `PALETTE_LIBRARY` (160 palettes, variable 4–8 colors) and
  `PALETTE_CATEGORIES`, and must load **before** `color-mode.js` and `schedules.js`.
- **Switching action type REBUILDS the action, it doesn't merge (v3.19.1).**
  `setActionType(type, override)` keeps the target and takes that type's own fields from
  `ACTION_DEFAULTS`, so a saved `power` action can't carry a stray `kelvin` (noise in
  config.json and in a backup, and it reads as though power sets a color). What you'd
  entered for the type you're leaving is remembered in `typeMemory` — **component state,
  not the action** — so White(6500K) → Color → White still restores 6500K without 6500K
  ever being stored inside a color or power action. **Use `setActionType` for type
  changes and `patchAction` only for fields within the current type.**
- **The action picker is grouped by OUTCOME, not by action type (v3.19.0):**
  "Turn on and set" → White / Color / Palette, then "Or just" → Turn off / Turn on, last
  used look. "On/Off" was never a peer of the look actions — `_apply_room_white` and
  `_apply_room_color` already send `on=true` with the color, so nobody schedules "on"
  and then separately schedules a look. Only OFF is a distinct outcome, and it now takes
  one click instead of two (pick On/Off, then pick Turn off). `{type:"power", on:true}`
  survives as "Turn on, last used look" because it IS distinct: it sends only `{on:true}`,
  each light returns to what it remembers, and nothing is recorded to compare against
  later. **Storage is unchanged** — this is labelling and grouping only.
- **Sun offset is a direction BUTTON plus a non-negative magnitude (v3.18.1)**, stored as
  one signed `offset_min` (negative = before). It used to be a single signed number field
  and was unusable: it prefilled `0` that couldn't be cleared (`Number("")` is `0`, so the
  zero came straight back), typing into the prefilled zero left `010`, and the minus sign
  was **unenterable** — a controlled numeric input can't hold the intermediate `"-"`
  because `Number("-")` is `NaN`. `offsetDir` is its own state rather than derived from
  the sign, so choosing "Before" at 0 minutes doesn't snap back (`-0 < 0` is false).
- **Any controlled number input needs a `draft` string.** Bind `value={draft ?? String(n)}`,
  set `draft` from the raw text on every change, commit only when it parses, and clear
  `draft` on blur (which also normalizes `010` → `10`). Binding a number straight to
  `value` makes the field unclearable. `RgbSliderInput` in `components-shared.js` is the
  reference implementation.
- **Day numbering is 0=Monday** (Python's `weekday()`), NOT JS `getDay()`'s 0=Sunday.
  `nextRunLabel` converts with `(getDay() + 6) % 7`. Get this wrong and every weekly
  schedule is off by a day.
- **Saving is NOT fire-and-forget** (the one deliberate exception to the optimistic-UI
  rule): the backend mints the id and owns the list, so `saveSchedule` awaits the
  response and takes `res.schedule`. A schedule that silently failed to save is worse
  than a slow save — it just never fires, with nothing on screen to say so.
- **Location card: four ways in, all offline (v3.10.0).** "Type your latitude" is an
  expert-only ask, so `LocationCard` has a method switcher: **Use my location**
  (`navigator.geolocation`), **US ZIP code**, **Nearest city**, and **Google Maps** (link +
  the right-click-to-copy steps, with a paste box that parses `41.878, -87.629`). All four
  converge on the same `onChange(lat,lng)` → `POST /api/location`, and a banner at the top
  states whether location is set at all. **No geocoding API is used** — ZIP and city resolve
  against `location-data.js`, so it works with no internet and no key. Free-form address
  autocomplete was considered and **deliberately dropped**: it requires a paid API.
- **`location-data.js` is GENERATED — never hand-edit it.** Regenerate with
  `python tools/build-location-data.py` (which sanity-checks bounds + spot-checks known
  prefixes and exits non-zero rather than shipping a bad table). It holds `ZIP3_COORDS`
  (US ZIP **3-digit prefix** → [lat,lng], from the public-domain US Census ZCTA gazetteer)
  and `WORLD_CITIES` (`[country, city, lat, lng]`). The ZIP table is deliberately prefix-
  level: ~900 entries/~20KB instead of ~600KB for all 33k ZCTAs, and a prefix centroid is
  ~25–50 km out, which moves sunrise/sunset by only a couple of minutes. It must load
  **before** `schedules.js` in index.html.
- Sun triggers can't be predicted client-side (no astral in the browser), so the list
  shows "At sunset" rather than a guessed clock time, and a banner points at
  Settings → Location when a sun schedule exists with no location set.
- **Zones + Room/Zone target + Power action (v3.9.0):** the tab has a collapsible
  **`ZoneManager`** (create/edit-membership/delete zones — a zone is a named group of
  rooms). The editor gained a **Room / Zone** target toggle: a **zone** target binds
  `action.zone` (clears `action.room`) and limits actions to **White / Color / Power**
  (a captured *scene* is device-specific → room-only, so the toggle is hidden for scenes).
  New **Power** action (`{type:"power", on}`) with On/Off. `setTargetKind` rebuilds the
  action to add/remove the right `room`/`zone` key (patchAction only merges). `saveZone` /
  `deleteZone` / `renameRoom` live in `app.js` and take the backend response as truth
  (like `saveSchedule`). **The rename UI is a pencil on each Assign-Rooms `RoomCard`** →
  `onRenameRoom` → `POST /api/rooms/rename`; it is NOT gated on `isDefault` (the seed room
  "Outside" is default yet must be renamable — the backend migrates every reference).

## "Which lights move" (lightshow.js, v3.53.0)
The device list used to read "Leave lights out", which is the wrong way round for
the thing people actually want: one hexa or rope light drifting while the rest of
the room holds a scene. Same `exclude` storage, re-framed —

- the header counts what MOVES (`N of M`), not what is left out;
- each row has an **"Only this"** chip (`onlyDevice` — excludes every other key),
  because the alternative was a dozen taps in a big room. It is hidden once one
  light is selected, where it would be a no-op;
- the copy states the consequence: the other lights **keep whatever they're
  showing**. That is the whole mental model, and it was nowhere on screen before;
- **"Animate all"** clears the list again.

Pair this with `source: "current"` and it survives re-applying the room's scene —
see `backend/CLAUDE.md`.

## Animating the look a room already has (v3.52.0)
The panel used to open asking which palette to run, and that was the wrong
question. Starting a show almost always means "the scene I set earlier should
move now" — so being asked for a palette meant rebuilding, from memory, a look
that was already on the walls.

Two entry points, one mechanism:
- **`lightshow.js`: a `current` color source, labelled "What's on now" and listed
  FIRST** — it is also `LIGHTSHOW_DEFAULTS["source"]`, so a room that has never
  had a show opens on itself. The colors come from the backend
  (`_room_current_colors`), not from anything the browser re-derives, and arrive
  in the status as `palette_colors` like any other source. `ready` is false when
  the room has nothing animatable on, and the panel says which case it is.
- **`color-mode.js`: "Apply & animate"** (just "Animate" on mobile), a secondary
  button beside Apply in the lightshow's purple. It posts the SAME plan with
  `animate: "auto"` — it does not start a show itself. The backend starts one on
  `source: "current"` once the apply completes, so the show animates the scene
  that just landed and a canceled apply animates nothing.

**The button names the pattern it will use (v3.53.1).** It takes its own line
(`flex: "1 1 100%"`) with a `<select>` of the room's legal patterns beside it and
that pattern's blurb underneath, and posts the key shown rather than `"auto"`.
Saying only "animate" and silently inheriting the room's stored pattern produced a
real bug report: a two-color look plus a stored Accent gave a room of one color
with a single dot moving, which is Accent working correctly and reads as broken.
When a roles pattern (Accent / Comet / Sweep) meets a look with fewer than three
distinct colors, it says so — one of them becomes the background. The count comes
from the resolved `preview`, so it is what will really be sent.
`ColorMode` needs `lightshow` + `lightshowPatterns` from `RoomSection` for this.

**Don't add a second way to carry the colors across.** The temptation is to have
the Scenes panel POST its palette straight to `/api/lightshow`; that creates a
look that agrees with the room by coincidence and drifts the moment either side
changes. The room record is the one source — see `backend/CLAUDE.md`.

`applyColors(animate)` takes an argument now, so the plain Apply button must call
it as `onClick={() => applyColors()}`. Wiring `onClick={applyColors}` passes the
click EVENT as `animate`, which is truthy — every Apply would start a lightshow.

## lightshow.js — a room's ambient lightshow (v3.39.0)
`LightshowPanel` is a room surface (its own opener in the room header + a tab in the
control drawer). **The show runs on the Pi**; this panel only edits a config object and
reads a status back — which is the point: set a room walking, close the browser, it keeps
walking. Live state (step, palette, countdown) comes from `GET /api/lightshow`, refreshed
by the `lightshow` SSE event the backend emits at the end of every frame.
- **The `lightshow` SSE event does a LIGHTS-ONLY refresh, never `loadAll()`.**
  `refreshLightshows` in app.js pulls `/lightshow` + `/discover/govee/cached` +
  `/govee/segment-state` (+ `/hue/lights`) and skips `/hue/phantoms`, `/devices/stale` and
  `/rooms/status` — all bridge or sweep work. A running show fires this event forever, so
  a full reload here would tax every open browser twice a minute indefinitely.
- **Speed is stated, not hidden.** The panel prints what a step costs on THIS room ("about
  12.6s to paint here") and the floor that follows from it, so an interval you can't have
  is explained rather than silently ignored. Same principle as `light-scene.js`'s apply
  estimate — **don't remove it**; a user who isn't told assumes it hung.
- **The pattern list is the Pi's, filtered by the room's layout (v3.40.0).** `show.geometry`
  and `show.patterns` come from the backend; the panel renders that set and never widens it,
  or it would offer something POST rejects. A short list has to read as deliberate, so the
  panel always says WHY ("Laid out as a line, so patterns run along the strip…"), and a room
  with no layout gets a note pointing at Room Map naming what it would unlock. Walk and
  Alternate carry a second `plan_blurb` because they genuinely read differently in 2D — a
  sliding cycle along a strip vs. marching stripes across a room.
- **`axis` chips are labelled per pattern** (`LIGHTSHOW_AXES`): for Walk/Sweep it's the
  direction of travel ("left → right"), for Alternate it's the shape of the grouping
  ("checkerboard"). One stored key, honest names. `LIGHTSHOW_AXIS_DEFAULT` mirrors the Pi's
  `default_axis` so the highlighted chip is the one actually in effect — the value is
  deliberately absent from config until you pick one.
- **The interval slider steps through `LIGHTSHOW_INTERVALS`, it isn't linear.** 10s–1h on a
  linear range makes one pixel worth twelve seconds at the top, and capping at 300s can't
  express "change it every half hour" — which is a normal ask for something this ambient.
  Indexing a named scale gives fine control where it matters and reach where it doesn't;
  `humanInterval` renders 30s / 5m / 1h everywhere a duration appears. **Timing sits
  directly under Pattern**, not at the bottom: how often it moves is half of what a
  lightshow is.
- **The pattern catalog comes from the backend**, so a name or blurb can't drift from the
  math. Per-pattern options are rendered from each pattern's `opts` — a "Rest brightness"
  slider under Walk, which never reads it, is worse than no slider.
- **The backend's response is the source of truth after a save.** `saveLightshow` takes
  `res.show` rather than patching local state optimistically (the deliberate exception the
  same as `saveSchedule`): cell count, step cost and the effective interval are all
  *derived*, and a guess at them is exactly the number the panel exists to report.
- **Saves MERGE, and the panel shows what it saved before the server answers
  (v3.51.1).** Two edits in quick succession used to lose one: the sliders shared a
  single debounce timer, so the second cancelled the first's pending save, and each
  multi-select list rebuilt itself from the value the SERVER last confirmed, so a second
  tap made before the round trip returned overwrote the first. `save(patch)` keeps an
  `overlay` of everything saved but not yet confirmed, merged over `show`, and clears it
  once nothing is in flight — so the derived numbers still come from the Pi. `saveSoon`
  accumulates its patch rather than replacing it. **Every control in this panel goes
  through `save`, never `onSave` directly.**
- Reuses `PaletteStrip` / `PALETTE_FILTERS` / `palettesFor` from **schedules.js**, which is
  why it must load after it. Bulk "Add all shown" / "Remove shown" mirror the scheduler's
  palette editor — "Summer and Winter" and "Summer minus three" should not be different
  kinds of work.
- **A running show is announced in the room HEADER** ("✨ Show running"), not only inside
  the panel — it's a state of the room, like a storm.

### Polish pass (v3.42.0) — three things the first cut got wrong
- **ONE palette is the normal case.** The panel shipped multi-select-first, which put the
  rare intent (draw a different palette at random each run) in front of the common one
  (pick a look, run a pattern on it). Selecting is now single-select and replaces; multi is
  opt-in behind "Draw from several palettes instead", and is implied for **Palette hop**,
  where drawing from a set IS the pattern. Bulk add/remove only renders in multi mode — in
  single mode it could only break the selection. **The chosen palette is pinned above the
  list**, because the list is filtered by category and browsing to "Featured" otherwise
  leaves nothing on screen looking selected.
- **The primary action is repeated at the BOTTOM.** The only Start button was above
  patterns, colors, timing, roles and lights, so on a phone committing meant scrolling all
  the way back. It's `position: sticky; bottom: 0` **at the end of the panel** — note that
  placement matters: the same element near the TOP of the tall panel did not pin (verified
  by screenshot; the bar simply sat in flow). At the end it both pins while you scroll and
  is unmissable when you reach it.
- **Color roles** (`s.has_roles`) render `palette_colors` at their original index, labelling
  slot 0 BACKGROUND and the rest ACCENT, with excluded colors dimmed and dashed. Tap to
  promote to background, "remove" to drop it from the show, plus Shuffle/Reset. The three
  helpers (`promoteColor` / `toggleColor` / `shuffleOrder`) are pure and never narrow below
  two colors — one color is a solid room, not a lightshow. The role NAMES come from the
  catalog (`roles: ["background", "accent"]`), lowercase there and capitalized for display,
  so Comet says "comet" and Sweep says "band" rather than all three saying "accent".

## "Changed since" + the "Set here" button (v3.16.0)
Other controllers (Hue app, Govee app, Google Home routines) change these lights too, so
the strip's record can be stale. `RoomLastApplied` takes a `status` from
`GET /api/rooms/status` and renders **only three ways**:
- **diverged** — amber panel, the look's name **struck through** (it's what we *set*, not
  what's on), and a **`Set here`** button that re-applies it.
- **match** — the normal quiet "Now showing".
- **unknown / none** — also quiet. **Never render a "verified" tick**: the backend can
  prove divergence but not agreement, so there is nothing to certify. Adding a badge for
  "can't tell" was considered and dropped — every Govee-only room would wear it and it'd
  become noise.
- The CTA exists because divergence is nearly always a routine elsewhere forcing a plain
  color temperature, and what you want is your look back — one tap beats hunting for the
  scene. `reapplyRoom` in app.js waits ~3s for an async scene replay before `loadAll()`,
  or the status would still read diverged.
- **"Didn't take" is a SECOND failure wearing the same amber panel (v3.31.0), and
  conflating them sends you to the wrong place.** `status.reason === "not_applied"` means
  the backend proved our own command never landed on a Govee device (it read the device
  back — see `_govee_verify_repair`), not that something else changed the room. So the
  label reads **Didn't take**, the button reads **Try again**, and the tooltip says the
  command was lost rather than blaming a Google Home routine. Everything else about the
  panel is shared on purpose — it's still "the strip is lying, here's one tap to fix it".
  A room with BOTH a Hue divergence and a Govee miss stays "Changed since": the override
  is the bigger claim and the retry wouldn't explain it.

## Assigning lights from the Rooms tab (v3.26.0)
Creating a room in **Rooms** produced an empty card with every control inert and no way
forward — lights could only be put in it from the **Assign Rooms** tab, which you had to
already know about. The room now shows an empty state that says so and opens the *same*
`DevicePickerModal` in place; rooms that already have lights get a `+ Lights` opener in
the surface row, since adding one later hit the identical wall.
- **`DevicePickerModal` lives in `components-shared.js`**, not room-assignment.js. It's
  used by both tabs, and room-assignment.js loads AFTER room-section.js — reaching across
  would invert the script order index.html defines.
- **Its `useState` runs BEFORE the empty-list early return (v3.51.1).** React counts hooks
  per render, so when `devices` went empty while the modal was open — the last unassigned
  light claimed from another tab, or an SSE refresh landing — the early return skipped the
  hook, React threw "rendered fewer hooks than expected", and with no error boundary the
  page went blank. Any hook goes above every early return.
- **`assignDevicesToRoom` in app.js mirrors `addDevicesToRoom`** in room-assignment.js and
  goes through the same `handleRoomsChange`, so the two entry points can't drift on what
  "assigned" means. If you change one, change the other (or fold them together).
- Both affordances hide when nothing is unassigned — an empty picker is a dead end.

## room-section.js — the room header row (v3.25.0)
Name · light count · **Soft White · Cool White · brightness · power**, all on one line.
The white presets used to sit in a separate "Set room to" block two rows down, which put
the three things you reach for most often — warm it up, dim it, turn it off — in three
different places. The block's heading went with it: the buttons already say what they do,
and a header row can't afford a label per group.
- **`InlineBrightness`** is a compact slider that reuses `useThrottledControl` (~180ms), so
  dragging coalesces instead of firing per pixel. Floor is **1%, not 0** — it sits inches
  from the power toggle, and a slider that silently turns the room off while the toggle
  still reads "On" is two controls disagreeing about one fact.
- **The percentage is derived, not invented.** `roomBrightness` starts `null` and the
  displayed value is the average of the lights that are **on** (Hue 1–254 and Govee 0–100
  normalized first); it only becomes your own value once you drag. An all-off room falls
  back to 75. Don't reintroduce a hardcoded default as the *displayed* value — it made the
  slider claim 75% over a dim room.
- **Your value lets go again (v3.50.0).** Four seconds after the last drag, while the room
  is on, `roomBrightness` resets to `null` and the header shows what the lights report
  again. It used to hold the dragged value for the rest of the session, through
  schedules, scenes and other apps. A level set on a dark room stays until the room is
  on: it is waiting for the next power-on, and there is nothing to report yet.
- **At <640px the row can't hold everything**, so it wraps deliberately: the **power toggle
  stays on the name line** (the control you want in the dark) and the looks wrap below it
  as a unit. That's why `powerToggle` is built as a value and placed in two spots.

## room-section.js — "Now showing" strip (v3.12.0)
- **While a scene is applying, the strip says "Applying…" (v3.22.0).** A scene is recorded
  only when it FINISHES — deliberately, since a canceled apply left the room half-set —
  but a room with segmented Govee devices takes ~30s because the cloud_v2 segment calls
  are rate limited. For that whole window the strip used to keep advertising the PREVIOUS
  look, so applying a palette and glancing up showed "Soft White · 2700K" and read as a
  plain bug. `RoomSection` listens to the `lightemup-scene-apply` window event (app.js
  re-broadcasts the SSE stream) and tracks it per room — in RoomSection, not
  RoomLastApplied, so it survives the color panel being closed.
`RoomLastApplied` renders what the room was last set to — swatch dots + the look's name +
a relative time — directly under the room name. It sits **OUTSIDE the `collapsed` gate**
on purpose: rooms start collapsed, so a strip that only appeared when expanded would miss
the exact moment it's wanted (opening the app in a new session and asking "what's this room
set to?").
- Data is `lastApplied={roomLastApplied[roomName]}` from app.js, sourced from
  `config.room_last_applied` — **backend-recorded**, so it also reflects schedules that
  fired while nobody had the app open. See `backend/CLAUDE.md` "Now showing" for why this
  is separate from `savedColorState`/`room_color_state`.
- A **schedule**-sourced entry gets a `⏰ <schedule name>` badge; an in-app change gets no
  badge, because "you did this" is the boring default and doesn't need saying.
- White entries carry `kelvin` instead of swatches and the chip is rendered here via
  `kelvinToRGB`. Swatch dots use a fairly strong white rim — a navy/near-black team color
  is otherwise indistinguishable from the panel behind it.
- `describeLook()` in **color-mode.js** names the look and is returned as `label` from
  `buildScenePlan()` (so Apply and "Schedule this look" can't disagree). Mode display names
  live in `MODE_LOOK_NAMES` — never render the internal mode keys.
- **The white shortcuts go through the BACKEND now (v3.43.0).** `setRoomWhite` POSTs
  `/api/rooms/white` for a real room, which records "Now showing" itself — the old
  explicit `/api/rooms/last-applied` POST is gone along with the fan-out it existed
  to compensate for. "Unassigned" still fans out client-side (it is not a backend
  room), and **that** is why the rule survives: **any client-side whole-room fan-out
  must POST `/api/rooms/last-applied` itself, or the header keeps advertising the
  previous look.** Better still, do not add one — see `backend/CLAUDE.md`
  "Whole-room actions belong on the backend".

## delivery-health.js — Settings → Delivery health (v3.46.0)

A Settings card over `GET /api/health/delivery`. It answers one question — *are my
lights actually receiving what I send them?* — which until now could only be answered by
reading the log on the Pi. See `backend/CLAUDE.md` "Delivery health" for why the
underlying failure is invisible without it.

**It reports a rate, not a feed.** The big number is re-sends in the last 24 hours,
color-toned by threshold (≥10 red, ≥3 amber, else green) with a plain-English verdict
next to it. The thresholds are deliberately loose: the card is for spotting a *shape*,
not for adjudicating a single dropped packet.

**The Zigbee channel sits inside the card, not in a separate one.** The number and the
channel are only useful together — a climbing count almost always means a WiFi network
has moved onto the Zigbee channel — and two cards would let a reader see one without
the other.

**The 14-day chart is dense.** Zero-count days render as a flat stub rather than being
omitted, because a gap in a sparse chart reads as "no data" when it means "nothing went
wrong that day". Bar heights are normalized against the peak, floored at 2px.

The kinds it renders are `on` / `power` (wouldn't switch), `brightness` (wrong
level), `color` (wrong color), `white` (**fell back to white** — v3.46.1, a bulb
that left color mode entirely, which points at the bulb rather than the radio)
and `unreachable`. A kind with no word falls through as its raw key, so a new
backend kind degrades rather than breaking.

**`by_kind` is summed by PHRASE, not by key.** A Hue light that wouldn't switch (`on`)
and a Govee one that wouldn't (`power`) are the same fact to a reader and share a
phrase, so tallying the raw keys printed *"7 wouldn't switch · 1 wouldn't switch"*.
`kindWords` folds the counts by their rendered word first. Caught in a screenshot pass —
it is not visible in the code.

It loads **after `room-section.js`** and reuses that file's `relativeTime`. That
function used to treat only `Z` or a `+` offset as zone-bearing, so a negative offset
got a `Z` appended and became an invalid `Date`, rendering as an empty string.
Everything the backend writes is UTC (`_now_iso`), so nothing was broken in practice —
but the trap was one edit away from being sprung, and it is now a proper
`/(?:Z|[+-]\d{2}:?\d{2})$/` test.

## Usage log — `trackUse` (utils.js) and usage-log.js (v3.49.0)
Records which screens and actions each device uses so the interface can be arranged
around real use. See `backend/CLAUDE.md` "Usage log" for what is stored and why it is
kept out of config.

- **`trackUse("open", {s})` when a screen or panel is shown; `trackUse("act", {s, a,
  room, key, detail})` when something is actually done.** Current hooks:
  - tab changes (`setActiveTab`)
  - the room drawer's openers and tabs (`room:<view>`)
  - room power, level and color (`controlRoom`)
  - Soft and Cool White
  - every light command (`controlHueLight` / `controlGoveeDevice`, with
    `usageCmdKind`)
  - scene apply, and the per-light scene apply
  - favorites: all on/off, pinning, expanding a card
  - lightshow start, stop, edit and next step
  - lightning start and stop
  - schedule create, edit, toggle and delete, and opening the editor
  - zones, "All lights off", and "Set here"

  **When you add a new control a person uses, add a `trackUse` call** — an
  un-instrumented control reads as "never used" in the data the redesign relies on.
- **Repeats fold.** The same event within `USAGE_COALESCE_MS` (3 s) increments a
  count instead of queueing again, so a slider drag is one `brightness`, not forty
  throttled commits.
- **Batched and fire-and-forget.** The queue flushes every 15 s, and on
  `visibilitychange` hidden and `pagehide` with `keepalive`, since on a phone nearly
  every visit ends by switching away. It uses plain `fetch`, not `api()`, because it
  must never surface an error.
- **The device id uses `crypto.getRandomValues`, not `randomUUID`.** The Pi is
  served over plain `http://`, which is not a secure context, and `randomUUID` is
  undefined there. Blocked storage falls back to an id that lasts one page load.
- **`UsageLogCard`** (Settings, under Delivery health) lists every device with a name
  field. This browser is listed first, marked THIS DEVICE, even before it has sent
  anything. Each row also shows the browser, width, last use, visits and top
  actions. It reuses `relativeTime` from room-section.js, so it loads after it.
- **Surfaces are TAGGED, and every act records where it happened (v3.51.2).** A
  container carries `data-usage-surface` (and `data-usage-room` where it has one):
  `<main>` is `tab:<name>`, then the Live bar (`live`), Favorites (`favorites`), a
  room's header row (`room:header`), each drawer view (`room:<view>`, set in
  `ControlSurface`), the full-window map editor (`room:map-editor`), the per-light
  scene panel (`light-scene`) and the storm Stop bar (`storm-bar`). A capture-phase
  `pointerdown`/`keydown` listener in utils.js remembers the nearest tagged ancestor
  of the last touch, and `trackUse("act", …)` stamps it as `via` / `via_room`. The
  nearest tag wins, so a light card inside a drawer reads as that drawer. **A new
  surface people act on needs a `data-usage-surface`** — without one its acts are
  credited to whatever encloses it. This replaced threading a "where from" argument
  through every control: the same `controlHueLight` is called from Favorites, room
  drawers and All Lights, and couldn't tell them apart.
  - `usageTouchedWithin(s)` asks whether the last touch landed in `s` — for a change
    that also happens with nobody touching anything. Layout edits use it: a layout
    fitted to its contents when the editor opens isn't anyone editing.
  - Folding repeats now also compares `via`, `zone` and `detail`, so two lightshow
    edits keep both fields and two zones stay two events; a slider drag still folds.
  - A batch that fails with a network error or a 5xx goes back in the queue (capped
    at 200) instead of being dropped; a 4xx is not retried.
  - The device id falls back to the `leu_device` cookie the Pi sets, and
    `usageAdoptDeviceId` takes the id the server answers with. See
    `backend/CLAUDE.md` › Usage log for why.
  - Newly recorded: the map editor's open and layout edits; Assign Rooms' move,
    remove, rename, delete, add-devices and add-room; Lightning presets, settings
    and its Advanced section; the Scenes panel's vendor filter; min saturation; and
    opening the per-light scene panel.

## backup-restore.js — Settings → Backup & Restore (v3.11.0)
`BackupRestoreCard` renders in the Settings tab (below `LocationCard`), with
`onImported={() => loadAll()}` so a restore refreshes app state **without a page reload**.
- **Export must leave the Pi.** It uses a raw `fetch` (not the `api()` wrapper, which parses
  JSON) to pull the file as a **blob**, then triggers a download via an object URL + a
  synthetic `<a download>`. The filename comes from the server's `Content-Disposition`
  (it carries hostname + date). A backup written onto the Pi would die with the card it's
  meant to survive — don't change this to a server-side file.
- **Import always previews.** The file is read and `JSON.parse`d locally, POSTed with
  `dry_run: true`, and the response drives a current→incoming diff (`BackupDiffRow`, which
  tints a value amber only when it actually changes). Room *names* gained/removed are listed
  explicitly — that's the check that catches "wrong backup file" at a glance, which counts
  is too weak to do. Only then does the red **Replace all settings** button appear.
- A `SyntaxError` from `JSON.parse` is reported as "That file isn't valid JSON"; every other
  failure surfaces the backend's `detail` (schema too new, not a LightEmUp file, …) via
  `api()`'s error path. Drag-and-drop hits the same `loadFile` as the picker.
- **The diff rows come from the SERVER now (v3.30.0) — don't hand-list them again.** This
  file used to hard-code eleven `BackupDiffRow`s, and every setting added after v3.11.0 was
  missing from the preview (white calibration, location, favorites, segment counts, scene
  addressing). `preview.rows` is derived from the config keys themselves in `main.py`, so a
  new setting appears automatically; a row that reads badly is fixed by adding a label to
  `_SETTING_LABELS` there, **not** by adding JSX here. A key this build doesn't recognize
  renders with a `*` and a footnote rather than being dropped.
- **A version difference warns and gates, it doesn't block.** `versionMismatch` compares
  the envelope's `meta.app_version` with `preview.server_version`; when they differ an amber
  block offers "OK, continue" / "Cancel import" and `blockedOnVersion` disables the red
  button until acknowledged. **"OK" must not fire the import** — it only unlocks the button,
  so the destructive action still takes its own deliberate click. A bare `config.json` has
  no `app_version` and deliberately does NOT warn: "unknown vs 3.30.0" isn't a mismatch.
  `versionOk` resets on every new file, so accepting one backup never pre-approves the next.

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
- **Scene addressing lives here too (v3.20.0)**, on its own line, for Govee devices with
  more than one segment (`segmentCount`/`sceneAddressValue`/`onSceneAddressChange`). It is
  **the same stored value** the room's Scenes panel edits (`govee_scene_address`), not a
  separate "default" that a room could override — a device is in exactly one room, so a
  second level would be two names for one thing. Settings is where you set a light once
  while configuring devices; the Scenes panel is where you flip it while building a look.
  Both render `SceneAddressToggle` from `components-shared.js` **for that reason** — two
  hand-rolled copies drifting apart is precisely what made the scheduler and the scene
  tool disagree before v3.18.0.

### Scene fill — and why it's mirrored into the Scenes panel (v3.36.0)
`segment_fill_modes[deviceKey]` is `follow` | `solid` | `shades`, applied by
`applySegmentFillModes` as the LAST step of the preview pipeline in `color-mode.js` —
*after* the palette solver and the saturation clamp. `solid` overwrites every segment
with segment 0's color, so the solver's per-segment assignment is computed in full and
then thrown away. That's the design, but it produced a convincing bug report: a 15-globe
strand on `solid` renders as fifteen identical swatches that Shuffle never varies, and
the only control for it was on the device's own card in a different view.

So the control is mirrored onto the **"Scenes paint these"** rows, as a second line under
each device's Segments/Whole toggle:
- **One device list, not two.** That block already enumerates the room's segmented
  devices; a separate fill list beside it would be the same three names twice. It also
  sits ABOVE the preview, so the option is visible before the confusion happens.
- **Only rendered when that device is on `segments`** — fill is meaningless for a device
  scenes paint as one color.
- The row's caption states the *effect* on that device (`All 15 segments share one
  color …`), built from `SCENE_FILL_MODES[].effect(count, unit)`. `unit` is `panel` for
  the H6061 hexa and `segment` for everything else — same distinction `nameForKey` draws.
- **`SCENE_FILL_MODES` lives in `components-shared.js`** and is used by both this and the
  `LightCard` control, for the same anti-drift reason as `SceneAddressToggle` above.
- In the preview grid, a segment whose parent is NOT on `follow` gets an **amber** dashed
  outline instead of the white one, and a legend under the grid names the devices and
  points back at the block. Derive the rows from the PREVIEW's own `:segN` keys
  (`sceneFillRows`), not from config — that way a device set to "Whole light" correctly
  doesn't appear, without re-deriving the addressing rules.

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
  Don't revert dots to `getDeviceColor` here. **Exception (v3.1.2):** the COLLAPSED
  "Room Map" panel legend (the `!expanded` device roster, before opening the editor) uses
  a **neutral gray badge**, not `e.color` — there are no dots to match there, so a colored
  badge just read as "this light is set to red/green." Colors stay in the full editor only.
- **Numbering/coloring is FROZEN at open (v3.0.3)** — number and color derive from the
  index into `numberOrder`, a snapshot of the legend-key order captured when the editor
  opens (the `[expanded, layout?.mode]` effect sets it from `spatialOrderRef`). So a
  line reads 1..N left→right **on open**, and then dragging/reordering a dot does NOT
  renumber it — the frozen number sticks to the device key; devices added while open get
  appended numbers; closing + reopening re-freezes fresh. Before the first freeze, render
  falls back to the live spatial order (a line sorts by x; a floor plan uses device
  insertion order). Earlier (v2.19.2) a line re-sorted by x every render, so numbers
  shuffled live as you dragged — confusing; don't reintroduce that. Do NOT sort the
  legend by position for numbering — sort it by `num` (which is the frozen order).
- **Drag snapping honors the cell-center offset (v2.19.5).** Floor-plan devices render
  at cell *centers* — `displayPos = {x: gridX+0.5, y: gridY+0.5}`, i.e. `(cell+0.5)*gridSize`,
  which is where the grid nodes are. So the drag stores `round(svgP/gridSize - 0.5)` (the
  cell whose center is under the cursor) and displays at `cell+0.5` (same units as `pos`);
  storing plain `round(svgP/gridSize)` put the dot half a cell off and made it snap
  between nodes. Linear devices render at `cell*gridSize` (no offset) so they store plain
  `round`. `DeviceNode`/`SegmentNode` take `isLinear` to pick the right snap.
- **Opens in edit mode** (v2.19.4): the "Open layout editor" launcher sets `isEdit`
  true, because a full-window *editor* you can't drag in is useless (drag is gated on
  `isEdit`; view mode only selects). Dragging is verified working — the gate was the
  only reason it "didn't let you." The `touchAction: pan-x pan-y` still lets an active
  node drag win via its non-passive `touchmove` `preventDefault`.
- **Fit-to-content on open** (keyed on `[expanded, layout?.mode]`), no-op once fit:
  - `compactLinearLayout` (line): renumber entries (placed devices + each segment of an
    expanded device) to consecutive positions `1..N` by order and shrink the boundary.
    Start at 1, not 0, so the first dot isn't clipped at the edge.
  - `fitFloorPlanLayout` (floor plan): **crop, don't pack** — a rigid translate that
    shifts content to the origin and shrinks the boundary to the content extent + a few
    cells of drag room. It removes wasted outer margins but preserves the user's
    arrangement AND the open grid to drag into. (An earlier version packed empty
    rows/columns; that collapsed drag space and re-collapsed the layout on every reopen,
    fighting placement — don't reintroduce it.)
- **Reachable from Assign Rooms too (v2.20.0):** each `RoomCard` in `room-assignment.js`
  has a collapsible "Map / Layout" subsection that mounts the same `RoomMap` (its
  "Open layout editor" launcher opens the full-window editor) — so you can arrange a
  room right where you assign its devices. `RoomMap` builds its device list from the
  `hueLights`/`goveeDevices` props, so `RoomCard` passes **only that room's** devices
  (split by vendor from `getDevicesForRoom`), not the global lists — same contract as
  `RoomSection`. App threads the map props (control/favorites/segment/layout/fixture
  handlers) through `RoomAssignment` → `RoomCard`.

## Settings → Power Recovery (app.js `PowerRecoveryCard`, v3.3.0)
A Settings-tab card choosing how a fresh boot after a power outage treats the lights:
three radio-style mode cards (`resume_unless_night` default / `resume_always` / `off`)
plus two 30-min-increment time dropdowns (`NIGHT_TIME_OPTIONS`) for the night window,
shown only for `resume_unless_night`. Auto-saves each change via `updatePowerRecovery`
→ `POST /api/power-recovery` (optimistic, no Save button). `powerRecovery` state loads
from `cfg.power_recovery` (falls back to the built-in defaults when the key is absent, so
an un-migrated config still renders). The backend applies it only on the Pi's next boot —
this card never drives lights. See `backend/CLAUDE.md` "Power-recovery after an outage".
The night window shows the **browser's local zone** (`Intl…resolvedOptions().timeZone` +
the short abbr) purely as a callout — the hub compares wall-clock `HH:MM` against its own
local clock, which is DST-safe by construction (10 PM is always 10 PM), and the hub shares
the browser's zone (same LAN, same house). No timezone picker — it's local-only by design.

**The amber "This can't be perfect on its own" block is load-bearing copy (v3.29.0).** The
card used to imply the hub restores your lights, full stop. A real outage showed the truth:
the lights come back on their own hardware default *immediately*, and the hub can't say
anything until it has booted and reconnected a minute or two later. The block states that
sequence plainly and tells the user the only actual fix — set each light's power-on
behavior to **off** in the Hue/Govee apps, which is a setting LightEmUp cannot reach.
**Don't trim it for tidiness**; an unstated limitation gets rediscovered as a bug report.

## app.js — orchestration
State, routing, API calls. **Fast initial load (v3.5.0):** `loadAll(isFirst)` paints from
`/config` + `/discover/govee/cached` (instant, no LAN scan) + the quick segment/lightning/
hue calls, then flips `loading` off — so the UI is interactive in ~a config round-trip
instead of waiting 6–15s on the Govee UDP scan. On first load only, it then fires the live
`/discover/govee` **in the background** (not awaited) and replaces the cached devices with
live reachability + state when it lands. SSE refetches also use the cached endpoint (fast)
and don't trigger a background scan. **Progressive loading screen (v3.4.1):** the phases
narrate into `loadingStatus` (only when `isFirst`) — "Loading your rooms and settings…" →
"Loading your lights…" — rendered under a pulsing 🔆 on the full-screen loader.
**Instant pre-mount loader (v3.5.1):** `index.html` ships a static HTML/CSS loader
*inside* `#root` (pulsing 🔆 + "LightEmUp" + "Starting up…", using the global `pulse`
keyframe) so something shows the moment the page paints — before the CDN React/Babel
scripts download and Babel transpiles the ~15 files. `createRoot(root).render()` replaces
it on mount; app.js's loader uses the same `pulse` keyframe + layout so the handoff is
seamless (no flash). Previously the navy `<body>` sat empty during that window.
`controlHueLight` / `controlGoveeDevice` spread `cmd` into
the POST body, so passing CT keys (`color_temp` mireds / `color_temp_kelvin`) works
without new endpoints. Opens the EventSource on mount and coalesces incoming SSE into a
debounced `loadAll`. **SSE only carries LightEmUp's own changes, so the page also
refreshes itself (v3.50.0):** `loadAll()` when it comes back into view after more than
5 s hidden, and a lights-only `refreshHueLights()` (one bridge GET) every 60 s while
visible. That tick is skipped within 5 s of any write from this page
(`apiLastWriteAt()`, stamped by `api()` in utils.js): a read racing a command can
return the state from just before it and flip the card back. Govee isn't polled,
since that is a LAN scan. A defer answer saying the light
was actually on (`was_on`, or a room's `live`) triggers the same Hue re-read. `ctCalibrated = {...ctCorrection, ...ctRgb}` drives the badges.
- **Global master control (v3.4.0, backend-driven v3.43.0):** a bar under the nav
  (visible on every tab) with **just "All Off"**. `controlAll(on)` now makes ONE
  `POST /api/all/control` and paints the optimistic state locally; it used to issue
  a request per device in a single tick, which was the largest burst this app could
  aim at the bridge and had no verify behind it. The old global "All On" / "All On ·
  Soft White" were **removed**: you rarely want to light every outside light + every
  empty room at once. The useful *on* shortcuts are **per-room** (below).
- **Per-room white quick-actions (room-section.js, v3.4.0, relabeled v3.4.2):** each
  `RoomSection` header has a **"Whole-room shortcuts"** labeled group *on its own line*
  below the panel openers (not inline with them), with **Soft White (2700K)** +
  **Cool White (6500K)** buttons — shown when the group has ≥1 light (so Unassigned gets
  them too). The heading scopes both buttons (they set EVERY light in the room), so the
  buttons stay short and carry **no icons** (a ❄ snowflake read as literal "cold", fighting
  the warm/cool-white metaphor). Cool White is an "emergency / brightest" mode; **both force
  full brightness**. `setRoomWhite(kelvin)` fans out over *that room's* `hueLights`/
  `goveeDevices`. **As of v3.43.0 a real room calls `onRoomWhite` → one
  `POST /api/rooms/white`**, and the per-vendor split (Hue mireds + bri 1–254, Govee
  kelvin + bri 0–100, `ct_rgb` calibration) happens server-side in
  `_apply_room_white` — the same function the scheduler uses, so a scheduled 2700K
  and a button press can no longer disagree. Only "Unassigned" still fans out per
  device. Buttons keep warm-amber / cool-blue tint. **Heading is "Set room to"
  (v3.4.3)** — it deliberately holds *only* the specific looks (no on/off/resume), because
  the master power toggle owns that. This split fixes the "two zones both do whole-room
  power" clunk: toggle = power/resume, this group = looks. On the pseudo-"Unassigned" group
  the heading reads **"Set lights to"** instead (v3.4.4) — it's not a room; `isRealRoom =
  !!onLayoutChange` distinguishes them.
- **"Unassigned" isn't a backend room** — its `RoomSection` gets an `onControlRoom` that
  drives `unassignedHue`/`unassignedGovee` directly (was a no-op `() => {}`, so its on/off
  toggle did nothing — v3.1.0 fix). Don't route Unassigned through `/api/rooms/control`.
- **Room on/off is a toggle switch, not a "Turn Off" button** (room-section.js, v3.1.0):
  the old button was styled muted/gray exactly when lights were ON, reading as disabled.
  The switch shows state (indigo+knob-right = on). **It's really Resume ⇄ Off (v3.4.3):**
  turning "on" sends `{on:true}`, so lights return to their last state (bulbs/strips
  remember) — not a fixed look. The label shows current state honestly; the tooltip spells
  out "Resume the room's last lighting". It owns power/resume; the "Set room to" group owns
  presets — so they're no longer duplicate whole-room controls.
- **"Room Map" is its own surface view** (room-section.js, v3.1.0), gated on
  `canMap = !!onLayoutChange && allLights.length > 0` (so Unassigned has none). It was a
  buried collapsible inside Controls; now it's a first-class opener next to Scenes/Controls.
- **Assign Rooms edits persist immediately (v3.0.1):** `RoomAssignment`'s `onRoomsChange`
  is `handleRoomsChange`, which `setRooms(updated)` **and** POSTs the rooms right away —
  NOT `setRooms` alone. The old wiring only saved on a "Save Rooms" click, so a
  background `loadAll()` (SSE from another session / a finishing scene) would
  `setRooms(cfg.rooms)` and silently wipe the unsaved assignment (nicknames survived
  because they POST on change — that asymmetry was the bug). Don't revert room edits to a
  local-only `setRooms`. Room *deletion* calls `DELETE /api/rooms/{name}` (v3.1.1) —
  POST only upserts, so without the DELETE a removed room lingered and reappeared on the
  next refresh. The old top-of-page **"Save Rooms" button was removed (v3.1.3)** — it
  re-POSTed rooms that were already persisted, and its "✓ Saved" flash falsely implied
  edits were unsaved; the tall page made it a scroll-away trap. Don't reintroduce it.
  See `docs/save-consistency-audit.md` for the full save/persistence UX audit.
