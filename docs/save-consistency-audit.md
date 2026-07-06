# Save / Persistence UX Audit (todo #56)

Goal: make the UI consistent and honest about *when a change persists*. Today some
changes save instantly, some need an explicit "Save" button, and some of those Save
buttons are pinned at the **top** of a very tall page — many scrolls away from where the
action was taken — so it is easy to make a change, miss the button, and lose the edit.

Line references are against the working tree at the time of writing
(`backend/static/js/*`).

---

## 1. Inventory of every "Save" button and persistence mutation point

### A. Explicit buttons literally labelled "Save"/"Save X"

| # | Location | Label | What it does | Classification |
|---|----------|-------|--------------|----------------|
| 1 | `room-assignment.js:451-459` (`saveAll` @ 410) | **Save Rooms** | Re-POSTs every room to `/api/rooms` | **REDUNDANT** — assignments already auto-persist (see §2). Remove. |
| 2 | `app.js:64` (`SettingsDeviceRow`, `saveEdit`) | Save | Commits an inline **nickname** edit → `POST /api/nicknames` | Free-text commit. Keep (also commits on Enter). |
| 3 | `light-card.js:369-372` (`saveEdit`) | Save | Commits a device **nickname** edit → `POST /api/nicknames` | Free-text commit. Keep (commits on Enter). |
| 4 | `lightning-panel.js:455-463` (`saveSettings` @ 83) | **Save Settings** | POSTs the whole lightning-settings form → `/api/scenes/lightning/settings` | Batch of discrete toggles/sliders held in local state until Save. Button sits at the **bottom of the panel, near the controls** (not pinned top), so it's the *least* bad case, but still a save-or-lose form. Candidate for auto-persist — see §4 open question. |
| 5 | `ct-calibration.js:216` (`saveAll` @ 120) | **Save & finish** | Persists tuned white-calibration points → `POST /api/calibration/ct-rgb` | Genuine commit of a guided tuning session. Button lives in-panel near the tuning UI. Keep. |
| 6 | `room-map.js:1558-1562` / `+ Save Scene` @ 1570 (`savePreset`) | Save / + Save Scene | Names & stores a **layout scene preset** | Genuine "create a named thing" action, commits on Enter, affordance is right at the preset list. Keep. |
| 7 | `components-shared.js:196-201` (`addCurrentAsFavorite`) | ★ Save | Adds the current colour to favourites → `POST /api/favorites` | Genuine **action** (not form persistence). Keep. |

### B. Instant-persist mutation points (POST on change — the good pattern)

These fire the API immediately from an `onChange`/handler, optimistically updating local
state first. This is the target model and is already correct.

| Handler | File:line | Endpoint | Trigger |
|---------|-----------|----------|---------|
| `updateNickname` | `app.js:139-149` | `POST /nicknames` | nickname commit |
| `addRoom` | `app.js:154-167` | `POST /rooms` | create room (Rooms tab) |
| `handleRoomsChange` | `app.js:175-191` | `POST /rooms` (per room) | **assign/move/remove device** |
| `deleteRoom` | `room-assignment.js:400-408` | `DELETE /rooms/{name}` | delete a room |
| `updateFavorites` | `app.js:133-137` | `POST /favorites` | add/remove favourite |
| `updatePickerStyle` | `app.js:293-303` | `POST /ui-prefs` | picker-style toggle |
| `updateMinSat` | `app.js:305-316` | `POST /ui-prefs` | min-saturation toggle/slider |
| `updateSegmentFillMode` | `app.js:318-328` | `POST /segment-fill-modes` | fill-mode dropdown |
| `updateDeviceMode` / `...Bulk` | `app.js:330-353` | `POST /device-modes[/bulk]` | whole/segments toggle |
| segment mode/count toggle | `lightning-panel.js:414-426` | `POST /govee/segment-mode`,`/segment-count` | per-device switch |
| `forgetGoveeDevice` | `app.js:368-373` | `DELETE /govee/known/{mac}` | forget device |
| fixture upsert/delete | `app.js:527-553` | `POST/DELETE /fixtures` | fixture edits |
| device control (Hue/Govee/room/identify) | `app.js:20,431,449,477` | control endpoints | live control (not persistence) |

### C. Debounced auto-persist

| Handler | File:line | Endpoint | Notes |
|---------|-----------|----------|-------|
| `saveLayout` via `updateLayout` | `room-map.js:942-963` | `POST /room-layouts` | 600ms debounce after any map/layout change. Good — but see §4: the editor *feels* explicit (Done button) even though it's already auto-saved. |
| Landmark rename | `room-map.js:2141-2142` | (feeds `updateLayout`) | commit-on-blur **and** Enter → debounced save. Good pattern. |

### D. Persist-only-as-a-side-effect-of-an-action (subtle)

| Handler | File:line | Endpoint | Notes |
|---------|-----------|----------|-------|
| room colour-tool selection | `room-section.js:228-235` (`onApply`) | `POST /room-color-state` | The whole scene selection (mode, palette, shuffle seed, custom colours…) is persisted **only when Apply is pressed**. Choosing a palette/mode without applying does not survive a refresh. See §4 open question. |

### E. Free-text inputs — keystroke behaviour (checked for "saves on every keydown")

All free-text fields already avoid per-keystroke persistence — they commit on Enter
(and/or blur) or via an adjacent button, holding a local `useState` in between:

- New room name — `room-assignment.js:572` (`addRoom` on Enter). Local `newRoomName`. Good.
- Nickname (settings) — `app.js:55-64`. Enter/Escape/Save. Good.
- Nickname (card) — `light-card.js:357-372`. Enter/Escape/Save. Good.
- Preset name — `room-map.js:1548-1562`. Enter/Escape/Save. Good.
- Landmark rename — `room-map.js:2140-2142`. Enter + blur. Good.
- Favourite add — `components-shared.js:297` Enter. Good.

No text field persists on every keystroke. No change needed here.

---

## 2. Why "Save Rooms" (#1) is redundant

`RoomAssignment` calls `onRoomsChange` for **every** mutation — `moveDevice`
(`room-assignment.js:362`), `removeDevice` (`:372`), `addDevicesToRoom` (`:390`),
`addRoom` (`:396`), `deleteRoom` (`:403`). `onRoomsChange` is wired in `app.js` to
`handleRoomsChange` (`app.js:175-191`), which does `setRooms(updated)` **and** POSTs
every room to `/api/rooms` immediately (v3.0.1). Room deletion additionally fires
`DELETE /api/rooms/{name}` (v3.1.1).

So by the time the user could reach the top-of-page **Save Rooms** button, the change is
already on the backend. The button's `saveAll` (`:410-430`) just re-POSTs the identical
rooms — a no-op with a misleading "✓ Saved" flash that implies the prior edits were
*unsaved*. Worse, it's pinned at the top of a tall page, teaching exactly the wrong
mental model ("I must scroll up and Save or I'll lose my work") for a surface that no
longer needs it. **This is the clear, low-risk removal.**

---

## 3. Proposed consistent persistence model

One rule set, applied everywhere:

1. **Discrete controls** (dropdown, toggle/switch, slider, drag, add/remove-to-list):
   **instant-persist**. Optimistically update local state, fire the API in the
   background (fire-and-forget with `.catch`), never require a separate Save. This is
   already the dominant pattern (§1.B) — the job is to eliminate the hold-outs, not
   introduce a new mechanism.

2. **Free text** (nickname, room name, preset name, landmark label): **commit on blur
   and/or Enter** into a local buffer, then persist. Escape cancels. Never persist on
   every keystroke. Already correct everywhere (§1.E).

3. **Genuine actions** (Apply a scene to the lights, ★ Save a favourite colour, + Save
   Scene preset, Flash/identify, Start/Stop storm): keep an explicit button. These are
   **not** persistence-of-form-state and should not be conflated with "Save". Their
   affordance must sit **next to the action**, never pinned far away.

4. **Where an explicit commit is genuinely unavoidable** (e.g. a guided multi-step
   tuning session): the button lives **in-context, adjacent to the controls it
   commits** — never at the top of a long scroll.

Corollary for this app's "very tall page" pain: **no persistence Save button belongs at
the top of a page.** Either the change auto-persists (preferred) or the commit
affordance is docked to the control group.

---

## 4. Reconciliation plan

### Do now (unambiguous, low-risk) — IMPLEMENTED

- **Remove "Save Rooms"** in `RoomAssignment` (`room-assignment.js`): delete the button
  (`:451-459`), the `✓ Saved` / `Save failed` status spans (`:449-450`), the `saveAll`
  function (`:410-430`), and the now-unused `saving`/`saveStatus` state (`:312-313`).
  Assignments already auto-persist via `handleRoomsChange`. Net: removes the misleading
  top-pinned button and the false "unsaved" mental model.

### Recommend (needs review / a design call) — NOT implemented

- **Lightning "Save Settings"** (`lightning-panel.js:79-94, 454-463`). `updateSetting`
  only mutates local state; nothing persists without the button. Converting each
  toggle/slider to instant-persist (a debounced `POST /scenes/lightning/settings`, like
  `room-layouts`) would match the model and remove the save-or-lose trap. **Open
  question:** the settings feed a scene that may be *running*; auto-persisting mid-storm
  changes behaviour on the next flash. Confirm that live-apply is desired (it likely is),
  then convert. Low complexity, but it's a behavioural change, so left for review.

- **Room colour-tool selection persists only on Apply** (`room-section.js:228-235`).
  A chosen palette/mode/custom-colours set is lost on refresh unless Apply was pressed.
  **Open question:** is that intentional (selection == "what was applied") or should the
  selection debounce-persist to `room_color_state` on change so a half-configured scene
  survives a refresh? If the latter, note the CLAUDE.md contract that any new colour-tool
  field must be added to `applyColors`, `RoomColorStateRequest`, and the `seededRoom`
  hydration effect — a debounced saver must serialise the same snapshot. Design decision.

- **Room-layout editor "Done" affordance** (`room-map.js`, `expanded`/Done). The layout
  already auto-saves (600ms debounce, §1.C); "Done" only closes the overlay. This is
  fine, but the overlay could show a tiny "Saved" / "Saving…" indicator so the user
  knows the debounce fired before they close it. Minor polish, optional.

- **Nickname Save buttons (#2, #3)** are fine as-is (commit-on-Enter + adjacent button).
  No change; listed only so the audit is exhaustive.

---

## 5. Summary

- **1 clear win implemented:** removed the redundant, top-pinned "Save Rooms" button.
- **The instant-persist model is already the norm** (§1.B) — most of the app is correct.
- **Two real inconsistencies remain, both needing a design call** (lightning settings
  save-or-lose; colour-tool selection only-persists-on-Apply). Documented as open
  questions rather than changed.
- **No free-text field saves per keystroke** — nothing to fix there.
</content>
</invoke>
