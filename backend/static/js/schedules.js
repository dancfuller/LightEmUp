// Schedules tab — time-based automation.
//
// A schedule pairs a TRIGGER (weekly / one-off / sunrise-sunset) with an ACTION
// (a captured color scene, a random palette, a white temperature, or a single
// color) for one room or zone.
//
// SNAPSHOT vs RECIPE — the two kinds of color action, and why both exist:
//
//   scene   — a SNAPSHOT. All the scene math (gradient, beacon, teams…) lives in
//             color-mode.js in the browser, so the schedule stores the fully
//             resolved apply plan captured by "Schedule this look" and the
//             backend replays it verbatim. Exact and repeatable, but frozen: it
//             can't be authored here, only captured in the room's Scenes panel.
//
//   palette — a RECIPE (v3.17.0). The schedule stores WHICH PALETTES to draw
//             from ("any Summer palette", or these four), and the Pi picks one
//             and assigns it to the room's lights when it fires. That's the
//             point: the same 10-minutes-before-sunset schedule should look
//             different tonight than it did last night. It can be authored right
//             here because the palette library is shared with the backend —
//             see palette-library.js, generated from backend/palette_library.json.

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];   // 0 = Monday, matching Python's weekday()
const DAY_PRESETS = [
  { label: "Every day", days: [0, 1, 2, 3, 4, 5, 6] },
  { label: "Weekdays", days: [0, 1, 2, 3, 4] },
  { label: "Weekends", days: [5, 6] },
];
const WHITE_PRESETS = [
  { label: "Soft White", kelvin: 2700, tint: "#fbbf24" },
  { label: "Neutral", kelvin: 4000, tint: "#fde68a" },
  { label: "Cool White", kelvin: 6500, tint: "#93c5fd" },
];

// ─── Palette preview pieces ─────────────────────────────────────────────────
// A palette action is only trustworthy if you can SEE what it might do, so every
// place one appears — the editor, the picker grid, the saved-schedule row —
// renders the actual colors rather than just a name.

const PALETTE_BY_NAME = (() => {
  const m = {};
  (typeof PALETTE_LIBRARY !== "undefined" ? PALETTE_LIBRARY : []).forEach(p => { m[p.name] = p; });
  return m;
})();

// Category chips, with the same two virtual entries the color tool offers.
// The backend understands both (palettes.in_category), so a schedule authored
// from "Featured" resolves to the same 22 palettes on the Pi.
const PALETTE_FILTERS = ["Featured", "All",
  ...(typeof PALETTE_CATEGORIES !== "undefined" ? PALETTE_CATEGORIES : [])];

function palettesFor(filter) {
  const lib = typeof PALETTE_LIBRARY !== "undefined" ? PALETTE_LIBRARY : [];
  if (filter === "All") return lib;
  if (filter === "Featured") return lib.filter(p => p.featured);
  return lib.filter(p => p.category === filter);
}

// The set a palette action will draw from — the browser's mirror of the
// backend's palettes.resolve_candidates(). Keep the two in step: what the editor
// previews has to be exactly what the Pi will choose between.
function paletteCandidates(action) {
  if (!action) return [];
  // Legacy (pre-v3.28.0) actions stored a whole CATEGORY by reference. The
  // backend still honours those, so they keep firing; the editor expands one
  // into an explicit list the first time you open it (see expandLegacy), which
  // is what makes individual palettes prunable.
  if (action.source === "category") return palettesFor(action.category || "All");
  return (action.palettes || []).map(n => PALETTE_BY_NAME[n]).filter(Boolean);
}

// Open a stored action for editing: a category reference becomes the explicit
// set it currently resolves to, so every palette in it can be removed one by one.
function expandLegacyPalettes(action) {
  if (!action || action.type !== "palette" || action.source !== "category") return action;
  const { source, category, ...rest } = action;
  return { ...rest, palettes: palettesFor(category || "All").map(p => p.name) };
}

// The color bar. Equal-width stops, no gaps — it reads as one object at 40px
// wide in a list row and at 160px wide in the picker.
function PaletteStrip({ colors, height = 10, radius = 3 }) {
  return (
    <div style={{ display: "flex", height, borderRadius: radius, overflow: "hidden" }}>
      {(colors || []).map((c, i) => (
        <div key={i} style={{ flex: 1, background: `rgb(${c.r}, ${c.g}, ${c.b})` }} />
      ))}
    </div>
  );
}

// A saved row's preview: the first few palettes this schedule could choose from.
// A name alone ("random from Summer") doesn't tell you whether that's the mood
// you wanted at 9pm; four color bars do.
function PaletteCandidatePeek({ action, max = 4 }) {
  const cands = paletteCandidates(action);
  if (!cands.length) return null;
  const shown = cands.slice(0, max);
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
      {shown.map(p => (
        <div key={p.name} title={p.name} style={{ width: 46 }}>
          <PaletteStrip colors={p.colors} height={8} radius={2} />
        </div>
      ))}
      {cands.length > shown.length && (
        <span style={{ fontSize: 10, color: "#64748b" }}>+{cands.length - shown.length}</span>
      )}
    </div>
  );
}

// One selectable palette in the picker grid.
function PaletteCard({ palette, selected, onClick, isMobile }) {
  return (
    <button onClick={onClick} style={{
      padding: isMobile ? 6 : 8, borderRadius: 8, cursor: "pointer", textAlign: "left",
      border: selected ? "1px solid #6366f1" : "1px solid #334155",
      background: selected ? "rgba(99,102,241,0.18)" : "#0f172a",
      display: "flex", flexDirection: "column", gap: 5, width: "100%",
    }}>
      <PaletteStrip colors={palette.colors} height={isMobile ? 12 : 14} />
      <div style={{
        display: "flex", alignItems: "center", gap: 4,
        fontSize: isMobile ? 10 : 11, fontWeight: 600,
        color: selected ? "#c7d2fe" : "#cbd5e1",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>
        {selected && <span style={{ color: "#818cf8" }}>✓</span>}
        {palette.name}
      </div>
    </button>
  );
}

// The fields each action type owns. Switching type rebuilds the action from
// these plus the target, so a stored action never carries fields belonging to a
// type it isn't (a "power" action with a leftover kelvin, say) — that's noise in
// config.json and in a backup, and it reads as if power sets a color.
const ACTION_DEFAULTS = {
  white: { kelvin: 2700, brightness: 100 },
  color: { rgb: { r: 255, g: 180, b: 100 }, brightness: 100 },
  palette: { palettes: [], brightness: 100 },
  colors: { colors: [[255, 0, 0], [0, 200, 60]], brightness: 100 },
  power: { on: false },
};

function pad2(n) { return String(n).padStart(2, "0"); }

// "07:00" → "7:00 AM" — schedules are read at a glance, so 12-hour reads better
// than the 24-hour value we store.
function prettyTime(hhmm) {
  const [h, m] = (hhmm || "").split(":").map(Number);
  if (isNaN(h) || isNaN(m)) return hhmm || "--:--";
  const ampm = h < 12 ? "AM" : "PM";
  return `${((h + 11) % 12) + 1}:${pad2(m)} ${ampm}`;
}

function prettyDays(days) {
  if (!days || !days.length) return "never";
  const preset = DAY_PRESETS.find(p => p.days.length === days.length && p.days.every(d => days.includes(d)));
  if (preset) return preset.label.toLowerCase();
  return [...days].sort((a, b) => a - b).map(d => DAY_LABELS[d]).join(", ");
}

function prettyOffset(min) {
  const n = Number(min || 0);
  if (!n) return "";
  return n < 0 ? ` ${Math.abs(n)} min before` : ` ${n} min after`;
}

function triggerSummary(trig) {
  if (!trig) return "No trigger";
  if (trig.type === "weekly") return `${prettyTime(trig.time)} · ${prettyDays(trig.days)}`;
  if (trig.type === "oneoff") return `${trig.date} at ${prettyTime(trig.time)} · once`;
  if (trig.type === "sun") {
    const ev = trig.event === "sunset" ? "sunset" : "sunrise";
    const off = prettyOffset(trig.offset_min);
    return `${off ? off.trim() + " " : ""}${ev} · ${prettyDays(trig.days)}`.replace(/^(\d+ min (?:before|after)) /, "$1 ");
  }
  return "Unknown trigger";
}

function actionSummary(action) {
  if (!action) return "No action";
  if (action.type === "scene") {
    const p = action.payload || {};
    const n = (p.hue?.length || 0) + (p.govee_whole?.length || 0)
      + (p.razer?.length || 0) + (p.cloud?.length || 0);
    return `Scene · ${n} device${n === 1 ? "" : "s"}`;
  }
  if (action.type === "palette") {
    const cands = paletteCandidates(action);
    // A stored action names palettes; if the library no longer has any of them
    // the schedule will fire and do nothing, so say so instead of "0 palettes".
    if (cands.length === 0) return "Palette · none of these exist any more";
    // "1 palette" isn't random at all, and saying so avoids someone wondering
    // why their "random" schedule shows the same look every night.
    if (cands.length === 1) return `Palette · always ${cands[0].name}`;
    return `Random palette · ${cands.length} palettes`;
  }
  if (action.type === "colors") {
    const n = (action.colors || []).length;
    return `My Colors · ${n} color${n === 1 ? "" : "s"}`;
  }
  if (action.type === "white") return `White ${action.kelvin}K · ${action.brightness}%`;
  if (action.type === "color") {
    const c = action.rgb || {};
    return `Color rgb(${c.r}, ${c.g}, ${c.b}) · ${action.brightness}%`;
  }
  if (action.type === "power") {
    return action.on === false ? "Turn off" : "Turn on · last used look";
  }
  return "Unknown action";
}

// The room or zone a schedule targets, for the list row.
function targetSummary(action) {
  if (!action) return "";
  return action.zone ? `Zone: ${action.zone}` : (action.room || "");
}

// Next fire time for weekly/one-off, purely client-side for the "next run" hint.
// Sun triggers need the Pi's astral computation, so they get a text hint instead
// of a wrong guess.
function nextRunLabel(sched) {
  const trig = sched.trigger || {};
  if (!sched.enabled) return "Disabled";
  if (trig.type === "sun") return "At " + (trig.event === "sunset" ? "sunset" : "sunrise");
  const [h, m] = (trig.time || "").split(":").map(Number);
  if (isNaN(h) || isNaN(m)) return "—";
  const now = new Date();

  if (trig.type === "oneoff") {
    if (!trig.date) return "—";
    const [y, mo, d] = trig.date.split("-").map(Number);
    const when = new Date(y, mo - 1, d, h, m);
    if (when <= now) return "Passed";
    return when.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  const days = trig.days || [];
  if (!days.length) return "Never";
  for (let i = 0; i < 8; i++) {
    const cand = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, h, m);
    // JS getDay() is 0=Sunday; our storage is 0=Monday (Python weekday()).
    const pyDay = (cand.getDay() + 6) % 7;
    if (days.includes(pyDay) && cand > now) {
      return i === 0 ? `Today ${prettyTime(trig.time)}`
        : i === 1 ? `Tomorrow ${prettyTime(trig.time)}`
        : `${DAY_LABELS[pyDay]} ${prettyTime(trig.time)}`;
    }
  }
  return "—";
}

// One formatter for a duration, used by BOTH the preset buttons and the
// read-back line — otherwise the button says "90 min" and the sentence under it
// says "1h 30m" for the very same value.
function prettyMinutes(m) {
  m = Number(m) || 0;
  if (m >= 60 && m % 60 === 0) return `${m / 60}h`;
  if (m > 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m} min`;
}

// "…then off after 90 min" / "…then off at sunrise +10" — the OFF half in words.
function endSummary(end) {
  if (!end) return "";
  if (end.type === "after") return `, off after ${prettyMinutes(end.after_minutes)}`;
  if (end.type === "weekly") return `, off at ${prettyTime(end.time)}`;
  if (end.type === "sun") {
    return `, off at ${end.event === "sunrise" ? "sunrise" : "sunset"}${prettyOffset(end.offset_min)}`;
  }
  return "";
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// ─── Palette action editor ──────────────────────────────────────────────────
// Two ways to say "surprise me": a whole category, or a hand-picked set. Both
// resolve to a CANDIDATE LIST that the Pi draws one from at fire time, so both
// render that list as swatches — the preview isn't decoration, it's the only way
// to know what a schedule you'll never watch fire is actually going to do.

// ─── Palette action editor ──────────────────────────────────────────────────
// ONE curated set of palettes, not two competing modes (v3.28.0). It used to be
// "a whole category" OR "hand-picked names", which fought the actual goal: you
// want a shortlist of palettes you like, and a category is just a fast way to
// throw ten candidates at it. So the category chips became bulk ADD/REMOVE into
// the same list, which is what makes "Summer and Winter" and "Summer minus the
// three I don't like" the same gesture instead of different features.
//
// The set is always rendered as swatches — the preview isn't decoration, it's
// the only way to know what a schedule you'll never watch fire will do.

// ─── "My Colors" action editor (v3.28.0) ────────────────────────────────────
// Colors you name yourself, for a look with no palette behind it — alternating
// red and green at Christmas being the case that prompted it. The colors live
// IN the schedule, so nothing is chosen at fire time; the backend wraps them as
// a one-off palette and runs the SAME builder, which is what makes two colors
// come out ABABAB down a hexa strip instead of needing their own arrangement.
function ColorsActionEditor({ action, patchAction, isMobile, label, seg, onTry,
                              favorites, onFavoritesChange }) {
  const colors = action.colors || [];
  const [active, setActive] = useState(0);
  const [trying, setTrying] = useState(false);
  const [tried, setTried] = useState(null);

  const setColor = (i, r, g, b) => patchAction({
    colors: colors.map((c, j) => (j === i ? [r, g, b] : c)),
  });
  const addColor = () => {
    patchAction({ colors: [...colors, [255, 255, 255]] });
    setActive(colors.length);
  };
  const removeColor = (i) => {
    patchAction({ colors: colors.filter((_, j) => j !== i) });
    setActive(a => Math.max(0, a > i ? a - 1 : a));
  };

  const tryIt = async () => {
    setTrying(true); setTried(null);
    try { setTried({ ok: true, ...(await onTry()) }); }
    catch (e) { setTried({ ok: false, message: e?.message || "the hub couldn't apply it" }); }
    setTrying(false);
  };

  const cur = colors[Math.min(active, colors.length - 1)] || [255, 255, 255];

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={label}>Colors — {colors.length || "none yet"}</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
        {colors.map((c, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 3 }}>
            <button onClick={() => setActive(i)}
              title={`rgb(${c[0]}, ${c[1]}, ${c[2]}) — tap to edit`}
              style={{
                width: 40, height: 32, borderRadius: 8, cursor: "pointer",
                background: `rgb(${c[0]}, ${c[1]}, ${c[2]})`,
                border: i === active ? "2px solid #fff" : "1px solid #334155",
                boxShadow: i === active ? "0 0 0 2px #6366f1" : "none",
              }} />
            <button onClick={() => removeColor(i)} title="Remove this color"
              style={{
                border: "none", background: "transparent", color: "#64748b",
                fontSize: 14, fontWeight: 700, cursor: "pointer", padding: "0 2px",
              }}>×</button>
          </div>
        ))}
        {colors.length < 8 && (
          <button onClick={addColor} style={{
            padding: "8px 12px", borderRadius: 8, border: "1px dashed #475569",
            background: "transparent", color: "#94a3b8",
            fontSize: 12, fontWeight: 700, cursor: "pointer",
          }}>+ Add color</button>
        )}
      </div>

      {colors.length === 0 && (
        <div style={{ fontSize: 11, color: "#f59e0b", marginBottom: 10 }}>
          Add at least one color.
        </div>
      )}

      {colors.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <ColorPicker
            currentColor={{ r: cur[0], g: cur[1], b: cur[2] }}
            onColorSelect={(r, g, b) => setColor(Math.min(active, colors.length - 1), r, g, b)}
            favorites={favorites} onFavoritesChange={onFavoritesChange}
          />
        </div>
      )}

      <div>
        <div style={label}>Brightness · {action.brightness ?? 100}%</div>
        <input type="range" min={1} max={100} value={action.brightness ?? 100}
          onChange={e => patchAction({ brightness: Number(e.target.value) })}
          style={{ width: "100%", accentColor: "#6366f1" }} />
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 12 }}>
        <button onClick={tryIt} disabled={trying || colors.length === 0} style={{
          padding: "7px 14px", borderRadius: 8, border: "1px solid #334155",
          background: "transparent", color: colors.length ? "#c7d2fe" : "#475569",
          fontSize: 12, fontWeight: 600, cursor: trying ? "wait" : "pointer",
        }}>{trying ? "Applying…" : "Try it now"}</button>
        {tried && (
          <span style={{ fontSize: 11, color: tried.ok ? "#4ade80" : "#f87171" }}>
            {tried.ok ? `Now on ${(tried.rooms || []).join(", ")}` : `Couldn't apply — ${tried.message}`}
          </span>
        )}
      </div>
      <div style={{ fontSize: 10, color: "#64748b", marginTop: 6 }}>
        Spread across the room's lights, alternating so neighbours differ — two colors
        give a strict A-B-A-B down a segmented strip.
      </div>
    </div>
  );
}

function PaletteActionEditor({ action, patchAction, isMobile, label, field, seg, onTry }) {
  const [filter, setFilter] = useState("Featured");
  const [trying, setTrying] = useState(false);
  const [tried, setTried] = useState(null);

  const selected = action.palettes || [];
  const inFilter = palettesFor(filter);
  const allShown = inFilter.length > 0 && inFilter.every(p => selected.includes(p.name));

  const toggle = (name) => patchAction({
    palettes: selected.includes(name) ? selected.filter(n => n !== name) : [...selected, name],
  });
  const addAll = () => patchAction({
    palettes: [...selected, ...inFilter.map(p => p.name).filter(n => !selected.includes(n))],
  });
  const removeAll = () => patchAction({
    palettes: selected.filter(n => !inFilter.some(p => p.name === n)),
  });

  const tryIt = async () => {
    setTrying(true); setTried(null);
    try {
      setTried({ ok: true, ...(await onTry()) });
    } catch (e) {
      setTried({ ok: false, message: e?.message || "the hub couldn't apply it" });
    }
    setTrying(false);
  };

  const gridStyle = {
    display: "grid",
    // Two columns on a phone rather than one: these are 14px swatch bars, and a
    // single column would turn a 160-palette library into an endless scroll.
    gridTemplateColumns: isMobile ? "repeat(2, 1fr)" : "repeat(auto-fill, minmax(150px, 1fr))",
    gap: 6, maxHeight: isMobile ? 240 : 300, overflowY: "auto",
    padding: 2, borderRadius: 8,
  };

  return (
    <div style={{ marginBottom: 12 }}>
      {/* THE SET — always visible, whatever category you're browsing, because
          picks span categories and you need to see the whole shortlist while
          you prune it. Each chip removes itself. */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "baseline",
        gap: 8, marginBottom: 6, flexWrap: "wrap",
      }}>
        <div style={{ ...label, marginBottom: 0 }}>
          {selected.length === 0 ? "No palettes chosen yet"
            : `Picks one of these ${selected.length}, fresh each time`}
        </div>
        {selected.length > 0 && (
          <button onClick={() => patchAction({ palettes: [] })} style={{
            border: "none", background: "transparent", color: "#818cf8",
            fontSize: 11, fontWeight: 600, cursor: "pointer", padding: 0,
          }}>Clear all</button>
        )}
      </div>

      {selected.length > 0 && (
        <div style={{
          display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12,
          maxHeight: isMobile ? 150 : 190, overflowY: "auto",
          padding: selected.length > 8 ? 2 : 0,
        }}>
          {selected.map(name => {
            const p = PALETTE_BY_NAME[name];
            return (
              <button key={name} onClick={() => toggle(name)} title="Remove"
                style={{
                  display: "flex", alignItems: "center", gap: 6, padding: "4px 8px",
                  borderRadius: 999, border: "1px solid #4338ca",
                  background: "rgba(99,102,241,0.15)", cursor: "pointer",
                  fontSize: isMobile ? 10 : 11, fontWeight: 600,
                  color: p ? "#c7d2fe" : "#f87171",
                }}>
                <span style={{ width: 32, display: "block" }}>
                  <PaletteStrip colors={p ? p.colors : []} height={8} radius={2} />
                </span>
                {name}{!p && " (gone)"}
                <span style={{ color: "#818cf8" }}>×</span>
              </button>
            );
          })}
        </div>
      )}

      {selected.length === 0 && (
        <div style={{ fontSize: 11, color: "#f59e0b", marginBottom: 12 }}>
          Add at least one — tap a category below, then tap palettes (or "Add all").
        </div>
      )}
      {selected.length === 1 && (
        <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 12 }}>
          With one palette there's nothing to choose between — this will show{" "}
          <strong>{selected[0]}</strong> every time.
        </div>
      )}

      {/* THE SOURCE — browse a category and add from it. Bulk add/remove is what
          makes multi-category sets ("Summer and Winter") a two-tap job. */}
      <div style={{ ...label, marginTop: 4 }}>Add from</div>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
        {PALETTE_FILTERS.map(c => {
          const n = palettesFor(c).filter(p => selected.includes(p.name)).length;
          return (
            <button key={c} onClick={() => setFilter(c)}
              style={{ ...seg(filter === c), fontSize: isMobile ? 10 : 11, padding: "4px 8px" }}>
              {c}{n > 0 && <span style={{ color: "#818cf8" }}> ·{n}</span>}
            </button>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
        <button onClick={addAll} disabled={allShown} style={{
          padding: "5px 12px", borderRadius: 7, border: "1px solid #4338ca",
          background: "transparent", color: allShown ? "#475569" : "#c7d2fe",
          fontSize: 11, fontWeight: 700, cursor: allShown ? "default" : "pointer",
        }}>+ Add all {inFilter.length} from {filter}</button>
        <button onClick={removeAll} style={{
          padding: "5px 12px", borderRadius: 7, border: "1px solid #334155",
          background: "transparent", color: "#94a3b8",
          fontSize: 11, fontWeight: 700, cursor: "pointer",
        }}>− Remove these</button>
      </div>

      <div style={gridStyle}>
        {inFilter.map(p => (
          <PaletteCard key={p.name} palette={p} isMobile={isMobile}
            selected={selected.includes(p.name)} onClick={() => toggle(p.name)} />
        ))}
      </div>

      <div style={{ marginTop: 14 }}>
        <div style={label}>Brightness · {action.brightness ?? 100}%</div>
        <input type="range" min={1} max={100} value={action.brightness ?? 100}
          onChange={e => patchAction({ brightness: Number(e.target.value) })}
          style={{ width: "100%", accentColor: "#6366f1" }} />
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 12 }}>
        <button onClick={tryIt} disabled={trying || selected.length === 0} style={{
          padding: "7px 14px", borderRadius: 8, border: "1px solid #334155",
          background: "transparent", color: selected.length ? "#c7d2fe" : "#475569",
          fontSize: 12, fontWeight: 600, cursor: trying ? "wait" : "pointer",
        }}>{trying ? "Applying…" : "Try one now"}</button>
        {tried && (
          <span style={{ fontSize: 11, color: tried.ok ? "#4ade80" : "#f87171" }}>
            {tried.ok
              ? `Picked ${tried.palette} — now on ${(tried.rooms || []).join(", ")}`
              : `Couldn't apply — ${tried.message}`}
          </span>
        )}
      </div>
      <div style={{ fontSize: 10, color: "#64748b", marginTop: 6 }}>
        "Try one now" turns the lights on and applies a random pick, exactly as the
        schedule will. Segmented Govee devices are painted the way that room's Scenes panel is set.
      </div>
    </div>
  );
}

// ─── Editor ─────────────────────────────────────────────────────────────────

function ScheduleEditor({ initial, rooms, zoneNames, favorites, onFavoritesChange, onSave, onCancel, isMobile }) {
  const [name, setName] = useState(initial?.name || "");
  const [trigger, setTrigger] = useState(initial?.trigger || { type: "weekly", time: "07:00", days: [0, 1, 2, 3, 4] });
  // expandLegacyPalettes turns a stored "whole category" reference into the
  // explicit set it resolves to, so opening an old schedule lets you prune it.
  const [action, setAction] = useState(
    expandLegacyPalettes(initial?.action) || { type: "white", room: rooms[0] || "", kelvin: 2700, brightness: 100 });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // A captured scene can't be re-authored here — the look came from the color
  // tool. You can retarget everything else about it, just not rebuild it.
  const isScene = action.type === "scene";
  // Target is a room OR a zone (a group of rooms). A scene is always room-only
  // (it's a device-specific snapshot); a zone fans white/color/power out.
  const isZone = !!action.zone;
  const patchTrigger = (p) => setTrigger(prev => ({ ...prev, ...p }));
  const patchAction = (p) => setAction(prev => ({ ...prev, ...p }));

  // Switching action type REBUILDS the action from the target plus that type's
  // own fields, instead of merging on top of the old one. What you had typed for
  // the type you're leaving is remembered HERE, in component state rather than
  // in the stored action — so White(4000K) → Color → White still brings 4000K
  // back, without 4000K riding along inside a saved "power" action.
  const [typeMemory, setTypeMemory] = useState({});
  const setActionType = (type, override) => {
    const { type: prevType, room, zone, ...rest } = action;
    const same = prevType === type;
    if (!same) setTypeMemory(m => ({ ...m, [prevType]: rest }));
    setAction({
      type,
      ...(zone ? { zone } : { room: room ?? (rooms[0] || "") }),
      ...(same ? rest : (typeMemory[type] || ACTION_DEFAULTS[type] || {})),
      ...(override || {}),
    });
  };

  // Switch the target between a single room and a zone, adding/removing the
  // right key (patchAction only merges, so removal needs an explicit rebuild).
  const setTargetKind = (kind) => setAction(prev => {
    const { room, zone, ...rest } = prev;
    return kind === "zone"
      ? { ...rest, zone: zone || (zoneNames[0] || "") }
      : { ...rest, room: room || (rooms[0] || "") };
  });

  const toggleDay = (d) => {
    const days = trigger.days || [];
    patchTrigger({ days: days.includes(d) ? days.filter(x => x !== d) : [...days, d].sort((a, b) => a - b) });
  };

  // ─── Sun offset: a direction and a magnitude, never a typed minus sign ──────
  // Stored as one signed `offset_min` (negative = before), which is what the
  // scheduler reads — but split here because a signed number field couldn't be
  // edited: it prefilled 0, refused to be cleared (Number("") is 0), and could
  // never hold "-" on the way to "-10" (Number("-") is NaN).
  //
  // Direction is its OWN state rather than derived from the sign, so that
  // picking "Before" while the magnitude is 0 doesn't snap back to "After"
  // (-0 < 0 is false). At 0 minutes the two mean the same thing anyway.
  const [offsetDir, setOffsetDir] = useState(
    Number(initial?.trigger?.offset_min || 0) < 0 ? "before" : "after");
  const [offsetDraft, setOffsetDraft] = useState(null);

  // The optional OFF half. Its own state rather than part of `action`, because
  // it's a property of the SPAN, not of what the lights are set to.
  const [end, setEnd] = useState(initial?.end || null);
  const [endDraft, setEndDraft] = useState(null);        // duration text
  const [endOffDraft, setEndOffDraft] = useState(null);  // sun-offset text
  const [endDir, setEndDir] = useState(
    Number(initial?.end?.offset_min || 0) < 0 ? "before" : "after");
  const offsetMag = Math.abs(Number(trigger.offset_min || 0));
  const sunEventName = trigger.event === "sunrise" ? "sunrise" : "sunset";
  const setOffset = (dir, mag) =>
    patchTrigger({ offset_min: (dir === "before" ? -1 : 1) * Math.abs(mag) });

  // "Try one now" — fire the action immediately against the same target, so the
  // thing you're about to trust to run at sunset can be seen on the actual walls
  // first. Same endpoint shape as the stored action; the backend picks and
  // applies exactly as the scheduler would.
  const tryPalette = () => api("/palettes/apply", {
    method: "POST",
    body: JSON.stringify({
      room: action.zone ? null : action.room,
      zone: action.zone || null,
      // A "My Colors" action carries its colors inline; a palette action names
      // library palettes. One endpoint, because both end up as the same builder.
      colors: action.type === "colors" ? (action.colors || []) : [],
      palettes: action.palettes || [],
      brightness: action.brightness ?? 100,
    }),
  });

  const submit = async () => {
    if (isZone) { if (!action.zone) { setError("Pick a zone."); return; } }
    else if (!action.room) { setError("Pick a room."); return; }
    if (action.type === "palette" && paletteCandidates(action).length === 0) {
      setError("Pick at least one palette."); return;
    }
    if (action.type === "colors" && (action.colors || []).length === 0) {
      setError("Add at least one color."); return;
    }
    if (trigger.type !== "sun" && !/^\d{2}:\d{2}$/.test(trigger.time || "")) { setError("Pick a time."); return; }
    if (trigger.type === "oneoff" && !trigger.date) { setError("Pick a date."); return; }
    if (trigger.type !== "oneoff" && !(trigger.days || []).length) { setError("Pick at least one day."); return; }
    setSaving(true); setError(null);
    try {
      await onSave({
        id: initial?.id || undefined,
        name: name.trim() || `${action.zone || action.room} ${trigger.type === "sun" ? trigger.event : prettyTime(trigger.time)}`,
        enabled: initial ? initial.enabled : true,
        trigger, action,
        // Always sent, so clearing it (null) actually removes it — the backend
        // distinguishes "absent" from "explicitly null".
        end: (action.type === "power" && action.on === false) ? null : end,
      });
    } catch (e) {
      setError("Couldn't save — " + (e?.message || "the hub didn't accept it."));
      setSaving(false);
    }
  };

  const label = { fontSize: 11, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 };
  const field = {
    padding: "8px 10px", borderRadius: 8, border: "1px solid #334155",
    background: "#0f172a", color: "#e2e8f0", fontSize: 13, width: "100%",
  };
  const seg = (active) => ({
    padding: isMobile ? "7px 10px" : "7px 14px", borderRadius: 8,
    border: active ? "1px solid #6366f1" : "1px solid #334155",
    background: active ? "rgba(99,102,241,0.18)" : "transparent",
    color: active ? "#c7d2fe" : "#94a3b8",
    fontSize: isMobile ? 11 : 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
  });

  return (
    <div style={{
      background: "#1e293b", borderRadius: 16, padding: isMobile ? 14 : 20,
      marginBottom: 16, border: "1px solid #6366f1",
    }}>
      {/* Dismiss at the TOP as well as the bottom (v3.26.0). The editor is long —
          name, target, action (a palette grid is 300px of it), trigger, days —
          so backing out of an edit you opened by mistake meant scrolling the
          whole form to reach Cancel. This is an × rather than a second button
          labelled "Cancel": two identical labels invite "do these differ?", while
          an × in a panel header is unambiguously "close this". Same handler. */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: 10, marginBottom: 16,
      }}>
        <div style={{ fontSize: isMobile ? 15 : 17, fontWeight: 700, color: "#e2e8f0" }}>
          {initial?.id ? "Edit schedule" : "New schedule"}
        </div>
        <button
          onClick={onCancel}
          title="Close without saving"
          aria-label="Close without saving"
          style={{
            width: 30, height: 30, borderRadius: 8, flexShrink: 0,
            border: "1px solid #334155", background: "transparent",
            color: "#94a3b8", fontSize: 16, fontWeight: 700, cursor: "pointer",
            lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >×</button>
      </div>

      <div style={{ marginBottom: 16 }}>
        <div style={label}>Name</div>
        <input value={name} onChange={e => setName(e.target.value)}
          placeholder="Morning Ocean" style={field} />
      </div>

      {/* ─── Target: room or zone ───────────────────────────────────── */}
      <div style={{ marginBottom: 16 }}>
        <div style={label}>Apply to</div>
        {/* A scene is room-only, so the Room/Zone toggle is hidden for it. */}
        {!isScene && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
            <button style={seg(!isZone)} onClick={() => setTargetKind("room")}>A room</button>
            <button style={seg(isZone)}
              onClick={() => setTargetKind("zone")}
              disabled={zoneNames.length === 0}
              title={zoneNames.length === 0 ? "Create a zone below first" : "A group of rooms"}>
              A zone
            </button>
          </div>
        )}
        {isZone ? (
          <select value={action.zone} onChange={e => patchAction({ zone: e.target.value })} style={field}>
            {!action.zone && <option value="">Pick a zone…</option>}
            {zoneNames.map(z => <option key={z} value={z}>{z}</option>)}
          </select>
        ) : (
          <select value={action.room} onChange={e => patchAction({ room: e.target.value })}
            disabled={isScene} style={{ ...field, opacity: isScene ? 0.6 : 1 }}>
            {!action.room && <option value="">Pick a room…</option>}
            {rooms.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        )}
      </div>

      {/* ─── Action ─────────────────────────────────────────────────── */}
      {/* "Turn on" was never a peer of White/Color/Palette: those already send
          on=true with the color, so nobody schedules "on" and then separately
          schedules a look. Only OFF is a distinct outcome. So the choices are
          grouped by what the room ends up like — a look (which implies on), or
          one of the two power outcomes — instead of pretending power is a
          fourth kind of look. Storage is unchanged: "Turn off" is still
          {type:"power", on:false}. */}
      <div style={{ marginBottom: 16 }}>
        {isScene ? (
          <>
            <div style={label}>Do what</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
              <button style={seg(true)} disabled>Captured scene</button>
            </div>
          </>
        ) : (
          <>
            <div style={label}>Turn on and set</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
              <button style={seg(action.type === "white")}
                onClick={() => setActionType("white")}>White</button>
              <button style={seg(action.type === "color")}
                onClick={() => setActionType("color")}>Color</button>
              <button style={seg(action.type === "palette")}
                onClick={() => setActionType("palette")}>Palette</button>
              <button style={seg(action.type === "colors")}
                onClick={() => setActionType("colors")}
                title="Colors you pick yourself — e.g. alternating red and green">
                My Colors
              </button>
            </div>

            <div style={{ ...label, marginTop: 12 }}>Or just</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
              <button style={seg(action.type === "power" && action.on === false)}
                onClick={() => setActionType("power", { on: false })}>Turn off</button>
              {/* "Resume" is genuinely different from any look: it sends only
                  {on:true} and each light returns to whatever IT remembers, so
                  there's nothing to specify and nothing to compare later. */}
              <button style={seg(action.type === "power" && action.on !== false)}
                onClick={() => setActionType("power", { on: true })}
                title="Each light returns to the color and brightness it last had">
                Turn on, last used look
              </button>
            </div>
          </>
        )}

        {isScene && (
          <div style={{
            padding: 12, borderRadius: 10, background: "rgba(99,102,241,0.10)",
            border: "1px solid #4338ca", fontSize: 12, color: "#c7d2fe", marginBottom: 12,
          }}>
            {actionSummary(action)} — captured from the color tool in{" "}
            <strong>{action.room}</strong>. To change the look, build it again in that
            room's Scenes panel and capture it fresh.
          </div>
        )}

        {/* No on/off sub-picker any more — the two power outcomes are their own
            buttons above, so choosing one is a single click instead of two. */}
        {action.type === "power" && action.on !== false && (
          <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 12 }}>
            Each light returns to the color and brightness it last had — nothing to set here.
          </div>
        )}

        {action.type === "white" && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
            {WHITE_PRESETS.map(p => (
              <button key={p.kelvin} onClick={() => patchAction({ kelvin: p.kelvin })}
                style={{ ...seg(action.kelvin === p.kelvin), color: action.kelvin === p.kelvin ? p.tint : "#94a3b8" }}>
                {p.label} · {p.kelvin}K
              </button>
            ))}
          </div>
        )}

        {action.type === "palette" && (
          <PaletteActionEditor action={action} patchAction={patchAction} isMobile={isMobile}
            label={label} field={field} seg={seg} onTry={tryPalette} />
        )}

        {action.type === "colors" && (
          <ColorsActionEditor action={action} patchAction={patchAction} isMobile={isMobile}
            label={label} seg={seg} onTry={tryPalette}
            favorites={favorites} onFavoritesChange={onFavoritesChange} />
        )}

        {action.type === "color" && (
          <div style={{ marginBottom: 12 }}>
            <ColorPicker
              currentColor={action.rgb}
              onColorSelect={(r, g, b) => patchAction({ rgb: { r, g, b } })}
              favorites={favorites} onFavoritesChange={onFavoritesChange}
            />
          </div>
        )}

        {(action.type === "white" || action.type === "color") && (
          <div style={{ marginBottom: 12 }}>
            <div style={label}>Brightness · {action.brightness}%</div>
            <input type="range" min={1} max={100} value={action.brightness}
              onChange={e => patchAction({ brightness: Number(e.target.value) })}
              style={{ width: "100%", accentColor: "#6366f1" }} />
          </div>
        )}
      </div>

      {/* ─── Trigger ────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 16 }}>
        <div style={label}>When</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
          <button style={seg(trigger.type === "weekly")}
            onClick={() => setTrigger({ type: "weekly", time: trigger.time || "07:00", days: trigger.days || [0, 1, 2, 3, 4] })}>Weekly</button>
          <button style={seg(trigger.type === "oneoff")}
            onClick={() => setTrigger({ type: "oneoff", time: trigger.time || "07:00", date: trigger.date || todayISO() })}>Once</button>
          <button style={seg(trigger.type === "sun")}
            onClick={() => setTrigger({ type: "sun", event: trigger.event || "sunset", offset_min: trigger.offset_min || 0, days: trigger.days || [0, 1, 2, 3, 4, 5, 6] })}>Sunrise / sunset</button>
        </div>

        {trigger.type === "sun" ? (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
            <div style={{ flex: "1 1 140px" }}>
              <div style={label}>Event</div>
              <select value={trigger.event} onChange={e => patchTrigger({ event: e.target.value })} style={field}>
                <option value="sunrise">Sunrise</option>
                <option value="sunset">Sunset</option>
              </select>
            </div>
            {/* Before/After is a BUTTON, not a minus sign the user has to type.
                Asking for "-10" in a number field is hostile: on a phone keypad
                the hyphen often isn't there at all, and a controlled numeric
                input can't hold the intermediate "-" (Number("-") is NaN), so
                the sign was literally unenterable. Magnitude is always >= 0. */}
            <div style={{ flex: "1 1 220px" }}>
              <div style={label}>Offset</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                <div style={{ display: "flex", gap: 4, background: "#0f172a", borderRadius: 8, padding: 2 }}>
                  {[["before", "Before"], ["after", "After"]].map(([k, lbl]) => (
                    <button key={k} onClick={() => { setOffsetDir(k); setOffset(k, offsetMag); }}
                      style={{
                        padding: isMobile ? "6px 10px" : "6px 12px", borderRadius: 6, border: "none",
                        background: offsetDir === k ? "#6366f1" : "transparent",
                        color: offsetDir === k ? "#fff" : "#94a3b8",
                        fontSize: isMobile ? 11 : 12, fontWeight: 600, cursor: "pointer",
                      }}>{lbl}</button>
                  ))}
                </div>
                {/* draft holds the RAW text while typing, so the field can be
                    emptied (committing nothing) instead of snapping back to 0,
                    and "010" normalizes to "10" on blur. Same idiom as
                    RgbSliderInput in components-shared.js. */}
                <input type="number" min={0} step={5} inputMode="numeric"
                  value={offsetDraft ?? String(offsetMag)}
                  onFocus={e => e.target.select()}
                  onChange={e => {
                    const text = e.target.value;
                    setOffsetDraft(text);
                    if (text.trim() !== "" && !Number.isNaN(Number(text))) {
                      setOffset(offsetDir, Math.max(0, Math.round(Number(text))));
                    }
                  }}
                  onBlur={() => setOffsetDraft(null)}
                  onKeyDown={e => { if (e.key === "Enter") e.target.blur(); }}
                  style={{ ...field, width: 76, flex: "0 0 76px", textAlign: "center" }} />
                <span style={{ fontSize: 12, color: "#94a3b8" }}>min</span>
              </div>
              <div style={{ fontSize: 10, color: "#64748b", marginTop: 4 }}>
                {offsetMag === 0
                  ? `Exactly at ${sunEventName}.`
                  : `${offsetMag} minute${offsetMag === 1 ? "" : "s"} ${offsetDir} ${sunEventName}.`}
              </div>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
            <div style={{ flex: "1 1 140px" }}>
              <div style={label}>Time</div>
              <input type="time" value={trigger.time || ""}
                onChange={e => patchTrigger({ time: e.target.value })} style={field} />
            </div>
            {trigger.type === "oneoff" && (
              <div style={{ flex: "1 1 140px" }}>
                <div style={label}>Date</div>
                <input type="date" value={trigger.date || ""} min={todayISO()}
                  onChange={e => patchTrigger({ date: e.target.value })} style={field} />
              </div>
            )}
          </div>
        )}

        {trigger.type !== "oneoff" && (
          <div>
            <div style={label}>On these days</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
              {DAY_LABELS.map((d, i) => (
                <button key={d} onClick={() => toggleDay(i)} style={{
                  ...seg((trigger.days || []).includes(i)),
                  minWidth: 44, textAlign: "center", padding: "7px 8px",
                }}>{d}</button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {DAY_PRESETS.map(p => (
                <button key={p.label} onClick={() => patchTrigger({ days: [...p.days] })}
                  style={{ ...seg(false), fontSize: 11, padding: "5px 10px" }}>{p.label}</button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ─── Optional OFF half ──────────────────────────────────────── */}
      {/* One entry that turns lights on and later off. Two schedules can do this
          today, and silently drift — retarget one, forget the other, and the
          lights stay on all day. Hidden for a "Turn off" action, which has
          nothing to end. */}
      {!(action.type === "power" && action.on === false) && (
        <div style={{ marginBottom: 16 }}>
          <div style={label}>Then turn off</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: end ? 12 : 0 }}>
            <button style={seg(!end)} onClick={() => setEnd(null)}>Leave on</button>
            <button style={seg(end?.type === "after")}
              onClick={() => setEnd({ type: "after", after_minutes: end?.after_minutes || 60 })}>
              After a while
            </button>
            <button style={seg(end?.type === "weekly")}
              onClick={() => setEnd({ type: "weekly", time: end?.time || "23:00" })}>
              At a time
            </button>
            <button style={seg(end?.type === "sun")}
              onClick={() => setEnd({ type: "sun", event: end?.event || "sunrise", offset_min: end?.offset_min || 0 })}>
              Sunrise / sunset
            </button>
          </div>

          {end?.type === "after" && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              {[30, 60, 90, 120, 240].map(m => (
                <button key={m} style={seg(Number(end.after_minutes) === m)}
                  onClick={() => setEnd({ ...end, after_minutes: m })}>
                  {prettyMinutes(m)}
                </button>
              ))}
              <input type="number" min={1} step={15} inputMode="numeric"
                value={endDraft ?? String(end.after_minutes ?? 60)}
                onFocus={e => e.target.select()}
                onChange={e => {
                  const t = e.target.value;
                  setEndDraft(t);
                  if (t.trim() !== "" && !Number.isNaN(Number(t))) {
                    setEnd({ ...end, after_minutes: Math.max(1, Math.round(Number(t))) });
                  }
                }}
                onBlur={() => setEndDraft(null)}
                style={{ ...field, width: 78, flex: "0 0 78px", textAlign: "center" }} />
              <span style={{ fontSize: 12, color: "#94a3b8" }}>min</span>
            </div>
          )}

          {end?.type === "weekly" && (
            <input type="time" value={end.time || ""}
              onChange={e => setEnd({ ...end, time: e.target.value })}
              style={{ ...field, maxWidth: 200 }} />
          )}

          {end?.type === "sun" && (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
              <div style={{ flex: "1 1 140px" }}>
                <div style={label}>Event</div>
                <select value={end.event || "sunrise"}
                  onChange={e => setEnd({ ...end, event: e.target.value })} style={field}>
                  <option value="sunrise">Sunrise</option>
                  <option value="sunset">Sunset</option>
                </select>
              </div>
              <div style={{ flex: "1 1 200px" }}>
                <div style={label}>Offset</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                  <div style={{ display: "flex", gap: 4, background: "#0f172a", borderRadius: 8, padding: 2 }}>
                    {[["before", "Before"], ["after", "After"]].map(([k, lbl]) => (
                      <button key={k}
                        onClick={() => { setEndDir(k); setEnd({ ...end, offset_min: (k === "before" ? -1 : 1) * Math.abs(Number(end.offset_min) || 0) }); }}
                        style={{
                          padding: isMobile ? "6px 10px" : "6px 12px", borderRadius: 6, border: "none",
                          background: endDir === k ? "#6366f1" : "transparent",
                          color: endDir === k ? "#fff" : "#94a3b8",
                          fontSize: isMobile ? 11 : 12, fontWeight: 600, cursor: "pointer",
                        }}>{lbl}</button>
                    ))}
                  </div>
                  {/* Same draft-string rule as the trigger's offset — a bound
                      number can't be cleared, and "-" can't be typed. */}
                  <input type="number" min={0} step={5} inputMode="numeric"
                    value={endOffDraft ?? String(Math.abs(Number(end.offset_min) || 0))}
                    onFocus={e => e.target.select()}
                    onChange={e => {
                      const t = e.target.value;
                      setEndOffDraft(t);
                      if (t.trim() !== "" && !Number.isNaN(Number(t))) {
                        setEnd({ ...end, offset_min: (endDir === "before" ? -1 : 1) * Math.max(0, Math.round(Number(t))) });
                      }
                    }}
                    onBlur={() => setEndOffDraft(null)}
                    style={{ ...field, width: 76, flex: "0 0 76px", textAlign: "center" }} />
                  <span style={{ fontSize: 12, color: "#94a3b8" }}>min</span>
                </div>
              </div>
            </div>
          )}

          {end && (
            <div style={{ fontSize: 10, color: "#64748b", marginTop: 6 }}>
              Turns the same {isZone ? "zone" : "room"} off{endSummary(end).replace(/^, off/, "")}.
              {end.type !== "after" && " Crossing midnight is fine — the days above apply to when it turns ON."}
            </div>
          )}
        </div>
      )}

      {error && (
        <div style={{ fontSize: 12, color: "#f87171", marginBottom: 12 }}>{error}</div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button onClick={submit} disabled={saving} style={{
          padding: "8px 20px", borderRadius: 8, border: "none",
          background: saving ? "#334155" : "#6366f1", color: saving ? "#64748b" : "#fff",
          fontSize: 13, fontWeight: 700, cursor: saving ? "wait" : "pointer",
        }}>{saving ? "Saving…" : "Save schedule"}</button>
        <button onClick={onCancel} style={{
          padding: "8px 20px", borderRadius: 8, border: "1px solid #334155",
          background: "transparent", color: "#94a3b8", fontSize: 13, fontWeight: 600, cursor: "pointer",
        }}>Cancel</button>
      </div>
    </div>
  );
}

// ZoneManager moved to zones.js (v3.15.0). Zones are no longer a
// schedules-only concept: they have live On/Off controls in the global bar
// and are managed in Assign Rooms, next to the rooms they group. This tab
// still TARGETS zones (see the Room/Zone toggle in ScheduleEditor); it just
// no longer owns them.

// ─── Tab ────────────────────────────────────────────────────────────────────

function SchedulesTab({ schedules, rooms, zones, location, favorites, onFavoritesChange,
                        onSave, onDelete, onSaveZone, onDeleteZone, pendingScene, onConsumePending,
                        onNavigate }) {
  const isMobile = useIsMobile();
  const [editing, setEditing] = useState(null);   // null | {} (new) | schedule
  const [confirmDelete, setConfirmDelete] = useState(null);
  const zoneNames = Object.keys(zones || {});

  // A look captured by "Schedule this look" lands here: open the editor
  // pre-filled with that scene, then clear the handoff so a later tab visit
  // doesn't reopen it.
  useEffect(() => {
    if (!pendingScene) return;
    setEditing({
      action: { type: "scene", room: pendingScene.room, payload: pendingScene.plan },
      trigger: { type: "weekly", time: "07:00", days: [0, 1, 2, 3, 4] },
    });
    onConsumePending();
  }, [pendingScene]);

  const needsLocation = schedules.some(s => s.trigger?.type === "sun")
    && (location?.lat == null || location?.lng == null);

  const save = async (sched) => {
    await onSave(sched);
    setEditing(null);
  };

  const card = {
    background: "#1e293b", borderRadius: 16, padding: isMobile ? 12 : 16,
    marginBottom: 10, border: "1px solid #334155",
  };

  return (
    <div style={{ padding: isMobile ? "12px 10px" : "20px 24px", maxWidth: 900, margin: "0 auto" }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        gap: 10, flexWrap: "wrap", marginBottom: 16,
      }}>
        <div>
          <div style={{ fontSize: isMobile ? 17 : 20, fontWeight: 700, color: "#e2e8f0" }}>Schedules</div>
          <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>
            The hub runs these on its own — no browser needed.
          </div>
        </div>
        {!editing && (
          <button onClick={() => setEditing({})} style={{
            padding: "8px 16px", borderRadius: 8, border: "none",
            background: "#6366f1", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer",
          }}>+ New schedule</button>
        )}
      </div>

      {needsLocation && (
        <div style={{
          padding: 12, borderRadius: 10, marginBottom: 12,
          background: "rgba(251,191,36,0.10)", border: "1px solid #b45309",
          fontSize: 12, color: "#fcd34d",
        }}>
          A sunrise/sunset schedule needs your location to know when the sun rises.
          Set it in <strong>Settings → Location</strong> — until then those schedules
          won't fire.
        </div>
      )}

      {editing && (
        <ScheduleEditor
          initial={editing.id || editing.action ? editing : null}
          rooms={rooms} zoneNames={zoneNames}
          favorites={favorites} onFavoritesChange={onFavoritesChange}
          onSave={save} onCancel={() => setEditing(null)} isMobile={isMobile}
        />
      )}

      {schedules.length === 0 && !editing && (
        <div style={{ ...card, textAlign: "center", padding: isMobile ? 24 : 36 }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>⏰</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: "#94a3b8", marginBottom: 6 }}>No schedules yet</div>
          <div style={{ fontSize: 12, color: "#64748b", lineHeight: 1.6 }}>
            Add one here for a white, single-color or <strong>random palette</strong> look
            — or build a full scene in a room's <strong>Scenes</strong> panel and press{" "}
            <strong>⏰ Schedule this look</strong>.
          </div>
        </div>
      )}

      {/* The row for the schedule being edited is hidden: the editor above IS
          that schedule, so showing both means two representations of one thing
          on screen, one of them stale the moment you type. Only for an EXISTING
          schedule — a new one has no row yet. */}
      {schedules.filter(s => !(editing && editing.id && s.id === editing.id)).map(s => (
        <div key={s.id} style={{ ...card, opacity: s.enabled ? 1 : 0.6 }}>
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 200px", minWidth: 0 }}>
              <div style={{ fontSize: isMobile ? 14 : 15, fontWeight: 700, color: "#e2e8f0" }}>
                {s.name}
              </div>
              <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>
                {triggerSummary(s.trigger)}
                {s.end && (
                  <span style={{ color: "#fbbf24" }}>{endSummary(s.end)}</span>
                )}
              </div>
              {/* An armed span is the one thing here that's happening RIGHT NOW,
                  so it gets said plainly rather than left to be inferred. */}
              {s.end_due && (
                <div style={{ fontSize: 11, color: "#fbbf24", marginTop: 3 }}>
                  ● On now — turning off at {prettyTime((s.end_due.split(" ")[1] || ""))}
                </div>
              )}
              <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>
                {targetSummary(s.action)} · {actionSummary(s.action)}
              </div>
              {s.action?.type === "palette" && <PaletteCandidatePeek action={s.action} />}
              {s.action?.type === "colors" && (s.action.colors || []).length > 0 && (
                <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
                  <div style={{ width: 46 }}>
                    <PaletteStrip height={8} radius={2}
                      colors={(s.action.colors || []).map(c => ({ r: c[0], g: c[1], b: c[2] }))} />
                  </div>
                </div>
              )}
              <div style={{ fontSize: 11, color: s.enabled ? "#34d399" : "#64748b", marginTop: 6 }}>
                Next: {nextRunLabel(s)}
              </div>
            </div>

            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              {/* Enable toggle — a patch POST, so flipping it never disturbs
                  the trigger (and never resets last_fired). */}
              <button onClick={() => onSave({ id: s.id, enabled: !s.enabled })}
                title={s.enabled ? "Disable" : "Enable"}
                style={{
                  width: 44, height: 24, borderRadius: 12, border: "none", padding: 2,
                  background: s.enabled ? "#6366f1" : "#334155", cursor: "pointer",
                  display: "flex", justifyContent: s.enabled ? "flex-end" : "flex-start",
                }}>
                <div style={{ width: 20, height: 20, borderRadius: 10, background: "#fff" }} />
              </button>
              <button onClick={() => setEditing(s)} style={{
                padding: "6px 12px", borderRadius: 8, border: "1px solid #334155",
                background: "transparent", color: "#94a3b8", fontSize: 12, fontWeight: 600, cursor: "pointer",
              }}>Edit</button>
              {confirmDelete === s.id ? (
                <button onClick={() => { onDelete(s.id); setConfirmDelete(null); }} style={{
                  padding: "6px 12px", borderRadius: 8, border: "none",
                  background: "#ef4444", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer",
                }}>Confirm</button>
              ) : (
                <button onClick={() => setConfirmDelete(s.id)} style={{
                  padding: "6px 12px", borderRadius: 8, border: "1px solid #7f1d1d",
                  background: "transparent", color: "#f87171", fontSize: 12, fontWeight: 600, cursor: "pointer",
                }}>Delete</button>
              )}
            </div>
          </div>
        </div>
      ))}

      {/* Zones are managed in Assign Rooms now — point there rather than
          duplicating the editor, so there's one place membership can change. */}
      <div style={{
        marginTop: 18, padding: isMobile ? 12 : 14, borderRadius: 12,
        background: "#16233a", border: "1px solid #334155",
        fontSize: 12, color: "#94a3b8", lineHeight: 1.6,
      }}>
        <strong style={{ color: "#e2e8f0" }}>Zones</strong> ({zoneNames.length}) let a
        schedule act on several rooms at once, and have On/Off buttons in the bar at the
        top of every page. Create and edit them in{" "}
        {/* A link, not a sentence naming a tab. Telling someone where to go and
            then making them walk is the part that reads as an apology for the
            layout; the same words should just take them there. */}
        <button
          onClick={() => onNavigate && onNavigate("assign rooms")}
          disabled={!onNavigate}
          style={{
            border: "none", background: "transparent", padding: 0,
            font: "inherit", color: "#818cf8", fontWeight: 700,
            textDecoration: "underline", textUnderlineOffset: 2,
            cursor: onNavigate ? "pointer" : "default",
          }}
        >Assign Rooms</button>.
        {zoneNames.length > 0 && (
          <div style={{ marginTop: 6, color: "#64748b" }}>{zoneNames.join(" · ")}</div>
        )}
      </div>
    </div>
  );
}

// ─── Settings → Location card ───────────────────────────────────────────────
// Only sun-relative triggers need this, so it says so rather than looking like
// a mandatory setup step.

// Four ways in, because "type your latitude" is an expert-only ask. All of them
// converge on the same onChange(lat,lng) → POST /api/location. No geocoding API is
// used anywhere: ZIP and city resolve against the offline tables in
// location-data.js, so this works with no internet and no API key.
const LOCATION_METHODS = [
  { id: "auto", label: "Use my location" },
  { id: "zip", label: "US ZIP code" },
  { id: "city", label: "Nearest city" },
  { id: "maps", label: "Google Maps" },
];

function LocationCard({ location, onChange, isMobile }) {
  const [method, setMethod] = useState("auto");
  const [status, setStatus] = useState(null);
  const [zip, setZip] = useState("");
  const [city, setCity] = useState("");
  const [paste, setPaste] = useState("");

  const has = location?.lat != null && location?.lng != null;

  const commit = (la, ln, note) => {
    onChange(Number(la.toFixed(5)), Number(ln.toFixed(5)));
    setStatus(note || "Saved.");
  };

  const locate = () => {
    if (!navigator.geolocation) { setStatus("This browser can't share a location."); return; }
    setStatus("Locating…");
    navigator.geolocation.getCurrentPosition(
      (pos) => commit(pos.coords.latitude, pos.coords.longitude, "Saved from your device."),
      () => setStatus("Couldn't get your location — try one of the other options."),
      { timeout: 10000 },
    );
  };

  // ZIP resolves on the 3-digit prefix (see location-data.js): accurate to the
  // ZIP region, which is far tighter than sunrise/sunset needs.
  const applyZip = () => {
    const digits = (zip || "").replace(/\D/g, "");
    if (digits.length < 3) { setStatus("Enter at least the first 3 digits of a US ZIP."); return; }
    const hit = typeof ZIP3_COORDS !== "undefined" ? ZIP3_COORDS[digits.slice(0, 3)] : null;
    if (!hit) { setStatus(`No match for ZIP ${digits} — try the city list.`); return; }
    commit(hit[0], hit[1], `Set to the ${digits.slice(0, 3)}xx area.`);
  };

  const applyCity = (value) => {
    setCity(value);
    const idx = Number(value);
    const row = typeof WORLD_CITIES !== "undefined" ? WORLD_CITIES[idx] : null;
    if (!row) return;
    commit(row[2], row[3], `Set to ${row[1]}.`);
  };

  // Accepts what Google Maps actually puts on the clipboard: "41.878, -87.629".
  const applyPaste = () => {
    const m = (paste || "").match(/(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)/);
    if (!m) { setStatus("Paste coordinates like  41.878, -87.629"); return; }
    const la = Number(m[1]), ln = Number(m[2]);
    if (!isFinite(la) || !isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) {
      setStatus("Those numbers aren't a valid latitude/longitude.");
      return;
    }
    commit(la, ln);
  };

  const field = {
    padding: "8px 10px", borderRadius: 8, border: "1px solid #334155",
    background: "#0f172a", color: "#e2e8f0", fontSize: 13, width: "100%",
  };
  const tab = (active) => ({
    padding: isMobile ? "7px 10px" : "7px 14px", borderRadius: 8,
    border: active ? "1px solid #6366f1" : "1px solid #334155",
    background: active ? "rgba(99,102,241,0.18)" : "transparent",
    color: active ? "#c7d2fe" : "#94a3b8",
    fontSize: isMobile ? 11 : 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
  });
  const primaryBtn = {
    padding: "8px 16px", borderRadius: 8, border: "none",
    background: "#6366f1", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer",
  };

  // Group the city list by country for a scannable <optgroup> select.
  const cityGroups = [];
  if (typeof WORLD_CITIES !== "undefined") {
    WORLD_CITIES.forEach((row, i) => {
      const last = cityGroups[cityGroups.length - 1];
      if (last && last.country === row[0]) last.items.push([i, row[1]]);
      else cityGroups.push({ country: row[0], items: [[i, row[1]]] });
    });
  }

  return (
    <div style={{
      background: "#1e293b", borderRadius: 16, padding: isMobile ? 14 : 20,
      marginBottom: 16, border: "1px solid #334155",
    }}>
      <div style={{ fontSize: isMobile ? 15 : 17, fontWeight: 700, color: "#e2e8f0", marginBottom: 4 }}>
        Location
      </div>
      <div style={{ fontSize: 12, color: "#64748b", marginBottom: 12, lineHeight: 1.6 }}>
        Used only to compute sunrise and sunset for sun-relative schedules. It stays on
        your hub — nothing is sent anywhere. Rough is fine: being a few miles off moves
        sunset by well under a minute.
      </div>

      {/* Current value — the card should answer "is this set?" at a glance. */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
        padding: "8px 12px", borderRadius: 10, marginBottom: 14,
        background: has ? "rgba(52,211,153,0.10)" : "rgba(251,191,36,0.10)",
        border: `1px solid ${has ? "#047857" : "#b45309"}`,
      }}>
        <span style={{ fontSize: 12, color: has ? "#6ee7b7" : "#fcd34d", fontWeight: 600 }}>
          {has ? `Set to ${location.lat}, ${location.lng}` : "Not set — sun schedules won't fire"}
        </span>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        {LOCATION_METHODS.map(m => (
          <button key={m.id} style={tab(method === m.id)}
            onClick={() => { setMethod(m.id); setStatus(null); }}>{m.label}</button>
        ))}
      </div>

      {method === "auto" && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button onClick={locate} style={primaryBtn}>📍 Use my location</button>
          <span style={{ fontSize: 11, color: "#64748b" }}>
            Asks the browser for this device's position.
          </span>
        </div>
      )}

      {method === "zip" && (
        <div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div style={{ flex: "1 1 160px" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8", marginBottom: 6 }}>US ZIP code</div>
              <input value={zip} inputMode="numeric" maxLength={10}
                onChange={e => { setZip(e.target.value); setStatus(null); }}
                onKeyDown={e => { if (e.key === "Enter") applyZip(); }}
                placeholder="60601" style={field} />
            </div>
            <button onClick={applyZip} style={primaryBtn}>Use this ZIP</button>
          </div>
          <div style={{ fontSize: 11, color: "#64748b", marginTop: 8, lineHeight: 1.6 }}>
            Resolved offline from the ZIP's region — accurate to within a few miles, which
            is plenty for sunrise and sunset.
          </div>
        </div>
      )}

      {method === "city" && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8", marginBottom: 6 }}>Nearest city</div>
          <select value={city} onChange={e => applyCity(e.target.value)} style={field}>
            <option value="">Pick the closest city…</option>
            {cityGroups.map(g => (
              <optgroup key={g.country} label={g.country}>
                {g.items.map(([i, name]) => <option key={i} value={i}>{name}</option>)}
              </optgroup>
            ))}
          </select>
          <div style={{ fontSize: 11, color: "#64748b", marginTop: 8, lineHeight: 1.6 }}>
            Not exhaustive — if your city isn't listed, pick the nearest one or use the
            Google Maps option.
          </div>
        </div>
      )}

      {method === "maps" && (
        <div>
          <div style={{ fontSize: 12, color: "#cbd5e1", lineHeight: 1.7, marginBottom: 10 }}>
            <a href="https://www.google.com/maps" target="_blank" rel="noopener noreferrer"
              style={{ color: "#a5b4fc", fontWeight: 700 }}>Open Google Maps ↗</a>
            <div style={{ marginTop: 8, color: "#94a3b8" }}>
              <div>1. Find your home on the map.</div>
              <div>2. <strong>Right-click it</strong> (long-press on a phone).</div>
              <div>3. The first item in the menu <em>is</em> the latitude and longitude — click it to copy.</div>
              <div>4. Paste it below.</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div style={{ flex: "1 1 200px" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8", marginBottom: 6 }}>
                Pasted coordinates
              </div>
              <input value={paste}
                onChange={e => { setPaste(e.target.value); setStatus(null); }}
                onKeyDown={e => { if (e.key === "Enter") applyPaste(); }}
                placeholder="41.878, -87.629" style={field} />
            </div>
            <button onClick={applyPaste} style={primaryBtn}>Use these</button>
          </div>
        </div>
      )}

      {status && (
        <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 12 }}>{status}</div>
      )}
    </div>
  );
}
