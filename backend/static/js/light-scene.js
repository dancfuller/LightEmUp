// ─── Per-light scene panel (v3.34.0) ────────────────────────────────────────
// Scenes were a ROOM tool. A segmented light could only be painted one segment
// at a time — tap a panel, open the picker, choose a color, repeat — so making
// a 7-panel hexa a rainbow was minutes of work, and the palette/teams/flags
// libraries sitting right there in the room tool were unreachable for it.
//
// The backend never actually needed a change to fix that: /api/scenes/room-apply
// takes a fully-resolved device payload and only uses `room` as a label and a
// task key. So this file builds the same plan shape for ONE device and sends it
// with a `scope`, which keys the task separately (a hexa scene no longer cancels
// its room's scene) and keeps every room UI out of it.
//
// The maths is deliberately NOT color-mode.js's. A room is a 2D arrangement
// needing an adjacency graph, fixtures, vendor filters and a spatial walk; one
// strip is a 1D run where segment index IS position. That makes gradient and
// beacon meaningful here (the direction is along the strip) while costing a
// fraction of the machinery. Shared pure helpers — orderPaletteForCycle,
// presetColors, generateTonalShades — are reused from the global scope rather
// than copied.

// ROYGBIV, tuned for LEDs rather than pigment. The textbook indigo (#4B0082)
// and violet (#9400D3) are only ~7° apart in hue and both dark, so on a panel
// they read as "one dim purple and another dim purple" — and one band that
// looks nearly off makes the whole thing stop reading as a rainbow. These keep
// the seven named bands but spread them across the hue circle at full
// saturation, which is what a light can actually show.
const ROYGBIV = [
  { r: 255, g: 0,   b: 0   },  // red
  { r: 255, g: 100, b: 0   },  // orange
  { r: 255, g: 220, b: 0   },  // yellow
  { r: 0,   g: 220, b: 40  },  // green
  { r: 0,   g: 90,  b: 255 },  // blue
  { r: 110, g: 40,  b: 255 },  // indigo
  { r: 210, g: 40,  b: 235 },  // violet
];

const LIGHT_SCENE_MODES = [
  { key: "rainbow",  label: "Rainbow" },
  { key: "palette",  label: "Palette" },
  { key: "mine",     label: "My colors" },
  { key: "gradient", label: "Shades" },
  { key: "beacon",   label: "Beacon" },
  { key: "solid",    label: "One color" },
  { key: "teams",    label: "Teams" },
  { key: "ncaa",     label: "College" },
  { key: "flags",    label: "Flags" },
  { key: "restore",  label: "Last colors" },
];

// Direction along the RUN. A strip has a real axis — the segment numbering — so
// these mean exactly what they say, unlike a room where "left to right" needs a
// map to be meaningful.
const STRIP_DIRECTIONS = [
  { key: "forward",    label: "1 → end" },
  { key: "reverse",    label: "end → 1" },
  { key: "center-out", label: "middle → out" },
  { key: "ends-in",    label: "ends → middle" },
];

// rank[i] = where segment i sits along the chosen direction (0 = first).
function stripRanks(n, direction) {
  const idx = Array.from({ length: n }, (_, i) => i);
  const c = (n - 1) / 2;
  let key;
  if (direction === "reverse") key = idx.map(i => n - 1 - i);
  else if (direction === "center-out") key = idx.map(i => Math.abs(i - c));
  else if (direction === "ends-in") key = idx.map(i => -Math.abs(i - c));
  else key = idx.slice();
  const order = idx.slice().sort((a, b) => (key[a] - key[b]) || (a - b));
  const rank = new Array(n);
  order.forEach((seg, r) => { rank[seg] = r; });
  return rank;
}

// Lay a color list down the run as a repeating cycle (ABCABCA). Colors are
// pre-ordered so consecutive positions are perceptually distinct — the same
// reason color-mode.js does it for a linear room layout.
// `preserveOrder` keeps the caller's sequence instead of re-ordering it for
// perceptual contrast. Rainbow needs it: the SEQUENCE is the look, and
// orderPaletteForCycle — which is right for a palette, where only
// adjacent-distinctness matters — reshuffles ROYGBIV into R,G,V,Y,B,O,I. That's
// a set of seven nice colors, not a rainbow.
function cycleDownStrip(colors, n, offset = 0, preserveOrder = false) {
  const list = (colors || []).filter(Boolean);
  if (!list.length || n <= 0) return null;
  // orderPaletteForCycle returns an array of INDICES into `list`, not colors —
  // map them back. (Getting this wrong renders every segment transparent, which
  // is how it was caught: a rainbow preview with no colors in it.)
  const ordered = preserveOrder ? list : orderPaletteForCycle(list).map(i => list[i]);
  const K = ordered.length;
  return Array.from({ length: n }, (_, i) => ordered[(((i + offset) % K) + K) % K]);
}

function SegmentPreview({ colors, segCount, beaconSeg, onPickSeg, isMobile }) {
  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "flex-end" }}>
      {Array.from({ length: segCount }, (_, i) => {
        const c = colors?.[i];
        const f = c && c.brightness !== undefined ? c.brightness / 100 : 1;
        const css = c
          ? `rgb(${Math.round(c.r * f)},${Math.round(c.g * f)},${Math.round(c.b * f)})`
          : "#1e293b";
        const isSrc = beaconSeg === i;
        return (
          <button
            key={i}
            onClick={onPickSeg ? () => onPickSeg(i) : undefined}
            title={onPickSeg ? `Make segment ${i + 1} the source` : `Segment ${i + 1}`}
            style={{
              display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
              background: "transparent", border: "none", padding: 0,
              cursor: onPickSeg ? "pointer" : "default",
            }}
          >
            <div style={{
              width: isMobile ? 22 : 26, height: isMobile ? 22 : 26, borderRadius: 6,
              background: css,
              border: isSrc ? "2px solid #fbbf24" : "1px solid rgba(255,255,255,0.15)",
              boxShadow: isSrc ? "0 0 8px rgba(251,191,36,0.6)" : "none",
            }} />
            <span style={{ fontSize: 9, color: isSrc ? "#fbbf24" : "#475569" }}>{i + 1}</span>
          </button>
        );
      })}
    </div>
  );
}

function LightScenePanel({ light, segCount, segmentColors, segmentInfo, nicknames,
                           roomName, favorites, onClose, onApplied, segmentBrightness }) {
  const isMobile = useIsMobile();
  const deviceKey = `govee:${goveeSlug(light)}`;
  const displayName = nicknames?.[deviceKey]
    || GOVEE_SKU_NAMES[light.sku] || light.name || light.sku || "Light";

  const [mode, setMode] = useState("rainbow");
  const [paletteName, setPaletteName] = useState(PALETTE_LIBRARY[0]?.name || null);
  const [paletteCategory, setPaletteCategory] = useState("Featured");
  const [paletteSearch, setPaletteSearch] = useState("");
  const [selectedTeam, setSelectedTeam] = useState(PRESET_TEAMS[0]?.name || null);
  const [selectedNcaa, setSelectedNcaa] = useState(PRESET_NCAA[0]?.name || null);
  const [selectedFlag, setSelectedFlag] = useState(PRESET_FLAGS[0]?.name || null);
  const [baseColor, setBaseColor] = useState({ r: 40, g: 180, b: 80 });
  const [direction, setDirection] = useState("forward");
  const [beaconSeg, setBeaconSeg] = useState(0);
  // Seed from what the device is actually showing. The slider dims live now, so
  // opening the panel on a light sitting at 25% and reading "100%" would be a
  // control lying about its own state — and the first nudge would jump it.
  const [brightness, setBrightness] = useState(
    segmentBrightness != null ? segmentBrightness : (light.state?.brightness ?? 100));
  const [justDone, setJustDone] = useState(false);

  // Progress rides the same SSE stream a room scene uses, filtered by SCOPE so
  // this panel hears its own device and nothing else. Shared with the light
  // card's header strip via the hook — see useSceneProgress in utils.js.
  const [progress, beginProgress, clearProgress] = useSceneProgress(deviceKey);
  const applying = progress.active;

  // ─── Compute the look ────────────────────────────────────────────────────
  const colors = (() => {
    const n = segCount;
    if (n <= 0) return null;
    if (mode === "rainbow") return cycleDownStrip(ROYGBIV, n, 0, true);
    if (mode === "palette") {
      const p = PALETTE_LIBRARY.find(x => x.name === paletteName);
      return cycleDownStrip(p?.colors, n);
    }
    if (mode === "mine") {
      const favs = (favorites || []).map(f =>
        Array.isArray(f) ? { r: f[0], g: f[1], b: f[2] } : { r: f.r, g: f.g, b: f.b });
      return cycleDownStrip(favs, n);
    }
    if (mode === "teams" || mode === "ncaa" || mode === "flags") {
      const src = mode === "teams" ? PRESET_TEAMS : mode === "ncaa" ? PRESET_NCAA : PRESET_FLAGS;
      const sel = mode === "teams" ? selectedTeam : mode === "ncaa" ? selectedNcaa : selectedFlag;
      const entry = src.find(x => x.name === sel);
      return cycleDownStrip(presetColors(entry?.colors), n);
    }
    if (mode === "solid") return Array.from({ length: n }, () => ({ ...baseColor }));
    if (mode === "gradient") {
      const shades = generateTonalShades(baseColor.r, baseColor.g, baseColor.b, n);
      const rank = stripRanks(n, direction);
      return Array.from({ length: n }, (_, i) => shades[rank[i]]);
    }
    if (mode === "beacon") {
      const src = Math.min(Math.max(0, beaconSeg), n - 1);
      const maxDist = Math.max(src, n - 1 - src, 0.0001);
      return Array.from({ length: n }, (_, i) => {
        const t = Math.abs(i - src) / maxDist;
        const bri = Math.max(5, Math.min(100, Math.round(brightness * (1 - t) + 5 * t)));
        return { ...baseColor, brightness: bri };
      });
    }
    if (mode === "restore") {
      const stored = segmentColors || {};
      if (!Object.keys(stored).length) return null;
      return Array.from({ length: n }, (_, i) => stored[i] || null);
    }
    return null;
  })();

  const describeLook = () => {
    if (mode === "rainbow") return "Rainbow";
    if (mode === "palette") return paletteName ? `Palette · ${paletteName}` : "Palette";
    if (mode === "mine") return "My colors";
    if (mode === "teams") return selectedTeam || "Team colors";
    if (mode === "ncaa") return selectedNcaa || "College colors";
    if (mode === "flags") return selectedFlag || "Flag colors";
    if (mode === "gradient") return "Shades";
    if (mode === "beacon") return "Beacon";
    if (mode === "solid") return "One color";
    return "Last colors";
  };

  // ─── Build the plan (same shape buildScenePlan produces, one device wide) ──
  // Batching by color is what keeps this bearable: each distinct color is ONE
  // cloud_v2 call, and the backend spaces calls 1.8s apart for the V2 rate limit.
  const groups = (() => {
    if (!colors) return [];
    const byColor = new Map();
    colors.forEach((c, i) => {
      if (!c) return;
      const f = c.brightness !== undefined ? c.brightness / 100 : 1;
      const rr = Math.round(c.r * f), gg = Math.round(c.g * f), bb = Math.round(c.b * f);
      const ck = `${rr},${gg},${bb}`;
      if (!byColor.has(ck)) byColor.set(ck, { segments: [], r: rr, g: gg, b: bb });
      byColor.get(ck).segments.push(i);
    });
    return [...byColor.values()];
  })();

  const proto = segmentInfo?.sku_table?.[light.sku]?.protocol;
  const unsupported = proto && proto !== "cloud_v2";
  // Rough wall clock: base seed + settle hold + one call per distinct color.
  const etaSec = groups.length ? Math.round(2.6 + Math.max(0, groups.length - 1) * 1.8) : 0;

  const apply = () => {
    if (!colors || !groups.length || applying || unsupported) return;
    // Seed the whole device with a color from ITS OWN look first, so the strip
    // reads as the scene immediately instead of flashing white while segments
    // fill in one rate-limited call at a time.
    const mid = colors[Math.floor(colors.length / 2)] || colors.find(Boolean);
    const plan = {
      room: roomName || "Unassigned",
      scope: deviceKey,
      brightness,
      base_seeds: mid ? [{
        ip: light.ip, mac: light.mac,
        r: mid.r, g: mid.g, b: mid.b,
        brightness: mid.brightness ?? brightness,
      }] : [],
      hue: [], govee_whole: [], razer: [],
      cloud: [{
        ip: light.ip, sku: light.sku, device_mac: light.mac,
        unit: light.sku === "H6061" ? "panel" : "segment",
        label: displayName,
        groups,
      }],
      label: describeLook(),
    };
    // Show progress immediately. The backend spends ~2.6s on the base seed and
    // the settle hold before the first segment event lands, and a panel that
    // sits silent for that long looks like the button didn't work.
    setJustDone(false);
    beginProgress(groups.length, Date.now() + etaSec * 1000);
    api("/scenes/room-apply", {
      method: "POST",
      body: JSON.stringify(plan),
      headers: { "Content-Type": "application/json" },
    }).catch(e => {
      console.warn("[LightScene] apply failed:", e);
      clearProgress();
    });
    // The segment-state re-read is driven by the DONE event, not a timer — see
    // the effect below.
  };

  // Master dimmer, applied LIVE. Brightness used to be a parameter of the next
  // Apply, so nudging it re-ran the entire 13-second segment-by-segment scene
  // just to change the level — the server log from the first real rainbow test
  // shows exactly that: a second room-apply and another seven cloud calls. The
  // device's own brightness is one whole-device LAN command that leaves the
  // per-segment colors alone, which is what a dimmer should be. It still rides
  // along on the next Apply so a fresh scene starts at the level you set.
  const dimNow = (v) => {
    if (!light.ip) return;
    api("/govee/segments-brightness", {
      method: "POST",
      body: JSON.stringify({
        ip: light.ip, sku: light.sku, brightness: v, device_mac: light.mac,
      }),
      headers: { "Content-Type": "application/json" },
    }).catch(e => console.warn("[LightScene] brightness failed:", e));
  };

  const cancel = () => {
    api("/scenes/room-apply/cancel", {
      method: "POST",
      body: JSON.stringify({ room: roomName || "Unassigned", scope: deviceKey }),
      headers: { "Content-Type": "application/json" },
    }).catch(() => {});
    clearProgress();
  };

  // "Applied" confirmation, latched off the transition out of the active state
  // (the hook reports `phase: "done"` once and then stays idle) — and the moment
  // to re-read segment state.
  //
  // This used to be a `setTimeout(onApplied, (etaSec + 1) * 1000)`, which RACED
  // the apply and lost by about a second: the Pi's log for a 7-color rainbow
  // shows the segment calls landing at :29 :31 :33 :35 :37 :39 :41 and the
  // re-read firing at :40 — so the card's strip captured six of seven segments
  // and drew the last one as "not set" while the light itself was correct.
  // The backend emits `done` only after every call has completed AND persisted,
  // so keying off it is exact rather than estimated. It also can't be replaced
  // by the run's `config` event: that one is published with the applying
  // client's id, and a client ignores its own echoes.
  useEffect(() => {
    if (progress.active || progress.phase !== "done") return;
    setJustDone(true);
    if (onApplied) onApplied();
  }, [progress.active, progress.phase]);

  const needsBase = mode === "gradient" || mode === "beacon" || mode === "solid";
  const modeBtn = (active) => ({
    padding: isMobile ? "5px 9px" : "5px 11px", borderRadius: 6,
    border: `1px solid ${active ? "#6366f1" : "#334155"}`,
    background: active ? "rgba(99,102,241,0.22)" : "transparent",
    color: active ? "#c7d2fe" : "#94a3b8",
    fontSize: isMobile ? 10 : 11, fontWeight: 600, cursor: "pointer",
  });

  return (
    <div style={{
      marginTop: 10, padding: isMobile ? 12 : 14, borderRadius: 12,
      background: "rgba(2,6,23,0.55)", border: "1px solid #334155",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <span style={{
          fontSize: 10, fontWeight: 800, color: "#a5b4fc",
          textTransform: "uppercase", letterSpacing: 0.6,
        }}>Scene · {segCount} segments</span>
        <div style={{ flex: 1 }} />
        <button onClick={onClose} style={{
          background: "none", border: "none", cursor: "pointer",
          color: "#64748b", fontSize: 15, lineHeight: 1, padding: "0 2px",
        }}>&#x2715;</button>
      </div>

      {unsupported && (
        <div style={{
          padding: "8px 10px", borderRadius: 8, marginBottom: 10,
          background: "rgba(180,83,9,0.18)", border: "1px solid rgba(180,83,9,0.5)",
          color: "#fdba74", fontSize: 11,
        }}>
          This device uses the {proto} per-segment protocol, which this panel doesn't drive.
        </div>
      )}

      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 10 }}>
        {LIGHT_SCENE_MODES.map(m => (
          <button key={m.key} onClick={() => setMode(m.key)} style={modeBtn(mode === m.key)}>
            {m.label}
          </button>
        ))}
      </div>

      {mode === "palette" && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
            <input
              type="text" value={paletteSearch}
              onChange={(e) => setPaletteSearch(e.target.value)}
              placeholder={`Search ${PALETTE_LIBRARY.length} palettes…`}
              style={{
                flex: "1 1 140px", minWidth: 0, padding: "5px 9px", borderRadius: 6,
                border: "1px solid #334155", background: "#0f172a",
                color: "#e2e8f0", fontSize: 11, outline: "none",
              }}
            />
            <select
              value={paletteCategory}
              onChange={(e) => setPaletteCategory(e.target.value)}
              style={{
                padding: "5px 8px", borderRadius: 6, border: "1px solid #334155",
                background: "#0f172a", color: "#e2e8f0", fontSize: 11,
              }}
            >
              {["Featured", "All", ...PALETTE_CATEGORIES].map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          <div style={{
            display: "grid", gap: 5, maxHeight: 168, overflowY: "auto",
            gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(auto-fill, minmax(150px, 1fr))",
          }}>
            {PALETTE_LIBRARY.filter(p => {
              const q = paletteSearch.trim().toLowerCase();
              if (q) return p.name.toLowerCase().includes(q);
              if (paletteCategory === "All") return true;
              if (paletteCategory === "Featured") return !!p.featured;
              return p.category === paletteCategory;
            }).map(p => (
              <button key={p.name} onClick={() => setPaletteName(p.name)}
                style={{
                  display: "flex", flexDirection: "column", gap: 3, padding: 5,
                  borderRadius: 7, cursor: "pointer", textAlign: "left",
                  border: `1px solid ${paletteName === p.name ? "#6366f1" : "#1e293b"}`,
                  background: paletteName === p.name ? "rgba(99,102,241,0.15)" : "transparent",
                }}>
                <div style={{ display: "flex", height: 9, borderRadius: 3, overflow: "hidden" }}>
                  {p.colors.map((c, i) => (
                    <div key={i} style={{ flex: 1, background: `rgb(${c.r},${c.g},${c.b})` }} />
                  ))}
                </div>
                <span style={{
                  fontSize: 10, color: paletteName === p.name ? "#c7d2fe" : "#94a3b8",
                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                }}>{p.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {(mode === "teams" || mode === "ncaa" || mode === "flags") && (
        <div style={{ marginBottom: 10 }}>
          <PresetPicker
            items={mode === "teams" ? PRESET_TEAMS : mode === "ncaa" ? PRESET_NCAA : PRESET_FLAGS}
            value={mode === "teams" ? selectedTeam : mode === "ncaa" ? selectedNcaa : selectedFlag}
            onChange={mode === "teams" ? setSelectedTeam : mode === "ncaa" ? setSelectedNcaa : setSelectedFlag}
            placeholder={mode === "teams" ? "Search teams…" : mode === "ncaa" ? "Search colleges…" : "Search countries…"}
            isMobile={isMobile}
          />
        </div>
      )}

      {mode === "mine" && (favorites || []).length === 0 && (
        <div style={{ fontSize: 11, color: "#64748b", marginBottom: 10 }}>
          No saved colors yet — star a few from any color picker and they'll appear here.
        </div>
      )}

      {mode === "restore" && !colors && (
        <div style={{ fontSize: 11, color: "#64748b", marginBottom: 10 }}>
          Nothing stored for this light yet. Apply a scene once and this will put it back —
          useful after the device has been power-cycled, which clears its segments while
          the hub still remembers them.
        </div>
      )}

      {needsBase && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 10, color: "#64748b", marginBottom: 4 }}>Color:</div>
          <ColorPicker
            size={120} compact={true} currentColor={baseColor}
            onColorSelect={(r, g, b) => setBaseColor({ r, g, b })}
            favorites={favorites}
          />
        </div>
      )}

      {mode === "gradient" && (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 10 }}>
          {STRIP_DIRECTIONS.map(d => (
            <button key={d.key} onClick={() => setDirection(d.key)} style={modeBtn(direction === d.key)}>
              {d.label}
            </button>
          ))}
        </div>
      )}

      {/* Preview. In Beacon the swatches are also the source PICKER — the thing
          you're choosing is a segment, so the segments are the control. */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 10, color: "#64748b", marginBottom: 5 }}>
          {mode === "beacon" ? "Tap a segment to make it the source:" : "Preview:"}
        </div>
        <SegmentPreview
          colors={colors} segCount={segCount}
          beaconSeg={mode === "beacon" ? beaconSeg : null}
          onPickSeg={mode === "beacon" ? setBeaconSeg : null}
          isMobile={isMobile}
        />
      </div>

      {/* Dims the light as you drag (Slider already throttles to ~180ms). In
          Beacon the value ALSO shapes the falloff, so the preview re-computes
          and the next Apply bakes it into the per-segment values — the live dim
          is still correct in the meantime, it's a master level on top. */}
      <Slider label="Brightness" value={brightness} min={5} max={100}
        onChange={(v) => { setBrightness(v); dimNow(v); }}
        color="#fbbf24" unit="%" />

      <div style={{
        display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 10,
      }}>
        {applying ? (
          <>
            {/* A segmented apply runs 13+ seconds, so this has to say what is
                happening RIGHT NOW, not just that something is. The bar carries
                the backend's own per-call label ("Hex Lights · 2 panels") — the
                first version dropped it and showed a bare count, which is why
                the status read as missing next to the room's. */}
            <div style={{ flex: "1 1 200px", minWidth: 0 }}>
              <SceneProgressBar progress={progress} />
            </div>
            <button onClick={cancel} style={{
              padding: isMobile ? "8px 14px" : "9px 18px", borderRadius: 8,
              border: "1px solid #7f1d1d", background: "rgba(127,29,29,0.3)",
              color: "#fca5a5", fontSize: 12, fontWeight: 700, cursor: "pointer",
              flexShrink: 0,
            }}>Stop</button>
          </>
        ) : (
          <>
            <button
              onClick={apply}
              disabled={!colors || !groups.length || unsupported}
              style={{
                padding: isMobile ? "8px 14px" : "9px 18px", borderRadius: 8, border: "none",
                background: (colors && groups.length && !unsupported) ? "#6366f1" : "#1e293b",
                color: (colors && groups.length && !unsupported) ? "#fff" : "#475569",
                fontSize: 12, fontWeight: 700,
                cursor: (colors && groups.length && !unsupported) ? "pointer" : "default",
              }}
            >Apply to this light</button>
            {/* Say the cost up front. Govee's cloud API allows roughly one
                color change every 1.8s, so a 7-color rainbow genuinely takes
                ~13 seconds — that's the API, not this panel, and a user who
                isn't told assumes it hung. */}
            {groups.length > 1 && (
              <span style={{ fontSize: 10, color: "#64748b" }}>
                {groups.length} colors · about {etaSec}s (Govee limits segment changes to one every ~1.8s)
              </span>
            )}
            {justDone && (
              <span style={{ fontSize: 11, color: "#4ade80", fontWeight: 600 }}>Applied</span>
            )}
          </>
        )}
      </div>
    </div>
  );
}
