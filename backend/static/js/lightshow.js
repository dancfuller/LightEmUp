// LightshowPanel — a room's ambient lightshow (v3.39.0).
//
// The show runs on the PI, not here: this panel only edits a config object and
// reads back a status. That is deliberate and it's the whole point — you set a
// room walking and close the browser, and it keeps walking. Everything the panel
// shows about a running show (step, palette, next-step countdown) comes from
// GET /api/lightshow, refreshed by the `lightshow` SSE event the loop emits at
// the end of every frame.
//
// Three things this UI has to be honest about, because neither the hardware nor
// the rooms are gentle about them:
//   1. SPEED. A cloud_v2 segment call costs ~1.8s and the rate limit is
//      per-account, so a room full of segments cannot step every 5 seconds. The
//      backend computes a floor from the actual cell composition and the panel
//      SHOWS it ("a step takes ~13s here"), rather than quietly ignoring the
//      number you dragged the slider to.
//   2. SEGMENTS. "Use segments" is a room-level NARROWING, not a second opinion:
//      on, each device is addressed the way the Scenes panel already addresses
//      it (govee_scene_address); off, every device in the room is one color.
//      A per-device switch here could only disagree with that one.
//   3. GEOMETRY. A room laid out as a LINE and one laid out as a FLOOR PLAN are
//      different spaces, and the backend offers each the patterns that actually
//      read well there (`show.geometry` + `show.patterns`). The panel never
//      invents that list — it renders what the Pi says this room may run, so the
//      editor can't offer something the API would refuse.
//
// The pattern catalog (names + blurbs) is served by the backend rather than
// duplicated here, so the description you read is the one the math implements.

const LIGHTSHOW_SOURCES = [
  { key: "palettes", label: "Palettes" },
  { key: "favorites", label: "My colors" },
  { key: "custom", label: "Custom" },
];

// Every interval the slider can land on, 10 seconds to an hour. A plain linear
// 10-3600 slider is unusable (a pixel is 12 seconds at the top end) and a
// 10-300 one can't express "change it every half hour", which is a perfectly
// reasonable ask for something this ambient. Stepping through named values gives
// fine control where it matters and reach where it doesn't.
const LIGHTSHOW_INTERVALS = [10, 15, 20, 30, 45, 60, 90, 120, 180, 300, 450,
                             600, 900, 1200, 1800, 2700, 3600];

function humanInterval(s) {
  s = Number(s) || 0;
  if (s < 60) return `${s}s`;
  if (s % 3600 === 0) return `${s / 3600}h`;
  if (s % 60 === 0) return `${s / 60}m`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function nearestIntervalIndex(seconds) {
  let best = 0;
  LIGHTSHOW_INTERVALS.forEach((v, i) => {
    if (Math.abs(v - seconds) < Math.abs(LIGHTSHOW_INTERVALS[best] - seconds)) best = i;
  });
  return best;
}

// Axis labels are per PATTERN, because one stored value means a different thing
// depending on what reads it: for a Walk or a Sweep it's the direction of
// travel, for Alternate it's the shape of the grouping. One key, honest names.
const LIGHTSHOW_AXES = {
  alternate: [["diag", "checkerboard"], ["x", "columns"], ["y", "rows"]],
  _default: [["x", "left → right"], ["y", "front → back"], ["diag", "diagonal"]],
};
// Mirrors lightshow.default_axis on the Pi: absent means "whatever suits this
// pattern", so the chip we highlight has to resolve it the same way.
const LIGHTSHOW_AXIS_DEFAULT = { alternate: "diag" };

// Role-order helpers. `order` is a list of indices into the palette; index 0 is
// the background. Kept pure and tiny so the editor stays declarative.
function promoteColor(order, i) {
  // Tapping a swatch makes it the background, bringing it back in if it was out.
  return [i, ...order.filter(x => x !== i)];
}

function toggleColor(order, i) {
  if (!order.includes(i)) return [...order, i];
  // Never narrow below two: one color is a solid room, not a lightshow.
  return order.length <= 2 ? order : order.filter(x => x !== i);
}

function shuffleOrder(order) {
  const a = [...order];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function lightshowPattern(patterns, key) {
  return (patterns || []).find(p => p.key === key) || null;
}

function LightshowCountdown({ nextAt, running }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running || !nextAt) return;
    const t = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [running, nextAt]);
  if (!running || !nextAt) return null;
  const left = Math.max(0, Math.round((nextAt - Date.now()) / 1000));
  return <span>next in {humanInterval(left)}</span>;
}

function LightshowPanel({ roomName, show, patterns, devices, favorites,
                          onFavoritesChange, onSave, onStep, isMobile }) {
  const s = show || {};
  const geometry = s.geometry || "none";
  const isPlan = geometry === "plan";
  // The Pi decides which patterns this room's layout can actually run; never
  // widen it here, or the editor offers something POST will reject.
  const allowed = Array.isArray(s.patterns) ? s.patterns : null;
  const shownPatterns = (patterns || []).filter(p => !allowed || allowed.includes(p.key));
  const pattern = s.effective_pattern || s.pattern || "walk";
  const opts = lightshowPattern(patterns, pattern)?.opts || [];
  const [paletteFilter, setPaletteFilter] = useState("Featured");
  const [paletteSearch, setPaletteSearch] = useState("");
  const [showLights, setShowLights] = useState(false);
  // ONE palette is the overwhelmingly normal case — you pick a look and run a
  // pattern over it. The multi-select the panel shipped with put the rare case
  // (draw a different one at random each run) in everyone's way, so it's now
  // opt-in. Palette hop is the exception: drawing from a set IS the pattern.
  const multiPalettes = pattern === "hop" || (s.palettes || []).length > 1;
  const [multiOpen, setMultiOpen] = useState(false);
  const multi = multiPalettes || multiOpen;

  // Sliders auto-save like every other setting in this app (no Save button
  // anywhere), but a drag fires dozens of changes — debounce so a 30-second
  // interval isn't saved 40 times on the way there.
  const saveTimer = useRef(null);
  useEffect(() => () => clearTimeout(saveTimer.current), []);
  const saveSoon = (patch) => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => onSave(patch), 500);
  };

  const selected = s.palettes || [];
  const togglePalette = (name) => {
    const next = selected.includes(name)
      ? selected.filter(n => n !== name)
      : [...selected, name];
    onSave({ palettes: next });
  };

  const excluded = s.exclude || [];
  const toggleDevice = (key) => {
    onSave({
      exclude: excluded.includes(key)
        ? excluded.filter(k => k !== key)
        : [...excluded, key],
    });
  };

  const pad = isMobile ? 12 : 16;
  const card = {
    background: "#0f172a", border: "1px solid #1e293b", borderRadius: 12,
    padding: pad, marginBottom: 14,
  };
  const heading = {
    fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase",
    color: "#64748b", marginBottom: 10,
  };
  const chip = (active, accent = "#a78bfa") => ({
    padding: isMobile ? "6px 10px" : "6px 12px", borderRadius: 8, cursor: "pointer",
    border: `1px solid ${active ? accent : "#334155"}`,
    background: active ? "rgba(167,139,250,0.16)" : "transparent",
    color: active ? accent : "#94a3b8",
    fontSize: isMobile ? 11 : 12, fontWeight: 700, whiteSpace: "nowrap",
  });
  const optRow = (label, children) => (
    <div style={{ display: "flex", gap: 6, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
      <span style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>{label}</span>
      {children}
    </div>
  );

  const filtered = (typeof palettesFor === "function" ? palettesFor(paletteFilter) : [])
    .filter(p => !paletteSearch
      || p.name.toLowerCase().includes(paletteSearch.toLowerCase()));

  const colorCount = (s.colors || []).length;
  const ready = s.source === "palettes" ? selected.length > 0
    : s.source === "custom" ? colorCount >= 2 : true;

  const axisChoices = LIGHTSHOW_AXES[pattern] || LIGHTSHOW_AXES._default;
  const axisValue = s.axis || LIGHTSHOW_AXIS_DEFAULT[pattern] || "x";
  const intervalIdx = nearestIntervalIndex(s.interval_s ?? 30);
  // The role order, always as an explicit index list so the editor has one shape
  // to reason about: an empty stored order means "the palette as it comes".
  const paletteLen = (s.palette_colors || []).length;
  const orderList = (s.color_order || []).length
    ? s.color_order.filter(i => i >= 0 && i < paletteLen)
    : Array.from({ length: paletteLen }, (_, i) => i);
  // The catalog stores role names lowercase ("background", "accent"); the panel
  // starts sentences with them.
  const roleWords = (lightshowPattern(patterns, pattern)?.roles || ["background", "accent"])
    .map(w => w.charAt(0).toUpperCase() + w.slice(1));
  const geometryLabel = isPlan ? "Floor plan"
    : geometry === "line" ? "Line layout" : "No layout";

  return (
    <div>
      {/* ── Run/stop + what it's doing right now ───────────────────────── */}
      <div style={{ ...card, borderColor: s.running ? "#a78bfa" : "#1e293b" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <button
            onClick={() => onSave({ enabled: !s.enabled })}
            disabled={!s.enabled && !ready}
            title={ready ? "" : "Pick some colors first"}
            style={{
              padding: isMobile ? "9px 16px" : "10px 20px", borderRadius: 10,
              border: "none", cursor: (!s.enabled && !ready) ? "default" : "pointer",
              background: s.enabled ? "#a78bfa" : (ready ? "#312e81" : "#1e293b"),
              color: s.enabled ? "#1e1b4b" : (ready ? "#c7d2fe" : "#475569"),
              fontSize: isMobile ? 13 : 14, fontWeight: 800, whiteSpace: "nowrap",
            }}
          >{s.enabled ? "Stop lightshow" : "Start lightshow"}</button>
          <div style={{ flex: "1 1 160px", minWidth: 0 }}>
            <div style={{ fontSize: isMobile ? 12 : 13, color: s.running ? "#e2e8f0" : "#64748b", fontWeight: 600 }}>
              {s.running
                ? <>Running · {s.palette} · step {(s.step ?? 0) + 1}</>
                : (ready ? "Not running" : "Pick some colors below")}
            </div>
            <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>
              {geometryLabel} · {s.cells || 0} {s.cells === 1 ? "light" : "lights"}
              {s.segment_cells > 0 && <> ({s.segment_cells} segments)</>}
              {" · "}every {humanInterval(s.effective_interval_s)}
              {s.running && <> · <LightshowCountdown nextAt={s.next_at} running={s.running} /></>}
            </div>
          </div>
          {s.running && (
            <button onClick={onStep} style={chip(false, "#94a3b8")}>Next step ▸</button>
          )}
        </div>
      </div>

      {/* ── Pattern ─────────────────────────────────────────────────────── */}
      <div style={card}>
        <div style={heading}>Pattern</div>
        <div style={{
          display: "grid", gap: 8,
          gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fill, minmax(168px, 1fr))",
        }}>
          {shownPatterns.map(p => {
            const active = p.key === pattern;
            return (
              <button key={p.key} onClick={() => onSave({ pattern: p.key })} style={{
                textAlign: "left", padding: 10, borderRadius: 10, cursor: "pointer",
                border: `1px solid ${active ? "#a78bfa" : "#1e293b"}`,
                background: active ? "rgba(167,139,250,0.12)" : "#0a0f1e",
              }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: active ? "#c4b5fd" : "#e2e8f0" }}>
                  {p.name}
                </div>
                <div style={{ fontSize: 11, color: "#64748b", marginTop: 3, lineHeight: 1.4 }}>
                  {/* A pattern can read differently in 2D — Walk is a sliding
                      cycle along a strip but marching stripes across a room. */}
                  {(isPlan && p.plan_blurb) || p.blurb}
                </div>
              </button>
            );
          })}
        </div>

        {/* Why the list is the length it is. Naming the layout is what makes a
            shorter set read as deliberate rather than as something missing. */}
        {geometry === "none" ? (
          <div style={{
            marginTop: 12, padding: 10, borderRadius: 8, background: "#0a0f1e",
            border: "1px solid #334155", fontSize: 11, color: "#94a3b8", lineHeight: 1.5,
          }}>
            This room has no layout yet, so only the patterns that don't need to know
            where a light <i>is</i> are available. Arrange it in{" "}
            <b style={{ color: "#c4b5fd" }}>Room Map</b> to unlock the rest — a line
            gains Wipe and Comet, a floor plan gains Ripple and Sweep.
          </div>
        ) : (
          <div style={{ marginTop: 10, fontSize: 11, color: "#64748b", lineHeight: 1.5 }}>
            {isPlan
              ? "Laid out as a floor plan, so patterns run across real coordinates and this room gets the two-dimensional ones."
              : "Laid out as a line, so patterns run along the strip and this room gets the ones that need a direction to travel."}
          </div>
        )}

        {/* Per-pattern options. Only what this pattern reads — a rest-brightness
            slider under Walk, which never looks at it, is worse than none. */}
        {opts.includes("direction") && optRow("Direction",
          (pattern === "ripple" ? [["forward", "outward"], ["backward", "inward"]]
           : pattern === "wipe" ? [["forward", "from the start"], ["backward", "from the end"]]
           : [["forward", "forward"], ["backward", "backward"], ["bounce", "bounce"]]
          ).map(([k, label]) => (
            <button key={k} onClick={() => onSave({ direction: k })}
              style={chip((s.direction || "forward") === k)}>{label}</button>
          )))}

        {/* Axis is a floor-plan question: a line has only one. */}
        {opts.includes("axis") && isPlan && optRow(
          pattern === "alternate" ? "Grouping" : "Across",
          axisChoices.map(([k, label]) => (
            <button key={k} onClick={() => onSave({ axis: k })}
              style={chip(axisValue === k)}>{label}</button>
          )))}

        {opts.includes("groups") && optRow("Take turns in",
          [2, 3, 4].map(g => (
            <button key={g} onClick={() => onSave({ groups: g })}
              style={chip((s.groups || 2) === g)}>{g} groups</button>
          )))}

        {opts.includes("swaps") && optRow("Pairs per step",
          [1, 2, 3].map(n => (
            <button key={n} onClick={() => onSave({ swaps: n })}
              style={chip((s.swaps || 2) === n)}>{n}</button>
          )))}

        {opts.includes("tail") && optRow("Tail length",
          [1, 2, 3, 4, 6].map(n => (
            <button key={n} onClick={() => onSave({ tail: n })}
              style={chip((s.tail || 3) === n)}>{n}</button>
          )))}

        {opts.includes("band") && optRow("Band width",
          [1, 2, 3, 4].map(n => (
            <button key={n} onClick={() => onSave({ band: n })}
              style={chip((s.band || 2) === n)}>{n}</button>
          )))}

        {opts.includes("rest") && optRow("Resting lights",
          [["dim", "dim"], ["off", "off"]].map(([k, label]) => (
            <button key={k} onClick={() => onSave({ rest: k })}
              style={chip((s.rest || "dim") === k)}>{label}</button>
          )))}

        {opts.includes("rest_pct") && (s.rest || "dim") === "dim" && (
          <div style={{ marginTop: 12 }}>
            <Slider label={opts.includes("rest") ? "Rest brightness" : "Base brightness"}
              value={s.rest_pct ?? 15} min={1} max={80} unit="%"
              onChange={(v) => saveSoon({ rest_pct: v })} />
          </div>
        )}
      </div>

      {/* ── Timing ────────────────────────────────────────────────────────
          Directly under Pattern rather than buried at the bottom: how often it
          moves is half of what a lightshow IS, and it's the setting people reach
          for second. The scale is stepped (see LIGHTSHOW_INTERVALS) so it can
          reach an hour without a slider where one pixel is twelve seconds. */}
      <div style={card}>
        <div style={heading}>Timing</div>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
          <span style={{ fontSize: 12, color: "#94a3b8", fontWeight: 500 }}>Change colors every</span>
          <span style={{ fontSize: 13, color: "#e2e8f0", fontWeight: 700 }}>
            {humanInterval(LIGHTSHOW_INTERVALS[intervalIdx])}
          </span>
        </div>
        <input
          type="range" min={0} max={LIGHTSHOW_INTERVALS.length - 1} step={1}
          value={intervalIdx}
          onChange={(e) => saveSoon({ interval_s: LIGHTSHOW_INTERVALS[Number(e.target.value)] })}
          style={{ width: "100%", accentColor: "#a78bfa", touchAction: "pan-y" }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#475569" }}>
          <span>10s</span><span>1m</span><span>5m</span><span>1h</span>
        </div>
        <div style={{ fontSize: 11, color: "#64748b", marginTop: 8, lineHeight: 1.5 }}>
          A step takes about <b style={{ color: "#94a3b8" }}>{s.step_seconds}s</b> to paint here
          {s.segment_cells > 0 && " (segments go one color at a time — the Govee rate limit, not us)"},
          so this room can't step faster than every {humanInterval(s.min_interval_s)}.
          {(s.interval_s ?? 30) < (s.min_interval_s ?? 10) && (
            <> <b style={{ color: "#fbbf24" }}>Using {humanInterval(s.effective_interval_s)}.</b></>
          )}
        </div>
        {/* What this show costs the HARDWARE, stated rather than discovered.
            A Hue command is a Zigbee transmission and a bulb NVRAM write, and a
            show left running overnight quietly did ~900 writes to an outdoor bulb
            against a house-wide baseline of a few dozen a day — after which
            scenes stopped applying to every light. The number belongs on screen. */}
        {s.hue_cells > 0 && (
          <div style={{
            fontSize: 11, marginTop: 8, padding: "8px 10px", borderRadius: 8,
            lineHeight: 1.5,
            background: s.writes_per_light_per_day > 900 ? "rgba(251,191,36,0.08)" : "#0a0f1e",
            border: `1px solid ${s.writes_per_light_per_day > 900 ? "#78350f" : "#1e293b"}`,
            color: s.writes_per_light_per_day > 900 ? "#fbbf24" : "#64748b",
          }}>
            Left running all day this changes each of the {s.hue_cells} Hue{" "}
            {s.hue_cells === 1 ? "bulb" : "bulbs"} up to{" "}
            <b>{s.writes_per_light_per_day.toLocaleString()}</b> times.
            {s.writes_per_light_per_day > 900
              ? " That is a lot of Zigbee traffic for one room — a longer interval is kinder to the mesh, and to the other lights sharing it."
              : " Every change is a radio message on the mesh your other lights share."}
          </div>
        )}
        <div style={{ marginTop: 14 }}>
          <Slider label="Brightness" value={s.brightness ?? 80} min={1} max={100} unit="%"
            onChange={(v) => saveSoon({ brightness: v })} />
        </div>
      </div>

      {/* ── Colors ──────────────────────────────────────────────────────── */}
      <div style={card}>
        <div style={heading}>Colors</div>
        <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
          {LIGHTSHOW_SOURCES.map(src => (
            <button key={src.key} onClick={() => onSave({ source: src.key })}
              style={chip((s.source || "palettes") === src.key)}>{src.label}</button>
          ))}
        </div>

        {(s.source || "palettes") === "palettes" && (
          <>
            <div style={{ fontSize: 11, color: "#64748b", marginBottom: 8, lineHeight: 1.5 }}>
              {pattern === "hop"
                ? "Palette hop draws a different one of these every step — pick several."
                : multi
                  ? "One of these is drawn at random when the show starts, and held for the run."
                  : "Pick the palette this show runs on."}
              {multi && selected.length > 0 && (
                <> <b style={{ color: "#c4b5fd" }}>{selected.length} selected.</b></>
              )}
            </div>
            {/* The chosen palette stays on screen even while you browse a
                different category. Without this, picking Galaxy and then tapping
                "Featured" leaves nothing selected-looking anywhere — the list is
                filtered, so the one row that would have shown the ✓ is gone. */}
            {!multi && selected.length > 0 && (
              <div style={{
                display: "flex", alignItems: "center", gap: 8, marginBottom: 10,
                padding: "7px 9px", borderRadius: 8,
                background: "rgba(167,139,250,0.12)", border: "1px solid #a78bfa",
              }}>
                <span style={{ fontSize: 12, color: "#c4b5fd", fontWeight: 700 }}>✓</span>
                <span style={{ flex: "1 1 auto", fontSize: 12, color: "#e2e8f0", minWidth: 0 }}>
                  {selected[0]}
                </span>
                <span style={{ width: 84, flexShrink: 0 }}>
                  <PaletteStrip colors={(s.palette_colors || []).map(
                    c => ({ r: c[0], g: c[1], b: c[2] }))} height={10} />
                </span>
              </div>
            )}
            <input value={paletteSearch} onChange={e => setPaletteSearch(e.target.value)}
              placeholder="Search palettes…"
              style={{
                width: "100%", padding: "8px 10px", borderRadius: 8, marginBottom: 8,
                border: "1px solid #334155", background: "#0a0f1e", color: "#e2e8f0",
                fontSize: 12, boxSizing: "border-box",
              }} />
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 10 }}>
              {(typeof PALETTE_FILTERS !== "undefined" ? PALETTE_FILTERS : []).map(f => (
                <button key={f} onClick={() => setPaletteFilter(f)} style={{
                  ...chip(paletteFilter === f, "#34d399"),
                  padding: "4px 8px", fontSize: 10,
                }}>{f}</button>
              ))}
            </div>
            {/* Bulk add/remove only exists in multi mode, where "Summer and
                Winter" and "Summer minus three" should be the same gesture. In
                single mode it would just be a way to break the selection. */}
            {multi && (
              <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
                <button onClick={() => onSave({
                  palettes: Array.from(new Set([...selected, ...filtered.map(p => p.name)])),
                })} style={{ ...chip(false), padding: "4px 8px", fontSize: 10 }}>+ Add all shown</button>
                <button onClick={() => onSave({
                  palettes: selected.filter(n => !filtered.some(p => p.name === n)),
                })} style={{ ...chip(false), padding: "4px 8px", fontSize: 10 }}>− Remove shown</button>
              </div>
            )}
            <div style={{ maxHeight: 260, overflowY: "auto", display: "grid", gap: 5 }}>
              {filtered.map(p => {
                const on = selected.includes(p.name);
                return (
                  <button key={p.name}
                    onClick={() => multi ? togglePalette(p.name) : onSave({ palettes: [p.name] })}
                    style={{
                    display: "flex", alignItems: "center", gap: 8, padding: "6px 8px",
                    borderRadius: 8, cursor: "pointer", textAlign: "left",
                    border: `1px solid ${on ? "#a78bfa" : "#1e293b"}`,
                    background: on ? "rgba(167,139,250,0.12)" : "#0a0f1e",
                  }}>
                    <span style={{ fontSize: 12, color: on ? "#c4b5fd" : "#64748b", width: 12 }}>
                      {on ? "✓" : ""}
                    </span>
                    <span style={{ flex: "1 1 auto", fontSize: 12, color: "#e2e8f0", minWidth: 0 }}>
                      {p.name}
                    </span>
                    <span style={{ width: 84, flexShrink: 0 }}>
                      <PaletteStrip colors={p.colors} height={10} />
                    </span>
                  </button>
                );
              })}
            </div>
            {pattern !== "hop" && (
              <button onClick={() => {
                if (multi) onSave({ palettes: selected.slice(0, 1) });
                setMultiOpen(!multi);
              }} style={{
                background: "none", border: "none", padding: "8px 0 0", cursor: "pointer",
                color: "#64748b", fontSize: 11, textDecoration: "underline",
              }}>
                {multi
                  ? "Just use one palette"
                  : "Draw from several palettes instead (a different one each run)"}
              </button>
            )}
          </>
        )}

        {s.source === "favorites" && (
          <div>
            <div style={{ fontSize: 11, color: "#64748b", marginBottom: 8, lineHeight: 1.5 }}>
              Your saved colors, straight from the color picker. Edit them there and the
              show follows on its next step.
            </div>
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
              {(favorites || []).map((c, i) => (
                <div key={i} title={rgbToHex(c[0], c[1], c[2])} style={{
                  width: 24, height: 24, borderRadius: 6,
                  background: `rgb(${c[0]},${c[1]},${c[2]})`,
                  border: "1px solid rgba(255,255,255,0.15)",
                }} />
              ))}
            </div>
          </div>
        )}

        {s.source === "custom" && (
          <div>
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 10 }}>
              {(s.colors || []).map((c, i) => (
                <button key={i} title="Remove"
                  onClick={() => onSave({ colors: (s.colors || []).filter((_, j) => j !== i) })}
                  style={{
                    width: 26, height: 26, borderRadius: 6, cursor: "pointer", padding: 0,
                    background: `rgb(${c[0]},${c[1]},${c[2]})`,
                    border: "1px solid rgba(255,255,255,0.15)",
                  }} />
              ))}
              {colorCount === 0 && (
                <span style={{ fontSize: 11, color: "#64748b" }}>
                  No colors yet — pick one below and press Add. Click a swatch to remove it.
                </span>
              )}
            </div>
            <ColorPicker
              size={130} compact={true} favorites={favorites}
              onFavoritesChange={onFavoritesChange}
              sourceLabel={`${roomName} lightshow`}
              stageApply={true} applyLabel="Add color"
              currentColor={{ r: 255, g: 120, b: 40 }}
              onColorSelect={() => {}}
              onApply={(r, g, b) => onSave({ colors: [...(s.colors || []), [r, g, b]] })}
            />
          </div>
        )}
      </div>

      {/* ── Which color does what ───────────────────────────────────────────
          Accent, Comet and Sweep hold the room at ONE color and move a second
          across it, so a six-color palette shows as two at any moment and the
          rest are only reached over a long run. Which two you get was pure luck
          until now. This makes the roles visible and assignable — the palette is
          still the palette, you're just saying which end of it does what. */}
      {s.has_roles && (s.palette_colors || []).length > 1 && (
        <div style={card}>
          <div style={heading}>Color roles</div>
          <div style={{ fontSize: 11, color: "#64748b", marginBottom: 10, lineHeight: 1.5 }}>
            {roleWords[0]} is the color the room holds; {roleWords[1]} is the one that
            travels. Tap a swatch to make it the {roleWords[0].toLowerCase()}, or turn one
            off to keep it out of the show entirely.
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-start" }}>
            {(s.palette_colors || []).map((c, i) => {
              const slot = orderList.indexOf(i);
              const inUse = slot >= 0;
              const isBase = slot === 0;
              return (
                <div key={i} style={{ textAlign: "center", width: 62 }}>
                  <button
                    onClick={() => onSave({ color_order: promoteColor(orderList, i) })}
                    title={inUse ? `Make this the ${roleWords[0].toLowerCase()}` : "Bring this color back in"}
                    style={{
                      width: 46, height: 46, borderRadius: 10, cursor: "pointer", padding: 0,
                      background: `rgb(${c[0]},${c[1]},${c[2]})`,
                      opacity: inUse ? 1 : 0.2,
                      border: isBase ? "3px solid #f8fafc"
                            : inUse ? "1px solid rgba(255,255,255,0.25)"
                            : "1px dashed #475569",
                      boxShadow: isBase ? "0 0 0 2px #a78bfa" : "none",
                    }} />
                  <div style={{
                    fontSize: 9, marginTop: 4, fontWeight: 700, lineHeight: 1.2,
                    color: isBase ? "#c4b5fd" : inUse ? "#64748b" : "#475569",
                  }}>
                    {isBase ? roleWords[0].toUpperCase()
                     : inUse ? roleWords[1].toUpperCase() : "OFF"}
                  </div>
                  <button
                    onClick={() => onSave({ color_order: toggleColor(orderList, i) })}
                    disabled={inUse && orderList.length <= 2}
                    style={{
                      background: "none", border: "none", padding: "2px 0 0",
                      fontSize: 9, color: "#475569",
                      cursor: (inUse && orderList.length <= 2) ? "default" : "pointer",
                      textDecoration: "underline",
                    }}>{inUse ? "remove" : "add"}</button>
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap" }}>
            <button onClick={() => onSave({ color_order: shuffleOrder(orderList) })}
              style={chip(false)}>Shuffle roles</button>
            <button onClick={() => onSave({ color_order: [] })}
              style={chip(false)}>Reset</button>
          </div>
          {orderList.length === 2 && (
            <div style={{ fontSize: 11, color: "#64748b", marginTop: 10, lineHeight: 1.5 }}>
              Two colors — so this is exactly the two-color look, with no rotation.
              Add a third and the {roleWords[1].toLowerCase()} cycles through them.
            </div>
          )}
        </div>
      )}

      {/* ── Which lights ────────────────────────────────────────────────── */}
      <div style={card}>
        <div style={heading}>Lights</div>
        <button onClick={() => onSave({ segments: !(s.segments !== false) })} style={{
          display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left",
          padding: 10, borderRadius: 10, cursor: "pointer", marginBottom: 10,
          border: `1px solid ${s.segments !== false ? "#a78bfa" : "#1e293b"}`,
          background: s.segments !== false ? "rgba(167,139,250,0.12)" : "#0a0f1e",
        }}>
          <span style={{ fontSize: 14, color: s.segments !== false ? "#c4b5fd" : "#475569" }}>
            {s.segments !== false ? "☑" : "☐"}
          </span>
          <span style={{ flex: 1 }}>
            <span style={{ display: "block", fontSize: 12, fontWeight: 700, color: "#e2e8f0" }}>
              Animate segments
            </span>
            <span style={{ display: "block", fontSize: 11, color: "#64748b", marginTop: 2, lineHeight: 1.4 }}>
              {s.segments !== false
                ? "Each device is addressed the way the Scenes panel addresses it. Slower, but the pattern runs along a strip."
                : "Every device is one color. Much faster steps."}
            </span>
          </span>
        </button>

        <button onClick={() => setShowLights(v => !v)} style={{
          background: "none", border: "none", color: "#94a3b8", cursor: "pointer",
          fontSize: 12, fontWeight: 600, padding: 0,
        }}>
          {showLights ? "▾" : "▸"} Leave lights out
          {excluded.length > 0 && <span style={{ color: "#fbbf24" }}> · {excluded.length} left out</span>}
        </button>
        {showLights && (
          <div style={{ display: "grid", gap: 5, marginTop: 10 }}>
            {(devices || []).map(d => {
              const out = excluded.includes(d.key);
              return (
                <button key={d.key} onClick={() => toggleDevice(d.key)} style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "7px 9px",
                  borderRadius: 8, cursor: "pointer", textAlign: "left",
                  border: "1px solid #1e293b", background: out ? "#0a0f1e" : "rgba(167,139,250,0.08)",
                  opacity: out ? 0.55 : 1,
                }}>
                  <span style={{ fontSize: 13, color: out ? "#475569" : "#c4b5fd" }}>
                    {out ? "☐" : "☑"}
                  </span>
                  <span style={{ flex: 1, fontSize: 12, color: "#e2e8f0", minWidth: 0 }}>{d.label}</span>
                  {d.segments > 1 && (
                    <span style={{ fontSize: 10, color: "#64748b" }}>{d.segments} seg</span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
      {/* The primary action, repeated at the END of the panel. On a phone the
          only Start button was at the very top, above patterns, colors, timing,
          roles and lights — so committing meant scrolling all the way back. The
          `sticky` is a bonus where it engages; the guarantee is that this button
          is simply HERE, at the bottom, where you finish reading. */}
      <div style={{
        position: "sticky", bottom: 0, zIndex: 5, marginTop: 4, marginBottom: 4,
        padding: "10px 0 4px",
        background: "linear-gradient(180deg, rgba(10,15,30,0) 0%, #0a0f1e 32%)",
      }}>
        <button
          onClick={() => onSave({ enabled: !s.enabled })}
          disabled={!s.enabled && !ready}
          style={{
            width: "100%", padding: "12px 16px", borderRadius: 10, border: "none",
            cursor: (!s.enabled && !ready) ? "default" : "pointer",
            background: s.enabled ? "#a78bfa" : (ready ? "#4338ca" : "#1e293b"),
            color: s.enabled ? "#1e1b4b" : (ready ? "#e0e7ff" : "#475569"),
            fontSize: 14, fontWeight: 800,
            boxShadow: "0 -2px 14px rgba(2,6,15,0.6)",
          }}
        >{s.enabled ? "Stop lightshow"
          : ready ? `Start lightshow · ${humanInterval(s.effective_interval_s)}`
          : "Pick some colors to start"}</button>
      </div>

    </div>
  );
}
