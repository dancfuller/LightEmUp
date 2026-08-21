# backend/static/js/ — Frontend internals

In-browser React 18 + Babel standalone. **No build step.** Each file runs in the
global scope; top-level `function`/`const` declarations are effectively global. Files
load in the dependency order set by `<script>` tags in `../index.html` — that order is
authoritative (utils first, app last). See root `CLAUDE.md` for the mobile/responsive
rules that apply to every UI change. **Keep this file current when behavior changes.**

## Load order (from index.html)
utils → audio → components-shared → light-card → favorite-lights → lightning-panel →
room-map → palette-data → palette-library → color-mode → light-scene → location-data →
schedules → segment-reset-debug → room-section → zones → room-assignment →
setup-wizard → server-logs → ct-calibration → backup-restore → app

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

## favorite-lights.js — the pinned Favorites strip (v3.33.0)
Star a light and it's pinned to the top of **both** Rooms and All Lights, on screen
before any scrolling happens. Config key `favorite_lights` (an ORDERED list of device
keys — array order is render order, so starring appends and nothing sorts it).
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
- **Teams / NCAA / Flags modes** are preset-color modes backed by `palette-data.js`
  (`PRESET_TEAMS` NFL/NBA/MLB/NHL, `PRESET_NCAA` Power 5, `PRESET_FLAGS` ~195
  countries). A searchable `PresetPicker` selects one entity by name; its hex colors
  (true black filtered via `isNearBlack` — brightest-channel test, so dark-but-vivid
  colors like navy `#041E42` are kept) are assigned with the shared `cycleAssign`
  — the same positional cycle as Custom mode — and honor the shared `ShadeToggle`
  (`customShadeMode`: exact colors, or tonal shades per color). These modes are
  color-only: they ignore the Color/White space (the toggle is hidden via
  `isPresetMode`). Selection persists as `selected_team`/`selected_ncaa`/`selected_flag`.
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
  hexa close to other lights may over-constrain a small palette, but the relax
  fallbacks resolve it. Each custom seed
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
- "Last colors" re-sends the stored `segment_state`, which survives restarts — the
  useful case being a device that was power-cycled, clearing its segments while the hub
  still remembers them.

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
- **The "Set room to" white shortcuts fan out CLIENT-side**, so no room endpoint sees them;
  `setRoomWhite` POSTs `/api/rooms/last-applied` explicitly, guarded on `isRealRoom` because
  "Unassigned" isn't a room the backend knows. **Any new client-side whole-room fan-out
  must do the same, or the header will keep advertising the previous look.**

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
debounced `loadAll`. `ctCalibrated = {...ctCorrection, ...ctRgb}` drives the badges.
- **Global master control (v3.4.0):** a bar under the nav (visible on every tab) with
  **just "All Off"**, driving `controlAll(hueCmd, goveeCmd)` — which fans out per device
  (Hue/Govee each get their own cmd) client-side, fire-and-forget. The old global "All On"
  / "All On · Soft White" were **removed**: you rarely want to light every outside light +
  every empty room at once. The useful *on* shortcuts are now **per-room** (below).
- **Per-room white quick-actions (room-section.js, v3.4.0, relabeled v3.4.2):** each
  `RoomSection` header has a **"Whole-room shortcuts"** labeled group *on its own line*
  below the panel openers (not inline with them), with **Soft White (2700K)** +
  **Cool White (6500K)** buttons — shown when the group has ≥1 light (so Unassigned gets
  them too). The heading scopes both buttons (they set EVERY light in the room), so the
  buttons stay short and carry **no icons** (a ❄ snowflake read as literal "cold", fighting
  the warm/cool-white metaphor). Cool White is an "emergency / brightest" mode; **both force
  full brightness**. `setRoomWhite(kelvin)` fans out over *that room's* `hueLights`/
  `goveeDevices` via `onControlHue`/`onControlGovee` — Hue gets `{on:true, brightness:254,
  color_temp: mireds}`, Govee gets `{on:true, brightness:100, color_temp_kelvin}` (note the
  vendor brightness scales differ: Hue 1–254, Govee 0–100; Govee CT → server-side `ct_rgb`
  calibration). Buttons keep warm-amber / cool-blue tint. **Heading is "Set room to"
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
