// LightshowPanel — a room's ambient lightshow (v3.39.0).
//
// The show runs on the PI, not here: this panel only edits a config object and
// reads back a status. That is deliberate and it's the whole point — you set a
// room walking and close the browser, and it keeps walking. Everything the panel
// shows about a running show (step, palette, next-step countdown) comes from
// GET /api/lightshow, refreshed by the `lightshow` SSE event the loop emits at
// the end of every frame.
//
// Two things this UI has to be honest about, because the hardware isn't gentle
// about them:
//   1. SPEED. A cloud_v2 segment call costs ~1.8s and the rate limit is
//      per-account, so a room full of segments cannot step every 5 seconds. The
//      backend computes a floor from the actual cell composition and the panel
//      SHOWS it ("a step takes ~13s here"), rather than quietly ignoring the
//      number you dragged the slider to.
//   2. SEGMENTS. "Use segments" is a room-level NARROWING, not a second opinion:
//      on, each device is addressed the way the Scenes panel already addresses
//      it (govee_scene_address); off, every device in the room is one color.
//      A per-device switch here could only disagree with that one.
//
// The pattern catalog (names + blurbs) is served by the backend rather than
// duplicated here, so the description you read is the one the math implements.

const LIGHTSHOW_SOURCES = [
  { key: "palettes", label: "Palettes" },
  { key: "favorites", label: "My colors" },
  { key: "custom", label: "Custom" },
];

// Options each pattern actually uses. Rendering the full set for every pattern
// would put a "Rest brightness" slider under Walk, which does nothing with it.
function lightshowOptsFor(patterns, key) {
  return (patterns || []).find(p => p.key === key)?.opts || [];
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
  return <span>next in {left}s</span>;
}

function LightshowPanel({ roomName, show, patterns, devices, favorites,
                          onFavoritesChange, onSave, onStep, isMobile }) {
  const s = show || {};
  const pattern = s.pattern || "walk";
  const opts = lightshowOptsFor(patterns, pattern);
  const [paletteFilter, setPaletteFilter] = useState("Featured");
  const [paletteSearch, setPaletteSearch] = useState("");
  const [showLights, setShowLights] = useState(false);

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

  const filtered = (typeof palettesFor === "function" ? palettesFor(paletteFilter) : [])
    .filter(p => !paletteSearch
      || p.name.toLowerCase().includes(paletteSearch.toLowerCase()));

  const colorCount = (s.colors || []).length;
  const ready = s.source === "palettes" ? selected.length > 0
    : s.source === "custom" ? colorCount >= 2 : true;

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
              {s.cells || 0} {s.cells === 1 ? "light" : "lights"}
              {s.segment_cells > 0 && <> ({s.segment_cells} segments)</>}
              {" · "}every {s.effective_interval_s}s
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
          {(patterns || []).map(p => {
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
                  {p.blurb}
                </div>
              </button>
            );
          })}
        </div>

        {/* Per-pattern options. Only what this pattern reads. */}
        {opts.includes("direction") && (
          <div style={{ display: "flex", gap: 6, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>Direction</span>
            {["forward", "backward", "bounce"].map(d => (
              <button key={d} onClick={() => onSave({ direction: d })}
                style={chip((s.direction || "forward") === d)}>{d}</button>
            ))}
          </div>
        )}
        {opts.includes("groups") && (
          <div style={{ display: "flex", gap: 6, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>Take turns in</span>
            {[2, 3, 4].map(g => (
              <button key={g} onClick={() => onSave({ groups: g })}
                style={chip((s.groups || 2) === g)}>{g} groups</button>
            ))}
          </div>
        )}
        {opts.includes("rest") && (
          <div style={{ marginTop: 12 }}>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>Resting lights</span>
              {[["dim", "dim"], ["off", "off"]].map(([k, label]) => (
                <button key={k} onClick={() => onSave({ rest: k })}
                  style={chip((s.rest || "dim") === k)}>{label}</button>
              ))}
            </div>
            {(s.rest || "dim") === "dim" && (
              <div style={{ marginTop: 10 }}>
                <Slider label={`Rest brightness · ${s.rest_pct ?? 15}%`} value={s.rest_pct ?? 15}
                  min={1} max={80} onChange={(v) => saveSoon({ rest_pct: v })} />
              </div>
            )}
          </div>
        )}
        {opts.includes("swaps") && (
          <div style={{ display: "flex", gap: 6, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>Pairs per step</span>
            {[1, 2, 3].map(n => (
              <button key={n} onClick={() => onSave({ swaps: n })}
                style={chip((s.swaps || 2) === n)}>{n}</button>
            ))}
          </div>
        )}
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
                : "One of these is drawn when the show starts and held for the run."}
              {selected.length > 0 && <> <b style={{ color: "#c4b5fd" }}>{selected.length} selected.</b></>}
            </div>
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
            {/* Bulk add/remove for the whole filter, the same gesture the
                scheduler's palette editor uses — "Summer and Winter" and
                "Summer minus three" should not be different kinds of work. */}
            <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
              <button onClick={() => onSave({
                palettes: Array.from(new Set([...selected, ...filtered.map(p => p.name)])),
              })} style={{ ...chip(false), padding: "4px 8px", fontSize: 10 }}>+ Add all shown</button>
              <button onClick={() => onSave({
                palettes: selected.filter(n => !filtered.some(p => p.name === n)),
              })} style={{ ...chip(false), padding: "4px 8px", fontSize: 10 }}>− Remove shown</button>
            </div>
            <div style={{ maxHeight: 260, overflowY: "auto", display: "grid", gap: 5 }}>
              {filtered.map(p => {
                const on = selected.includes(p.name);
                return (
                  <button key={p.name} onClick={() => togglePalette(p.name)} style={{
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

      {/* ── Timing + brightness ─────────────────────────────────────────── */}
      <div style={card}>
        <div style={heading}>Timing</div>
        <Slider
          label={`Step every ${s.effective_interval_s ?? s.interval_s}s`}
          value={s.interval_s ?? 30} min={10} max={300}
          onChange={(v) => saveSoon({ interval_s: v })}
        />
        <div style={{ fontSize: 11, color: "#64748b", marginTop: 6, lineHeight: 1.5 }}>
          A step takes about <b style={{ color: "#94a3b8" }}>{s.step_seconds}s</b> to paint here
          {s.segment_cells > 0 && " (segments go one color at a time — the Govee rate limit, not us)"},
          so this room can't step faster than every {s.min_interval_s}s.
          {(s.interval_s ?? 30) < (s.min_interval_s ?? 10) && (
            <> <b style={{ color: "#fbbf24" }}>Using {s.effective_interval_s}s.</b></>
          )}
        </div>
        <div style={{ marginTop: 14 }}>
          <Slider label={`Brightness ${s.brightness ?? 80}%`} value={s.brightness ?? 80}
            min={1} max={100} onChange={(v) => saveSoon({ brightness: v })} />
        </div>
      </div>

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
    </div>
  );
}
