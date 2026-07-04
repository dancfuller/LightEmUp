// ─── Color Mode Panel ──────────────────────────────────────────────────────
// Room-level color scheme control. Reads device positions from room layout.
// Modes: Gradient (directional shades of one color), Tonal (random tonal
// variations), Palette (distinct colors, no adjacent duplicates),
// Beacon (one color, brightness falls off with distance from a chosen source).

// Apply per-entry brightness when present (Beacon), else full color.
function dimRgbCss(c) {
  const f = (c.brightness ?? 100) / 100;
  return `rgb(${Math.round(c.r * f)},${Math.round(c.g * f)},${Math.round(c.b * f)})`;
}

// ─── Preset color helpers (Teams / NCAA / Flags modes) ──────────────────────
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
// Near-black guard: these modes skip black so a "team color" of black doesn't
// just leave a light off-looking. Judge by the BRIGHTEST channel, not luminance:
// blue contributes almost nothing to luminance, so a luminance test wrongly
// dropped dark-but-vivid colors like navy (#041E42, Penn State) — which a light
// renders fine. Only true black (every channel dark) is unshowable.
function isNearBlack(c) {
  return c && Math.max(c.r, c.g, c.b) < 40;
}
// Convert a preset's hex list into usable RGB entries, dropping near-black.
// Falls back to the raw set if everything was filtered (e.g. an all-black flag).
function presetColors(hexes) {
  const rgb = (hexes || []).map(hexToRgb).filter(Boolean);
  const kept = rgb.filter(c => !isNearBlack(c));
  return kept.length ? kept : rgb;
}

// ─── Palette extension ────────────────────────────────────────────────────
// Extend a palette of N colors to targetLen (up to 24) by generating variations
// (lighter, darker, hue-shifted) of the first 8 colors. Deterministic so repeated
// calls produce the same output for the same seed.
function extendPalette(baseColors, targetLen) {
  if (baseColors.length >= targetLen) return baseColors.slice(0, targetLen);
  const result = [...baseColors];
  if (baseColors.length === 0) {
    while (result.length < targetLen) result.push({ r: 128, g: 128, b: 128 });
    return result;
  }
  // Seed pool = first up to 8 entries (the "original" palette)
  const seedLen = Math.min(8, baseColors.length);
  const seed = baseColors.slice(0, seedLen);
  while (result.length < targetLen) {
    const i = result.length;
    const src = seed[i % seedLen];
    const round = Math.floor(i / seedLen); // 0 never generated (already present), 1+ extends
    const { h, s, l } = rgbToHsl(src.r, src.g, src.b);
    let newH = h, newS = s, newL = l;
    if (round === 1) {
      // Lighter, slightly desaturated tint
      newL = Math.min(0.82, l + 0.18);
      newS = Math.max(0.35, s * 0.88);
    } else if (round === 2) {
      // Darker, slightly more saturated shade
      newL = Math.max(0.18, l - 0.18);
      newS = Math.min(1, s * 1.12);
    } else {
      // Hue-shifted fallback for 24+ slots
      newH = ((h + (round - 2) * 0.06) % 1 + 1) % 1;
      newL = Math.max(0.25, Math.min(0.75, l + (round % 2 === 0 ? 0.08 : -0.08)));
    }
    result.push(hslToRgb(newH, newS, newL));
  }
  return result;
}

// ─── Gradient Direction Picker with Mini Map ──────────────────────────────
function GradientDirectionPicker({ direction, onDirectionChange, availableDirections, placedLights, layout, preview, lightMap, nicknames, isLinear }) {
  const isMobile = useIsMobile();
  if (!layout || placedLights.length === 0) return null;

  const boundary = layout.boundary || {};
  const bw = isLinear ? (boundary.length || 20) : (boundary.width || 12);
  const bh = isLinear ? 3 : (boundary.height || 10);

  // Mini map sizing — scale to fit within a max width, keep aspect ratio
  const maxW = isMobile ? 220 : 280;
  const maxH = isLinear ? 48 : (isMobile ? 130 : 160);
  const aspect = bw / bh;
  let mapW, mapH;
  if (aspect > maxW / maxH) {
    mapW = maxW;
    mapH = maxW / aspect;
  } else {
    mapH = maxH;
    mapW = maxH * aspect;
  }
  const scale = mapW / bw;

  // Direction arrow geometry (in SVG coords)
  const pad = 8;
  const cx = mapW / 2, cy = mapH / 2;
  const arrowDefs = {
    "left-right": { x1: pad, y1: cy, x2: mapW - pad, y2: cy },
    "right-left": { x1: mapW - pad, y1: cy, x2: pad, y2: cy },
    "top-bottom": { x1: cx, y1: pad, x2: cx, y2: mapH - pad },
    "bottom-top": { x1: cx, y1: mapH - pad, x2: cx, y2: pad },
    "center-out": null,
  };

  const dirLabels = {
    "left-right": "\u2192",
    "right-left": "\u2190",
    "top-bottom": "\u2193",
    "bottom-top": "\u2191",
    "center-out": "\u25CE",
  };

  const dirNames = {
    "left-right": "Left to right",
    "right-left": "Right to left",
    "top-bottom": "Top to bottom",
    "bottom-top": "Bottom to top",
    "center-out": "Center outward",
  };

  const btnStyle = (active) => ({
    padding: "4px 10px", borderRadius: 6, border: "1px solid #334155",
    background: active ? "rgba(52,211,153,0.15)" : "transparent",
    color: active ? "#34d399" : "#64748b", fontSize: 11, fontWeight: 600, cursor: "pointer",
    whiteSpace: "nowrap",
  });

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, color: "#64748b", marginBottom: 6 }}>Direction:</div>
      <div style={{ display: "flex", flexDirection: isMobile ? "column" : "row", gap: 12, alignItems: "flex-start" }}>
        {/* Mini map */}
        <div style={{
          background: "#0f172a", borderRadius: 8, border: "1px solid #1e293b",
          padding: 6, flexShrink: 0,
        }}>
          <svg width={mapW + 12} height={mapH + 12} viewBox={`-6 -6 ${mapW + 12} ${mapH + 12}`}>
            {/* Room boundary */}
            <rect x={0} y={0} width={mapW} height={mapH} rx={4}
              fill="none" stroke="#334155" strokeWidth={1} strokeDasharray="4,3" />

            {/* Device dots with preview colors */}
            {placedLights.map(d => {
              const dx = d.x * scale;
              const dy = isLinear ? mapH / 2 : d.y * scale;
              const previewColor = preview?.[d.key];
              const fill = previewColor
                ? `rgb(${previewColor.r},${previewColor.g},${previewColor.b})`
                : "#64748b";
              const segMatch = d.key.match(/^(.+):seg(\d+)$/);
              const lookupKey = segMatch ? segMatch[1] : d.key;
              const baseName = getDeviceLabel(lightMap[lookupKey], nicknames);
              const segLtr = segMatch ? String.fromCharCode(65 + parseInt(segMatch[2])) : null;
              const label = segMatch ? `${baseName.split(" ")[0]} ${segLtr}` : baseName;
              return (
                <g key={d.key}>
                  <circle cx={dx} cy={dy} r={5} fill={fill}
                    stroke="rgba(255,255,255,0.2)" strokeWidth={1} />
                  <title>{label}</title>
                </g>
              );
            })}

            {/* Direction arrow or radial rings */}
            {direction === "center-out" ? (
              <>
                <circle cx={cx} cy={cy} r={Math.min(mapW, mapH) * 0.15} fill="none" stroke="#34d399" strokeWidth={1} opacity={0.4} strokeDasharray="3,2" />
                <circle cx={cx} cy={cy} r={Math.min(mapW, mapH) * 0.35} fill="none" stroke="#34d399" strokeWidth={1} opacity={0.3} strokeDasharray="3,2" />
                <circle cx={cx} cy={cy} r={Math.min(mapW, mapH) * 0.5} fill="none" stroke="#34d399" strokeWidth={1} opacity={0.2} strokeDasharray="3,2" />
                <circle cx={cx} cy={cy} r={3} fill="#34d399" opacity={0.8} />
              </>
            ) : arrowDefs[direction] ? (() => {
              const a = arrowDefs[direction];
              return (
                <>
                  <defs>
                    <marker id="cm-arrow" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
                      <polygon points="0 0, 8 3, 0 6" fill="#34d399" />
                    </marker>
                  </defs>
                  <line x1={a.x1} y1={a.y1} x2={a.x2} y2={a.y2}
                    stroke="#34d399" strokeWidth={1.5} strokeDasharray="6,3" opacity={0.6}
                    markerEnd="url(#cm-arrow)" />
                  {/* Dark/Light labels — offset beside the arrow for vertical, above for horizontal */}
                  {direction.includes("top") || direction.includes("bottom") ? (
                    <>
                      <text x={a.x1 + 10} y={a.y1 + 3} textAnchor="start" fill="#34d399" fontSize={7} opacity={0.7} fontFamily="sans-serif">dark</text>
                      <text x={a.x2 + 10} y={a.y2 + 3} textAnchor="start" fill="#34d399" fontSize={7} opacity={0.7} fontFamily="sans-serif">light</text>
                    </>
                  ) : (
                    <>
                      <text x={a.x1} y={a.y1 - 6} textAnchor="middle" fill="#34d399" fontSize={7} opacity={0.7} fontFamily="sans-serif">dark</text>
                      <text x={a.x2} y={a.y2 - 6} textAnchor="middle" fill="#34d399" fontSize={7} opacity={0.7} fontFamily="sans-serif">light</text>
                    </>
                  )}
                </>
              );
            })() : null}
          </svg>
        </div>

        {/* Direction buttons */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {availableDirections.map(key => (
            <button key={key} onClick={() => onDirectionChange(key)}
              style={btnStyle(direction === key)}
              title={dirNames[key]}
            >
              <span style={{ marginRight: 4 }}>{dirLabels[key]}</span>
              {dirNames[key]}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Beacon Source Picker with Mini Map ───────────────────────────────────
// Click a light on the mini-map to set it as the beacon source.
function BeaconSourcePicker({ sourceKey, onSourceChange, placedLights, layout, preview, lightMap, nicknames, isLinear }) {
  const isMobile = useIsMobile();
  if (!layout || placedLights.length === 0) return null;

  const boundary = layout.boundary || {};
  const bw = isLinear ? (boundary.length || 20) : (boundary.width || 12);
  const bh = isLinear ? 3 : (boundary.height || 10);

  const maxW = isMobile ? 220 : 280;
  const maxH = isLinear ? 48 : (isMobile ? 130 : 160);
  const aspect = bw / bh;
  let mapW, mapH;
  if (aspect > maxW / maxH) {
    mapW = maxW;
    mapH = maxW / aspect;
  } else {
    mapH = maxH;
    mapW = maxH * aspect;
  }
  const scale = mapW / bw;

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, color: "#64748b", marginBottom: 6 }}>
        Source light (click to change):
      </div>
      <div style={{
        background: "#0f172a", borderRadius: 8, border: "1px solid #1e293b",
        padding: 6, display: "inline-block",
      }}>
        <svg width={mapW + 12} height={mapH + 12} viewBox={`-6 -6 ${mapW + 12} ${mapH + 12}`}>
          <rect x={0} y={0} width={mapW} height={mapH} rx={4}
            fill="none" stroke="#334155" strokeWidth={1} strokeDasharray="4,3" />
          {placedLights.map(d => {
            const dx = d.x * scale;
            const dy = isLinear ? mapH / 2 : d.y * scale;
            const previewColor = preview?.[d.key];
            const fill = previewColor ? dimRgbCss(previewColor) : "#64748b";
            const isSource = d.key === sourceKey;
            const segMatch = d.key.match(/^(.+):seg(\d+)$/);
            const lookupKey = segMatch ? segMatch[1] : d.key;
            const baseName = getDeviceLabel(lightMap[lookupKey], nicknames);
            const segLtr = segMatch ? String.fromCharCode(65 + parseInt(segMatch[2])) : null;
            const label = segMatch ? `${baseName} ${segLtr}` : baseName;
            return (
              <g key={d.key} style={{ cursor: "pointer" }} onClick={() => onSourceChange(d.key)}>
                {isSource && (
                  <circle cx={dx} cy={dy} r={11} fill="none" stroke="#34d399"
                    strokeWidth={1} opacity={0.5} strokeDasharray="2,2" />
                )}
                <circle cx={dx} cy={dy} r={isSource ? 7 : 5}
                  fill={fill}
                  stroke={isSource ? "#34d399" : "rgba(255,255,255,0.2)"}
                  strokeWidth={isSource ? 2 : 1} />
                <title>{label}{isSource ? " (source)" : ""}</title>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

// Boost an RGB color so its *effective* saturation is at least minS (0..1).
// HSL saturation alone is misleading: HSL(240, 100%, 90%) is technically
// 100% saturated but reads as washed-out pale blue. We measure effective
// saturation as S × (1 − 2·|L − ½|) — equivalent to HSV saturation when
// the color is bright — so the floor filters out near-white shades the way
// a user would expect. When the floor isn't met we set S=1 and pull L
// toward 0.5 just far enough to satisfy it, preserving the original side
// of 0.5 (so a "darker" shade stays darker, just less black).
function clampSaturation(c, minS) {
  if (!c) return c;
  const { h, s, l } = rgbToHsl(c.r, c.g, c.b);
  const eff = s * (1 - 2 * Math.abs(l - 0.5));
  if (eff >= minS) return c;
  const maxLDelta = (1 - minS) / 2; // distance from 0.5 that still passes at S=1
  const newL = l >= 0.5
    ? Math.min(l, 0.5 + maxLDelta)
    : Math.max(l, 0.5 - maxLDelta);
  const boosted = hslToRgb(h, 1.0, newL);
  return { ...c, r: boosted.r, g: boosted.g, b: boosted.b };
}

function applyMinSat(preview, enabled, pct) {
  if (!preview || !enabled) return preview;
  const minS = Math.max(0, Math.min(1, (pct || 0) / 100));
  const out = {};
  // White (color-temperature) entries are intentionally low-saturation; never
  // clamp them back toward vivid color. They carry a `kelvin`.
  Object.entries(preview).forEach(([k, v]) => { out[k] = v.kelvin != null ? v : clampSaturation(v, minS); });
  return out;
}

// Apply per-device segment fill overrides: "follow" (default — no change),
// "solid" (all segments of this device get the first segment's color), or
// "shades" (tonal shades of one base color). Operates on the preview so
// the previewed map matches what gets sent on Apply.
function applySegmentFillModes(preview, fillModes) {
  if (!preview || !fillModes) return preview;
  const out = { ...preview };
  const byParent = {};
  Object.entries(preview).forEach(([key, color]) => {
    const m = key.match(/^(.+):seg(\d+)$/);
    if (!m) return;
    (byParent[m[1]] ||= []).push({ key, idx: parseInt(m[2]), color });
  });
  Object.entries(byParent).forEach(([parent, segs]) => {
    const mode = fillModes[parent] || "follow";
    if (mode === "follow") return;
    segs.sort((a, b) => a.idx - b.idx);
    const base = segs[0].color;
    if (mode === "solid") {
      segs.forEach(s => { out[s.key] = { ...s.color, r: base.r, g: base.g, b: base.b }; });
    } else if (mode === "shades") {
      const shades = generateTonalShades(base.r, base.g, base.b, segs.length);
      segs.forEach((s, i) => {
        out[s.key] = { ...s.color, r: shades[i].r, g: shades[i].g, b: shades[i].b };
      });
    }
  });
  return out;
}

// Shades/exact toggle, shared by Custom and the preset modes. "shades" expands
// each base color into a tonal range; "exact" uses the colors as-is.
function ShadeToggle({ value, onChange }) {
  return (
    <div style={{
      display: "flex", gap: 4, marginBottom: 12,
      background: "#0f172a", borderRadius: 8, padding: 3, border: "1px solid #1e293b",
    }}>
      {[
        { key: "shades", label: "Create shades" },
        { key: "exact", label: "Use exact colors" },
      ].map(opt => (
        <button key={opt.key}
          onClick={() => onChange(opt.key)}
          style={{
            flex: 1, padding: "6px 10px", borderRadius: 6, border: "none",
            background: value === opt.key ? "#6366f1" : "transparent",
            color: value === opt.key ? "#fff" : "#94a3b8",
            fontSize: 11, fontWeight: 600, cursor: "pointer",
          }}
        >{opt.label}</button>
      ))}
    </div>
  );
}

// Searchable single-select picker for the preset modes (Teams / NCAA / Flags).
// Filters items by name, previews the selected item's swatches, and lists each
// option with its color chips. Controlled: parent owns `value` (an item name).
function PresetPicker({ items, value, onChange, placeholder, isMobile }) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const filtered = needle ? items.filter(it => it.name.toLowerCase().includes(needle)) : items;
  const selected = items.find(it => it.name === value);
  return (
    <div>
      {selected && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: isMobile ? 13 : 14, fontWeight: 700, color: "#e2e8f0" }}>{selected.name}</span>
          {selected.group && <span style={{ fontSize: 10, color: "#64748b" }}>{selected.group}</span>}
          <div style={{ display: "flex", gap: 4, marginLeft: "auto" }}>
            {presetColors(selected.colors).map((c, i) => (
              <div key={i} style={{
                width: 22, height: 22, borderRadius: 5,
                background: `rgb(${c.r},${c.g},${c.b})`, border: "1px solid rgba(255,255,255,0.25)",
              }} />
            ))}
          </div>
        </div>
      )}
      <input
        type="text" value={q} onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder || "Search…"}
        style={{
          width: "100%", boxSizing: "border-box", padding: "8px 10px", borderRadius: 8,
          border: "1px solid #334155", background: "#0f172a", color: "#e2e8f0",
          fontSize: 13, marginBottom: 6,
        }}
      />
      <div style={{
        maxHeight: 220, overflowY: "auto", border: "1px solid #1e293b",
        borderRadius: 8, background: "rgba(15,23,42,0.5)",
      }}>
        {filtered.length === 0 && (
          <div style={{ padding: 10, fontSize: 12, color: "#64748b" }}>No matches</div>
        )}
        {filtered.map(it => {
          const active = it.name === value;
          const sw = presetColors(it.colors);
          return (
            <button key={it.name} onClick={() => onChange(it.name)}
              style={{
                display: "flex", alignItems: "center", gap: 8, width: "100%",
                textAlign: "left", padding: "7px 10px", border: "none", cursor: "pointer",
                background: active ? "rgba(99,102,241,0.25)" : "transparent",
                color: active ? "#fff" : "#cbd5e1", fontSize: 12,
                borderBottom: "1px solid rgba(30,41,59,0.6)",
              }}>
              <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
                {sw.slice(0, 4).map((c, i) => (
                  <div key={i} style={{ width: 12, height: 12, borderRadius: 2, background: `rgb(${c.r},${c.g},${c.b})` }} />
                ))}
              </div>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.name}</span>
              {it.group && <span style={{ fontSize: 10, color: "#64748b", flexShrink: 0 }}>{it.group}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ColorMode({ roomName, hueLights, goveeDevices, onControlHue, onControlGovee, favorites, onFavoritesChange, nicknames, segmentInfo, roomLayouts, fixtures, onApply, minSatEnabled, minSatPct, segmentFillModes, savedColorState }) {
  const isMobile = useIsMobile();
  const [mode, setMode] = useState("palette"); // "palette" | "gradient" | "tonal" | "custom" | "beacon"
  // Color space: "color" (RGB, the default) or "white" (tunable color temperature).
  // In white mode every spatial mode operates in Kelvin and sends true white CT.
  const [colorSpace, setColorSpace] = useState("color");
  const [ctPreset, setCtPreset] = useState(0); // index into CT_PALETTES (palette mode)
  const [maxKelvin, setMaxKelvin] = useState(3000); // upper bound for gradient/beacon/custom
  // customColors: 1-4 user-chosen seed colors. Custom mode randomly
  // assigns each light a (seed, shade) pair with adjacency preference,
  // or — when customShadeMode === "exact" — assigns each light exactly
  // one of the seed colors with no shading.
  const [customColors, setCustomColors] = useState([{ r: 60, g: 100, b: 255 }]);
  const [editingCustomIdx, setEditingCustomIdx] = useState(null);
  const [customShadeMode, setCustomShadeMode] = useState("exact"); // "shades" | "exact"
  const [beaconSourceKey, setBeaconSourceKey] = useState(null);
  const [baseColor, setBaseColor] = useState({ r: 40, g: 180, b: 80 });
  // paletteColors = visible/active subset of paletteSource.
  // paletteSource = the "full palette" memory — preserved when count decreases
  // so increasing count restores original colors instead of regenerating them.
  const defaultPalette = [
    { r: 255, g: 60, b: 60 },
    { r: 255, g: 140, b: 30 },
    { r: 255, g: 220, b: 40 },
    { r: 60, g: 200, b: 80 },
    { r: 40, g: 200, b: 220 },
    { r: 60, g: 100, b: 255 },
    { r: 160, g: 60, b: 255 },
    { r: 255, g: 60, b: 180 },
  ];
  const [paletteColors, setPaletteColors] = useState(defaultPalette);
  const [paletteSource, setPaletteSource] = useState(defaultPalette);
  const [editingPaletteIdx, setEditingPaletteIdx] = useState(null);
  const [paletteCategory, setPaletteCategory] = useState("Featured");
  const [paletteSearch, setPaletteSearch] = useState("");
  const [direction, setDirection] = useState("left-right");
  const [brightness, setBrightness] = useState(100); // 0-100%
  const [preview, setPreview] = useState(null); // { deviceKey: {r,g,b}, ... }
  // addressSegments: "individual" (default) treats each segmented device as
  // N entries (one per segment, each potentially getting its own color);
  // "unit" treats the device as a single entry and sends a whole-device
  // command. The map's per-device expand badge still controls layout
  // positions when present; otherwise "individual" mode auto-clusters
  // segments around the device position so gradient/beacon have spatial
  // variation.
  const [addressSegments, setAddressSegments] = useState("individual");

  // Target vendor filter: "all" | "hue" | "govee". Restricts which devices a
  // scene touches so e.g. a palette can be applied to Govee strips only without
  // disturbing the Hue bulbs. Default "all".
  const [targetVendor, setTargetVendor] = useState("all");

  // Deterministic assignment seed. The adjacency-aware color assignment is
  // randomized; seeding it (instead of Math.random) makes every client compute
  // the same device→color layout from the same palette, so a second session
  // matches the lights another device already set. "Shuffle" bumps this; it is
  // persisted in room_color_state so a re-roll syncs across sessions.
  const [shuffleSeed, setShuffleSeed] = useState(1);

  // Preset-mode selections (Teams / NCAA / Flags). Stored by name so they
  // survive data edits; default to the first entry so switching into the mode
  // immediately previews something.
  const [selectedTeam, setSelectedTeam] = useState(PRESET_TEAMS[0]?.name || null);
  const [selectedNcaa, setSelectedNcaa] = useState(PRESET_NCAA[0]?.name || null);
  const [selectedFlag, setSelectedFlag] = useState(PRESET_FLAGS[0]?.name || null);

  // Restore the last-applied selection for this room (display-only — pre-selects
  // the same mode/palette/brightness a previous LightEmUp session set, so a
  // second device opens onto accurate state). Seeds once per room; never
  // issues a control command.
  const seededRoom = useRef(null);
  useEffect(() => {
    const s = savedColorState;
    if (!s || seededRoom.current === roomName) return;
    seededRoom.current = roomName;
    if (s.mode) setMode(s.mode);
    if (s.color_space) setColorSpace(s.color_space);
    if (Array.isArray(s.palette_colors) && s.palette_colors.length) {
      setPaletteColors(s.palette_colors);
      setPaletteSource(s.palette_colors);
    }
    if (s.base_color) setBaseColor(s.base_color);
    if (typeof s.brightness === "number") setBrightness(s.brightness);
    if (s.direction) setDirection(s.direction);
    if (s.address_segments) setAddressSegments(s.address_segments);
    if (s.target_vendor) setTargetVendor(s.target_vendor);
    if (typeof s.shuffle_seed === "number") setShuffleSeed(s.shuffle_seed);
    if (s.selected_team) setSelectedTeam(s.selected_team);
    if (s.selected_ncaa) setSelectedNcaa(s.selected_ncaa);
    if (s.selected_flag) setSelectedFlag(s.selected_flag);
    if (Array.isArray(s.custom_colors) && s.custom_colors.length) setCustomColors(s.custom_colors);
    if (s.custom_shade_mode) setCustomShadeMode(s.custom_shade_mode);
    if (s.beacon_source_key) setBeaconSourceKey(s.beacon_source_key);
    if (typeof s.max_kelvin === "number") setMaxKelvin(s.max_kelvin);
    if (typeof s.ct_preset === "number") setCtPreset(s.ct_preset);
  }, [roomName, savedColorState]);

  // Apply progress state
  const [applying, setApplying] = useState(false);
  const [applyPhase, setApplyPhase] = useState(null); // "resetting" | "applying" | null
  const [applyTotal, setApplyTotal] = useState(0);
  const [applyDone, setApplyDone] = useState(0);
  const [applyEndAt, setApplyEndAt] = useState(0);
  const [tickNow, setTickNow] = useState(0);
  // Name of the device/segment currently being updated — surfaced as text
  // because rooms with many segments take 40s+ (1.8s stagger per cloud panel).
  const [applyLabel, setApplyLabel] = useState("");

  // Tick clock for the countdown while applying
  useEffect(() => {
    if (!applying) return;
    setTickNow(Date.now());
    const id = setInterval(() => setTickNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [applying]);

  // Scene apply runs server-side (POST /scenes/room-apply); the backend owns the
  // timing and emits "scene_apply" SSE progress events. app.js re-broadcasts
  // those as a window event. Reflect them here so any open session — including
  // one that didn't start the apply — shows live progress. The apply keeps
  // running even if this panel unmounts or the browser closes.
  useEffect(() => {
    const onProgress = (e) => {
      const d = e.detail;
      if (!d || d.room !== roomName) return;
      if (d.active === false) {
        setApplying(false);
        setApplyPhase(null);
        setApplyLabel("");
        return;
      }
      setApplying(true);
      if (d.phase) setApplyPhase(d.phase);
      if (typeof d.total === "number") setApplyTotal(d.total);
      if (typeof d.done === "number") setApplyDone(d.done);
      if (d.label !== undefined) setApplyLabel(d.label || "");
      if (typeof d.end_at === "number") setApplyEndAt(d.end_at);
    };
    window.addEventListener("lightemup-scene-apply", onProgress);
    return () => window.removeEventListener("lightemup-scene-apply", onProgress);
  }, [roomName]);

  const secondsLeft = applying ? Math.max(0, Math.ceil((applyEndAt - tickNow) / 1000)) : 0;

  const allLights = [
    ...hueLights.map(l => ({ ...l, _controlFn: onControlHue })),
    ...goveeDevices.map(d => ({ ...d, _controlFn: onControlGovee })),
  ];

  const lightMap = {};
  allLights.forEach(l => {
    const key = l.type === "hue" ? `hue:${l.id}` : `govee:${l.ip}`;
    lightMap[key] = l;
  });

  // Get the active layout for this room
  const layout = roomLayouts?.[roomName];
  const devices = layout?.devices || {};
  const segments = layout?.segments || {};
  const gridSize = layout?.grid_size || 40;

  // Build placed lights list. Three cases per device:
  //   addressSegments=individual + map has expanded positions → use them
  //   addressSegments=individual + no positions → auto-cluster N segments
  //     near the device position so gradient/beacon get spatial variation
  //   addressSegments=unit                       → single entry at device pos
  // Which vendors have color-capable devices placed in this room — drives
  // whether the All/Hue/Govee filter is worth showing, and lets us fall back
  // to "all" if the saved filter targets a vendor that's no longer here.
  const placedVendors = { hue: false, govee: false };
  Object.keys(devices).forEach((key) => {
    const light = lightMap[key];
    if (!light?.capabilities?.has_color) return;
    if (key.startsWith("hue:")) placedVendors.hue = true;
    else if (key.startsWith("govee:")) placedVendors.govee = true;
  });
  const effectiveVendor =
    (targetVendor === "hue" && !placedVendors.hue) ||
    (targetVendor === "govee" && !placedVendors.govee)
      ? "all" : targetVendor;

  const placedColorLights = [];
  Object.entries(devices).forEach(([key, pos]) => {
    const light = lightMap[key];
    if (!light?.capabilities?.has_color) return;
    if (effectiveVendor === "hue" && !key.startsWith("hue:")) return;
    if (effectiveVendor === "govee" && !key.startsWith("govee:")) return;
    const segData = segments[key];
    const segCountForDevice = light?.sku ? (segmentInfo?.sku_table?.[light.sku]?.count || 0) : 0;
    const addressIndividual = addressSegments === "individual" && segCountForDevice > 1;

    if (addressIndividual && segData?.expanded && segData.positions) {
      // Layout-placed: use explicit positions.
      Object.entries(segData.positions).forEach(([si, sp]) => {
        placedColorLights.push({ key: `${key}:seg${si}`, x: sp.x, y: sp.y, parentKey: key, segIndex: parseInt(si) });
      });
    } else if (addressIndividual) {
      // Synthetic cluster: spread N segments horizontally over ~3 grid
      // units at the device's position. Just enough variation for
      // gradient/beacon to produce distinct shades.
      const spread = Math.min(3, segCountForDevice * 0.5);
      const step = segCountForDevice > 1 ? spread / (segCountForDevice - 1) : 0;
      for (let i = 0; i < segCountForDevice; i++) {
        placedColorLights.push({
          key: `${key}:seg${i}`,
          x: pos.x - spread / 2 + step * i,
          y: pos.y,
          parentKey: key,
          segIndex: i,
        });
      }
    } else {
      placedColorLights.push({ key, x: pos.x, y: pos.y });
    }
  });

  const hasLayout = placedColorLights.length > 0;
  const hasColorLights = allLights.some(l => l?.capabilities?.has_color);

  // The palette is a *pool*, not a per-light list: with more colors than lights,
  // the assignment (computePalette) picks a distinct subset sized to the room
  // and Shuffle re-rolls which colors are used. So we deliberately DON'T trim
  // the palette down to the light/segment count — that would strand the rest of
  // the palette and make Shuffle cycle the same two colors. The room only ever
  // *shows* as many colors as it has lights; the extras stay in the shuffle pool.

  // ─── Adjacency graph (for palette mode) ─────────────────────────────
  // Two entries (lights or segments) are adjacent if any of:
  //   1. They're within the spatial threshold on the map — segments included.
  //      A segment constrains nearby segments of OTHER devices and nearby
  //      whole lights, so two strips placed side by side (and a strip next to
  //      a bulb) get distinct colors across their border. (Previously segments
  //      never spatially constrained non-mates, to keep a lone hexa's 7 panels
  //      from over-constraining the room; but that silently dropped the
  //      strip-to-strip / strip-to-bulb borders people actually want. A hexa
  //      sitting close to other lights now constrains them — if the palette is
  //      too small the graceful relax fallbacks below still resolve it.)
  //   2. They're segments of the same parent device (intra-device segments
  //      are mutually adjacent regardless of distance — siblings of one hexa
  //      must all be distinct).
  //   3. Their parent devices share a fixture (intra-fixture distinctness).
  //   4. One is spatially adjacent to a fixture-mate of the other (any
  //      fixture member "borrows" all its fixture-mates' adjacencies).
  const buildAdjacency = useCallback((entries) => {
    const threshold = 8; // grid units — roughly "touching" distance
    const adj = {};
    entries.forEach(e => { adj[e.key] = new Set(); });

    const parentKey = (k) => {
      const m = k.match(/^(.+):seg\d+$/);
      return m ? m[1] : k;
    };
    const isSegment = (k) => /:seg\d+$/.test(k);

    // 1. Spatial adjacency: any two entries within the threshold are adjacent,
    // segments included. (Same-parent segment pairs are also forced adjacent by
    // rule 1b below regardless of distance, so the spatial check is redundant
    // for them but harmless — the Set dedupes.)
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const ki = entries[i].key, kj = entries[j].key;
        const dx = entries[i].x - entries[j].x;
        const dy = entries[i].y - entries[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < threshold) {
          adj[ki].add(kj);
          adj[kj].add(ki);
        }
      }
    }

    // 1b. Intra-device segments: every segment pair of the same parent is
    // adjacent, regardless of spatial distance, so the 7 hexa panels always
    // pick 7 distinct palette colors.
    const segByParent = {};
    entries.forEach(e => {
      if (isSegment(e.key)) (segByParent[parentKey(e.key)] ||= []).push(e.key);
    });
    Object.values(segByParent).forEach(siblings => {
      for (let i = 0; i < siblings.length; i++) {
        for (let j = i + 1; j < siblings.length; j++) {
          adj[siblings[i]].add(siblings[j]);
          adj[siblings[j]].add(siblings[i]);
        }
      }
    });

    // Map parent device key → fixture id, and fixture id → entry keys present
    // in this room's adjacency (so a fixture's segments inherit membership).
    const deviceToFixture = {};
    Object.entries(fixtures || {}).forEach(([fid, fix]) => {
      (fix.members || []).forEach(m => { deviceToFixture[m] = fid; });
    });
    const fixtureEntries = {};
    entries.forEach(e => {
      const fid = deviceToFixture[parentKey(e.key)];
      if (fid) (fixtureEntries[fid] ||= []).push(e.key);
    });

    // 2. Intra-fixture: every pair of fixture-mate entries is adjacent
    Object.values(fixtureEntries).forEach(members => {
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          adj[members[i]].add(members[j]);
          adj[members[j]].add(members[i]);
        }
      }
    });

    // 3. Propagate: snapshot edges, then for each edge (X, Y) extend to all
    // of Y's fixture-mates and all of X's fixture-mates
    const edges = [];
    Object.entries(adj).forEach(([k, neighbors]) => {
      neighbors.forEach(n => { if (k < n) edges.push([k, n]); });
    });
    edges.forEach(([x, y]) => {
      const xFid = deviceToFixture[parentKey(x)];
      const yFid = deviceToFixture[parentKey(y)];
      if (yFid && fixtureEntries[yFid]) {
        fixtureEntries[yFid].forEach(yMate => {
          if (yMate !== x) { adj[x].add(yMate); adj[yMate].add(x); }
        });
      }
      if (xFid && fixtureEntries[xFid]) {
        fixtureEntries[xFid].forEach(xMate => {
          if (xMate !== y) { adj[y].add(xMate); adj[xMate].add(y); }
        });
      }
    });

    return adj;
  }, [fixtures]);

  // ─── Gradient mode: project devices along a direction vector ────────
  const computeGradient = useCallback(() => {
    if (placedColorLights.length === 0) return null;

    // Direction vectors
    const dirVectors = {
      "left-right": { dx: 1, dy: 0 },
      "right-left": { dx: -1, dy: 0 },
      "top-bottom": { dx: 0, dy: 1 },
      "bottom-top": { dx: 0, dy: -1 },
      "center-out": null, // special: radial
    };

    const count = placedColorLights.length;
    const shades = generateTonalShades(baseColor.r, baseColor.g, baseColor.b, count);

    let sorted;
    if (direction === "center-out") {
      // Radial: distance from centroid
      const cx = placedColorLights.reduce((s, d) => s + d.x, 0) / count;
      const cy = placedColorLights.reduce((s, d) => s + d.y, 0) / count;
      sorted = placedColorLights.map(d => ({
        key: d.key,
        proj: Math.sqrt((d.x - cx) ** 2 + (d.y - cy) ** 2),
      })).sort((a, b) => a.proj - b.proj);
    } else {
      const vec = dirVectors[direction];
      sorted = placedColorLights.map(d => ({
        key: d.key,
        proj: d.x * vec.dx + d.y * vec.dy,
      })).sort((a, b) => a.proj - b.proj);
    }

    const result = {};
    sorted.forEach((item, i) => { result[item.key] = shades[i]; });
    return result;
  }, [placedColorLights, baseColor, direction]);

  // ─── Palette mode: graph-coloring with global usage + perceptual spacing ──
  const computePalette = useCallback(() => {
    if (placedColorLights.length === 0 || paletteColors.length === 0) return null;

    const rng = seededRng(`${roomName}|palette|${shuffleSeed}`);
    const adj = buildAdjacency(placedColorLights);
    const colors = paletteColors;
    const N = colors.length;

    // Precompute HSL for each palette color
    const hsl = colors.map(c => rgbToHsl(c.r, c.g, c.b));

    // Two metrics are needed:
    //
    // colorDist (clamped) — used to *gate* adjacency. Same-hue-family pairs
    //   are capped below the similarity threshold so a darker/duller variant
    //   of the same family is never considered "distinct enough" to sit next
    //   to its sibling.
    //
    // colorRankDist (unclamped) — used to *rank* candidates when the
    //   gate passes nothing through (e.g. monochromatic Warm palette). Even
    //   when every option is in the same family, we still want the most
    //   tonally different shade picked for adjacent slots, not random.
    const colorDist = (i, j) => {
      const a = hsl[i], b = hsl[j];
      let dh = Math.abs(a.h - b.h);
      if (dh > 0.5) dh = 1 - dh;
      const satWeight = Math.min(a.s, b.s);
      const dl = Math.abs(a.l - b.l);
      const ds = Math.abs(a.s - b.s);

      if (satWeight < 0.2) return dl + ds * 0.3;
      if (dh < 0.15) return Math.min(0.13, dh + (dl + ds * 0.3) * 0.2);
      return dh * 2 + (dl + ds * 0.3) * 0.5;
    };
    const colorRankDist = (i, j) => {
      const a = hsl[i], b = hsl[j];
      let dh = Math.abs(a.h - b.h);
      if (dh > 0.5) dh = 1 - dh;
      const dl = Math.abs(a.l - b.l);
      const ds = Math.abs(a.s - b.s);
      return dh * 2 + dl + ds * 0.3;
    };

    // Two colors below this perceptual distance are visually too similar to
    // sit next to each other (e.g. two saturated reds that differ only in
    // brightness/saturation). Tuned so distinct hues pass and near-duplicates fail.
    const SIMILARITY_THRESHOLD = 0.15;

    // Sort devices by number of neighbors (most constrained first)
    const sorted = [...placedColorLights].sort((a, b) =>
      (adj[b.key]?.size || 0) - (adj[a.key]?.size || 0)
    );

    const usage = new Array(N).fill(0);
    const assignment = {};

    sorted.forEach(device => {
      // Collect color indices already assigned to adjacent neighbors
      const neighborIdxs = [];
      adj[device.key]?.forEach(nk => {
        if (assignment[nk] !== undefined) neighborIdxs.push(assignment[nk]);
      });
      const neighborSet = new Set(neighborIdxs);
      const tooSimilarToNeighbor = (idx) => {
        for (const nIdx of neighborIdxs) {
          if (idx === nIdx) return true;
          if (colorDist(idx, nIdx) < SIMILARITY_THRESHOLD) return true;
        }
        return false;
      };

      // Pick a tier of usage counts: lowest first. Within a tier, prefer
      // colors that are perceptually distinct from every neighbor.
      const tiers = [...new Set(usage)].sort((a, b) => a - b);
      let candidates = [];
      for (const tier of tiers) {
        candidates = [];
        for (let i = 0; i < N; i++) {
          if (usage[i] === tier && !tooSimilarToNeighbor(i)) candidates.push(i);
        }
        if (candidates.length > 0) break;
      }
      // Relax 1: drop the similarity rule but still avoid identical indices
      if (candidates.length === 0) {
        for (const tier of tiers) {
          candidates = [];
          for (let i = 0; i < N; i++) {
            if (usage[i] === tier && !neighborSet.has(i)) candidates.push(i);
          }
          if (candidates.length > 0) break;
        }
      }
      // Relax 2: any color in the lowest-usage tier
      if (candidates.length === 0) {
        const minUse = Math.min(...usage);
        for (let i = 0; i < N; i++) if (usage[i] === minUse) candidates.push(i);
      }

      // Among candidates, prefer max min-distance from neighbor colors.
      // Lexicographic: colorDist (clamped) first so cross-family beats
      // same-family even when relax-1 dropped the similarity gate; then
      // colorRankDist (unclamped) so monochromatic palettes still
      // discriminate by lightness/saturation instead of tying at the cap.
      let chosen;
      if (neighborIdxs.length === 0) {
        chosen = candidates[Math.floor(rng() * candidates.length)];
      } else {
        let bestClamped = -Infinity;
        let bestRank = -Infinity;
        let bestCandidates = [];
        for (const idx of candidates) {
          let minClamped = Infinity;
          let minRank = Infinity;
          for (const nIdx of neighborIdxs) {
            const dc = colorDist(idx, nIdx);
            const dr = colorRankDist(idx, nIdx);
            if (dc < minClamped) minClamped = dc;
            if (dr < minRank) minRank = dr;
          }
          const clampedBetter = minClamped > bestClamped + 1e-9;
          const clampedTied = Math.abs(minClamped - bestClamped) < 1e-9;
          if (clampedBetter || (clampedTied && minRank > bestRank + 1e-9)) {
            bestClamped = minClamped;
            bestRank = minRank;
            bestCandidates = [idx];
          } else if (clampedTied && Math.abs(minRank - bestRank) < 1e-9) {
            bestCandidates.push(idx);
          }
        }
        chosen = bestCandidates[Math.floor(rng() * bestCandidates.length)];
      }

      assignment[device.key] = chosen;
      usage[chosen]++;
    });

    // Identify strict-distinctness edges. Two cases:
    //   - Fixture mates: user's explicit "this housing holds multiple
    //     bulbs that should never match" grouping.
    //   - Segment siblings: physically-adjacent panels of one multi-segment
    //     device (e.g. H6061 hexa). Siblings should never share a color.
    // Both outrank a spatial adjacency conflict — a violation here costs
    // FIXTURE_VIOL_COST × more in the swap pass and is force-repaired
    // afterwards.
    const parentKeyOf = (k) => {
      const m = k.match(/^(.+):seg\d+$/);
      return m ? m[1] : k;
    };
    const isSegmentKey = (k) => /:seg\d+$/.test(k);
    const keyToFixture = {};
    Object.entries(fixtures || {}).forEach(([fid, fix]) => {
      (fix.members || []).forEach(m => { keyToFixture[m] = fid; });
    });
    const mustBeDistinct = (a, b) => {
      if (a === b) return false;
      const pa = parentKeyOf(a), pb = parentKeyOf(b);
      if (isSegmentKey(a) && isSegmentKey(b) && pa === pb) return true;
      const fa = keyToFixture[pa];
      const fb = keyToFixture[pb];
      return !!(fa && fa === fb);
    };

    // Post-pass: greedy local-search swap. The forward pass is myopic —
    // when relax-1 drops the similarity gate it can leave same-family
    // colors on adjacent devices even though a global rearrangement
    // would resolve the conflict. Fixture-mate violations are weighted
    // FIXTURE_VIOL_COST × heavier than spatial violations so the swap
    // pass accepts a swap that fixes a fixture conflict even if it
    // creates a smaller non-fixture conflict elsewhere.
    const FIXTURE_VIOL_COST = 100;
    const pairCost = (a, b, ca, cb) => {
      if (ca === cb || colorDist(ca, cb) < SIMILARITY_THRESHOLD) {
        return mustBeDistinct(a, b) ? FIXTURE_VIOL_COST : 1;
      }
      return 0;
    };
    const deltaSwap = (a, b) => {
      const ca = assignment[a], cb = assignment[b];
      if (ca === cb) return 0;
      let before = 0, after = 0;
      adj[a]?.forEach(nk => {
        if (nk === b) return;
        const cn = assignment[nk];
        if (cn === undefined) return;
        before += pairCost(a, nk, ca, cn);
        after += pairCost(a, nk, cb, cn);
      });
      adj[b]?.forEach(nk => {
        if (nk === a) return;
        const cn = assignment[nk];
        if (cn === undefined) return;
        before += pairCost(b, nk, cb, cn);
        after += pairCost(b, nk, ca, cn);
      });
      return after - before;
    };
    const deviceKeys = Object.keys(assignment);
    for (let iter = 0; iter < 100; iter++) {
      let bestSwap = null;
      let bestDelta = 0;
      for (let i = 0; i < deviceKeys.length; i++) {
        for (let j = i + 1; j < deviceKeys.length; j++) {
          const d = deltaSwap(deviceKeys[i], deviceKeys[j]);
          if (d < bestDelta) {
            bestDelta = d;
            bestSwap = [deviceKeys[i], deviceKeys[j]];
          }
        }
      }
      if (!bestSwap) break;
      const [a, b] = bestSwap;
      const tmp = assignment[a];
      assignment[a] = assignment[b];
      assignment[b] = tmp;
    }

    // Final strict-distinctness repair pass. If a fixture-mate or
    // segment-sibling pair still violates the similarity gate (typical for
    // isolated fixtures and lone hexa devices where no external device
    // exists to swap with), force one member to recolor — any palette color
    // that doesn't violate against its neighbors is accepted, ignoring
    // global usage balance because strict-distinctness outranks balance.
    for (let pass = 0; pass < 8; pass++) {
      let repaired = false;
      for (const a of deviceKeys) {
        for (const b of adj[a] || []) {
          if (a >= b) continue;
          if (!mustBeDistinct(a, b)) continue;
          const ca = assignment[a], cb = assignment[b];
          if (ca !== cb && colorDist(ca, cb) >= SIMILARITY_THRESHOLD) continue;
          // Try to recolor b first, then a, with any palette color that
          // doesn't violate against its neighbors.
          let fixed = false;
          for (const target of [b, a]) {
            const otherNeighbors = [];
            (adj[target] || []).forEach(nk => {
              if (assignment[nk] !== undefined) otherNeighbors.push(assignment[nk]);
            });
            for (let i = 0; i < N; i++) {
              let ok = true;
              for (const nIdx of otherNeighbors) {
                if (i === nIdx || colorDist(i, nIdx) < SIMILARITY_THRESHOLD) { ok = false; break; }
              }
              if (ok) {
                usage[assignment[target]]--;
                assignment[target] = i;
                usage[i]++;
                fixed = true;
                repaired = true;
                break;
              }
            }
            if (fixed) break;
          }
        }
      }
      if (!repaired) break;
    }

    const result = {};
    Object.entries(assignment).forEach(([key, ci]) => {
      result[key] = colors[ci];
    });
    return result;
  }, [placedColorLights, paletteColors, buildAdjacency, fixtures, roomName, shuffleSeed]);

  // ─── Tonal mode: 8 shades of one color, randomly assigned with adjacency gap ─
  const computeTonal = useCallback(() => {
    if (placedColorLights.length === 0) return null;
    const rng = seededRng(`${roomName}|tonal|${shuffleSeed}`);
    const shades = generateTonalShades(baseColor.r, baseColor.g, baseColor.b, 8);
    const adj = buildAdjacency(placedColorLights);

    // Sort most-constrained-first (most neighbors)
    const sorted = [...placedColorLights].sort((a, b) =>
      (adj[b.key]?.size || 0) - (adj[a.key]?.size || 0)
    );

    const assignment = {}; // key → shade index
    sorted.forEach(device => {
      const neighborIndices = new Set();
      adj[device.key]?.forEach(nk => {
        if (assignment[nk] !== undefined) neighborIndices.add(assignment[nk]);
      });

      // Shuffle shade indices, then pick the first that is ≥2 steps from every neighbor
      const indices = Array.from({ length: 8 }, (_, i) => i);
      for (let i = 7; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }

      let chosen = -1;
      for (const idx of indices) {
        const tooClose = [...neighborIndices].some(n => Math.abs(idx - n) < 2);
        if (!tooClose) { chosen = idx; break; }
      }
      if (chosen === -1) chosen = indices[0]; // fallback
      assignment[device.key] = chosen;
    });

    const result = {};
    Object.entries(assignment).forEach(([key, idx]) => { result[key] = shades[idx]; });
    return result;
  }, [placedColorLights, baseColor, buildAdjacency, roomName, shuffleSeed]);

  // ─── Beacon mode: one color, brightness falls off with distance from source ─
  const computeBeacon = useCallback(() => {
    if (placedColorLights.length === 0) return null;
    const source = placedColorLights.find(d => d.key === beaconSourceKey) || placedColorLights[0];

    const dists = placedColorLights.map(d => {
      if (isLinear) return Math.abs(d.x - source.x);
      const dx = d.x - source.x;
      const dy = d.y - source.y;
      return Math.sqrt(dx * dx + dy * dy);
    });
    const maxDist = Math.max(...dists, 0.0001);

    const result = {};
    placedColorLights.forEach((d, i) => {
      const t = dists[i] / maxDist; // 0 at source, 1 at far edge
      const bri = Math.round(brightness * (1 - t) + 5 * t);
      result[d.key] = { r: baseColor.r, g: baseColor.g, b: baseColor.b,
        brightness: Math.max(5, Math.min(100, bri)) };
    });
    return result;
  }, [placedColorLights, baseColor, beaconSourceKey, brightness, isLinear]);

  // ─── Custom mode: 1-4 seed colors, assigned as a simple repeating cycle.
  // Devices are ordered spatially and colored A,B,C,A,B,C… along that order
  // so the result reads as a clean repeating pattern (the thing people
  // actually expect from "use my 2-3 colors"). No adjacency graph here —
  // the positional cycle inherently keeps neighbors distinct:
  //   • Linear layouts sort left-to-right → ABABAB / ABCABC down the strip.
  //   • Floor plans sort row-major (top→bottom, then left→right) and shift
  //     each row by one so the pattern staggers into a checkerboard/diagonal
  //     instead of stacking the same color vertically.
  // "Shades" mode advances to a fresh tonal shade on each wrap of the
  // palette so repeats of a seed aren't identical. Shuffle rotates the
  // starting phase so a re-roll gives a different-but-still-repeating
  // proposal. ─────────────────────────────────────────────────────────
  const computeCustom = useCallback(() => {
    if (placedColorLights.length === 0 || customColors.length === 0) return null;
    const M = customColors.length;
    const exact = customShadeMode === "exact";
    const SHADES_PER_SEED = exact ? 1 : 4;

    // Each seed slot is either a color ({r,g,b}) or a white temperature
    // ({r,g,b,kelvin} — r/g/b is the kelvinToRGB approximation for display,
    // kelvin drives the real CT command on apply). In "exact" mode each seed
    // contributes only itself; in "shades" mode color slots get a tonal range
    // and white slots get a few temperature steps spanning ±~600K.
    const ctE = (k) => ({ ...kelvinToRGB(k), kelvin: k });
    const shadesBySeed = customColors.map(c => {
      const isWhite = c.kelvin != null;
      if (exact) return [isWhite ? ctE(c.kelvin) : c];
      if (isWhite) {
        const lo = Math.max(CT_MIN_K, c.kelvin - 600);
        const hi = Math.min(CT_MAX_K, c.kelvin + 600);
        return spreadKelvin(lo, hi, SHADES_PER_SEED).map(ctE);
      }
      return generateTonalShades(c.r, c.g, c.b, SHADES_PER_SEED);
    });

    // Spatial order. Floor plans bucket y into rows (devices roughly level
    // count as one row) so a row reads left-to-right before dropping down.
    const ROW = 1.5; // grid units that count as "the same row"
    const rowOf = (d) => (isLinear ? 0 : Math.round(d.y / ROW));
    const ordered = [...placedColorLights].sort((a, b) => {
      const ra = rowOf(a), rb = rowOf(b);
      if (ra !== rb) return ra - rb;
      if (a.x !== b.x) return a.x - b.x;
      return a.y - b.y;
    });

    // Shuffle rotates which color the cycle starts on — EXCEPT in a linear
    // layout, where custom colors map in order to the lights left-to-right
    // (color 1 → leftmost light/segment, color 2 → second, …). So the line
    // starts on color 0 with no rotation; Shuffle doesn't reorder it.
    const offset = isLinear ? 0 : Math.floor(seededRng(`${roomName}|custom|${shuffleSeed}`)() * M);

    const result = {};
    let rowKey = null, rowNum = 0, col = 0;
    ordered.forEach((d) => {
      const r = rowOf(d);
      if (rowKey === null) rowKey = r;
      else if (r !== rowKey) { rowKey = r; rowNum++; col = 0; }
      // Per-row shift (rowNum) staggers the pattern in 2D so vertically
      // adjacent rows don't line up the same color.
      const phase = col + rowNum + offset;
      const seedIdx = ((phase % M) + M) % M;
      const shadeIdx = exact ? 0 : Math.floor(phase / M) % SHADES_PER_SEED;
      result[d.key] = shadesBySeed[seedIdx][shadeIdx];
      col++;
    });
    return result;
  }, [placedColorLights, customColors, customShadeMode, roomName, shuffleSeed, isLinear]);

  // ─── Preset modes (Teams / NCAA / Flags) ────────────────────────────
  // Assign an array of exact colors across devices using the same spatial
  // repeating cycle as Custom mode (A,B,C,A,B,C…, row-staggered so neighbors
  // differ). Exact colors only — no shades. Shuffle rotates the start color.
  const cycleAssign = useCallback((colors, seedKey, shadeMode = "exact") => {
    if (placedColorLights.length === 0 || !colors || colors.length === 0) return null;
    const M = colors.length;
    const exact = shadeMode !== "shades";
    const SHADES_PER_SEED = exact ? 1 : 4;
    // exact → each color is itself; shades → a tonal range per color, advanced
    // on each wrap of the cycle so repeats aren't identical (as in Custom mode).
    const shadesBySeed = colors.map(c =>
      exact ? [c] : generateTonalShades(c.r, c.g, c.b, SHADES_PER_SEED)
    );
    const ROW = 1.5;
    const rowOf = (d) => (isLinear ? 0 : Math.round(d.y / ROW));
    const ordered = [...placedColorLights].sort((a, b) => {
      const ra = rowOf(a), rb = rowOf(b);
      if (ra !== rb) return ra - rb;
      if (a.x !== b.x) return a.x - b.x;
      return a.y - b.y;
    });
    const offset = Math.floor(seededRng(`${roomName}|${seedKey}|${shuffleSeed}`)() * M);
    const result = {};
    let rowKey = null, rowNum = 0, col = 0;
    ordered.forEach((d) => {
      const r = rowOf(d);
      if (rowKey === null) rowKey = r;
      else if (r !== rowKey) { rowKey = r; rowNum++; col = 0; }
      const phase = col + rowNum + offset;
      const seedIdx = ((phase % M) + M) % M;
      const shadeIdx = exact ? 0 : Math.floor(phase / M) % SHADES_PER_SEED;
      result[d.key] = { ...shadesBySeed[seedIdx][shadeIdx] };
      col++;
    });
    return result;
  }, [placedColorLights, roomName, shuffleSeed, isLinear]);

  const computeTeams = useCallback(() => {
    const t = PRESET_TEAMS.find(x => x.name === selectedTeam);
    return t ? cycleAssign(presetColors(t.colors), `teams|${selectedTeam}`, customShadeMode) : null;
  }, [cycleAssign, selectedTeam, customShadeMode]);
  const computeNcaa = useCallback(() => {
    const t = PRESET_NCAA.find(x => x.name === selectedNcaa);
    return t ? cycleAssign(presetColors(t.colors), `ncaa|${selectedNcaa}`, customShadeMode) : null;
  }, [cycleAssign, selectedNcaa, customShadeMode]);
  const computeFlags = useCallback(() => {
    const t = PRESET_FLAGS.find(x => x.name === selectedFlag);
    return t ? cycleAssign(presetColors(t.colors), `flags|${selectedFlag}`, customShadeMode) : null;
  }, [cycleAssign, selectedFlag, customShadeMode]);

  // ─── White (color-temperature) compute variants ─────────────────────
  // Entries carry { r, g, b, kelvin } — r/g/b is the display approximation
  // (kelvinToRGB), kelvin drives the real CT command on Apply.
  const ctEntry = (k) => ({ ...kelvinToRGB(k), kelvin: k });

  // Assign a pool of CT entries across devices, tonal-style: most-constrained
  // first, preferring a ≥gap index distance from already-assigned neighbors.
  const assignCTPool = useCallback((entries) => {
    if (placedColorLights.length === 0 || entries.length === 0) return null;
    const rng = seededRng(`${roomName}|ct|${shuffleSeed}`);
    const n = entries.length;
    const adj = buildAdjacency(placedColorLights);
    const sorted = [...placedColorLights].sort((a, b) =>
      (adj[b.key]?.size || 0) - (adj[a.key]?.size || 0));
    const gap = n >= 4 ? 2 : 1;
    const assignment = {};
    sorted.forEach(device => {
      const neighborIdx = new Set();
      adj[device.key]?.forEach(nk => {
        if (assignment[nk] !== undefined) neighborIdx.add(assignment[nk]);
      });
      const indices = Array.from({ length: n }, (_, i) => i);
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }
      let chosen = indices.find(idx => ![...neighborIdx].some(nn => Math.abs(idx - nn) < gap));
      if (chosen === undefined) chosen = indices[0];
      assignment[device.key] = chosen;
    });
    const result = {};
    Object.entries(assignment).forEach(([key, idx]) => { result[key] = { ...entries[idx] }; });
    return result;
  }, [placedColorLights, buildAdjacency, roomName, shuffleSeed]);

  // ─── Color-temperature (White) compute ──────────────────────────────────────
  // "Your scientists were so preoccupied with whether or not they could, they
  //  didn't stop to think if they should." — Dr. Ian Malcolm, Jurassic Park.
  // After all the hue/palette/adjacency machinery, it turns out a lot of people
  // just want plain tunable white. These mirror the RGB compute fns above but
  // emit Kelvin entries (kelvinToRGB approximation for display, real CT on apply).
  const computePaletteCT = useCallback(() => {
    const p = CT_PALETTES[ctPreset] || CT_PALETTES[0];
    const poolSize = Math.max(2, Math.min(6, placedColorLights.length));
    return assignCTPool(spreadKelvin(p.min, p.max, poolSize).map(ctEntry));
  }, [ctPreset, placedColorLights, assignCTPool]);

  const computeTonalCT = useCallback(() => {
    return assignCTPool(spreadKelvin(CT_MIN_K, CT_MAX_K, 8).map(ctEntry));
  }, [placedColorLights, assignCTPool]);

  const computeCustomCT = useCallback(() => {
    const poolSize = Math.max(2, Math.min(8, placedColorLights.length));
    return assignCTPool(spreadKelvin(CT_MIN_K, maxKelvin, poolSize).map(ctEntry));
  }, [maxKelvin, placedColorLights, assignCTPool]);

  const computeGradientCT = useCallback(() => {
    if (placedColorLights.length === 0) return null;
    const dirVectors = {
      "left-right": { dx: 1, dy: 0 }, "right-left": { dx: -1, dy: 0 },
      "top-bottom": { dx: 0, dy: 1 }, "bottom-top": { dx: 0, dy: -1 },
      "center-out": null,
    };
    const count = placedColorLights.length;
    const temps = spreadKelvin(CT_MIN_K, maxKelvin, count); // warm → maxKelvin across span
    let sorted;
    if (direction === "center-out") {
      const cx = placedColorLights.reduce((s, d) => s + d.x, 0) / count;
      const cy = placedColorLights.reduce((s, d) => s + d.y, 0) / count;
      sorted = placedColorLights.map(d => ({ key: d.key, proj: Math.sqrt((d.x - cx) ** 2 + (d.y - cy) ** 2) }))
        .sort((a, b) => a.proj - b.proj);
    } else {
      const vec = dirVectors[direction] || dirVectors["left-right"];
      sorted = placedColorLights.map(d => ({ key: d.key, proj: d.x * vec.dx + d.y * vec.dy }))
        .sort((a, b) => a.proj - b.proj);
    }
    const result = {};
    sorted.forEach((item, i) => { result[item.key] = ctEntry(temps[i]); });
    return result;
  }, [placedColorLights, maxKelvin, direction]);

  const computeBeaconCT = useCallback(() => {
    if (placedColorLights.length === 0) return null;
    const source = placedColorLights.find(d => d.key === beaconSourceKey) || placedColorLights[0];
    const dists = placedColorLights.map(d => {
      if (isLinear) return Math.abs(d.x - source.x);
      return Math.sqrt((d.x - source.x) ** 2 + (d.y - source.y) ** 2);
    });
    const maxDist = Math.max(...dists, 0.0001);
    const result = {};
    placedColorLights.forEach((d, i) => {
      const t = dists[i] / maxDist;
      const bri = Math.max(5, Math.min(100, Math.round(brightness * (1 - t) + 5 * t)));
      result[d.key] = { ...ctEntry(maxKelvin), brightness: bri };
    });
    return result;
  }, [placedColorLights, beaconSourceKey, brightness, maxKelvin, isLinear]);

  const computeForModeCT = () => {
    if (mode === "gradient") return computeGradientCT();
    if (mode === "tonal") return computeTonalCT();
    if (mode === "beacon") return computeBeaconCT();
    if (mode === "custom") return computeCustomCT();
    return computePaletteCT();
  };

  // Auto-pick a beacon source when entering Beacon mode or when the layout changes
  // and the current source is no longer placed.
  useEffect(() => {
    if (mode !== "beacon") return;
    const hasCurrent = beaconSourceKey && placedColorLights.some(d => d.key === beaconSourceKey);
    if (!hasCurrent && placedColorLights.length > 0) {
      setBeaconSourceKey(placedColorLights[0].key);
    }
  }, [mode, layout, fixtures]);

  // ─── Generate preview ───────────────────────────────────────────────
  const computeForMode = () => {
    // Preset modes are exact-color only — they ignore the Color/White space.
    if (mode === "teams") return computeTeams();
    if (mode === "ncaa") return computeNcaa();
    if (mode === "flags") return computeFlags();
    if (colorSpace === "white") return computeForModeCT();
    if (mode === "gradient") return computeGradient();
    if (mode === "tonal") return computeTonal();
    if (mode === "beacon") return computeBeacon();
    if (mode === "custom") return computeCustom();
    return computePalette();
  };
  const pipeline = (raw) => {
    // Order matters: clamp saturation first (so per-device overrides start from
    // clean colors), then apply per-device fill mode.
    //
    // The min-saturation floor only applies to the GENERATED-shade modes (tonal,
    // gradient): it exists to stop shades derived from one base color from
    // drifting near-white. It must NOT touch colors the user explicitly chose and
    // can see as swatches — palette, custom, beacon, and the preset team/flag
    // modes apply VERBATIM so "what you see is what gets set". (White entries are
    // intentionally low-saturation; applyMinSat already leaves those alone.)
    const generatedShades = mode === "tonal" || mode === "gradient";
    const sat = generatedShades ? applyMinSat(raw, minSatEnabled, minSatPct) : raw;
    return applySegmentFillModes(sat, segmentFillModes);
  };
  const generatePreview = () => {
    setPreview(pipeline(computeForMode()));
  };

  // Auto-generate preview when inputs change
  useEffect(() => {
    if (!hasLayout) return;
    setPreview(pipeline(computeForMode()));
  }, [mode, colorSpace, ctPreset, maxKelvin, baseColor, direction, paletteColors, customColors, customShadeMode, hasLayout, layout, fixtures, beaconSourceKey, brightness, addressSegments, minSatEnabled, minSatPct, segmentFillModes, shuffleSeed, targetVendor, selectedTeam, selectedNcaa, selectedFlag]);

  // Human-readable name for a preview key ("hue:5", "govee:ip", "govee:ip:seg3")
  // used in the live apply-progress label.
  const nameForKey = (key) => {
    const m = key.match(/^(.+):seg(\d+)$/);
    const parentKey = m ? m[1] : key;
    const light = lightMap[parentKey];
    const base = nicknames?.[parentKey] || light?.name
      || (light?.sku ? GOVEE_SKU_NAMES?.[light.sku] : null) || parentKey;
    if (!m) return base;
    // Hexa panels say "panel"; everything else (globe/string, outdoor spots,
    // rope) is a strip of "segments".
    const unit = light?.sku === "H6061" ? "panel" : "segment";
    return `${base} · ${unit} ${parseInt(m[2]) + 1}`;
  };

  // Cancel a running server-side apply for this room.
  const cancelApply = () => {
    api("/scenes/room-apply/cancel", {
      method: "POST",
      body: JSON.stringify({ room: roomName }),
      headers: { "Content-Type": "application/json" },
    }).catch(e => console.warn("[ColorMode] cancel failed:", e));
    setApplying(false);
    setApplyPhase(null);
    setApplyLabel("");
  };

  // ─── Apply colors to lights ─────────────────────────────────────────
  // The frontend resolves the preview into a plan and POSTs it once; the
  // BACKEND owns all the timing (base color → hold → staggered Govee whole-
  // device and cloud_v2 segment batches) in a background task. So you can close
  // the browser right after pressing Apply and the lights still fill in. Live
  // progress arrives back over SSE (see the scene_apply effect above).
  const applyColors = () => {
    if (!preview || applying) return;
    const entries = Object.entries(preview);

    // Group preview entries by destination so the backend can schedule each:
    //   Hue (REST, fast), Govee whole-device (LAN), Govee segments split by
    //   protocol — razer (one bulk LAN packet) vs cloud_v2 (rate-limited V2 API).
    const segmentEntries = entries.filter(([key]) => /^govee:.+:seg\d+$/.test(key));
    const hueEntries = entries.filter(([key]) => key.startsWith("hue:"));
    const goveeEntries = entries.filter(([key]) => /^govee:[^:]+$/.test(key));

    const segGroups = {};
    segmentEntries.forEach(([key, color]) => {
      const m = key.match(/^(govee:[^:]+):seg(\d+)$/);
      if (!m) return;
      (segGroups[m[1]] ||= []).push({ idx: parseInt(m[2]), color });
    });
    const razerGroups = [], cloudGroups = [];
    Object.entries(segGroups).forEach(([parent, segs]) => {
      const light = lightMap[parent];
      const proto = light?.sku && segmentInfo?.sku_table?.[light.sku]?.protocol;
      if (proto === "razer") razerGroups.push({ parent, light, segs });
      else cloudGroups.push({ parent, light, segs });
    });

    const applyCount = hueEntries.length + goveeEntries.length + segmentEntries.length;
    if (applyCount === 0) return;

    // ─── Build the plan (the backend owns all timing) ───────────────────
    // Phase-1 base color: seed each cloud device with one of ITS OWN scene
    // colors (the middle segment), sent fast whole-device, so the strip looks
    // like the scene immediately while segments fill in (no blue-white flash).
    const base_seeds = [];
    cloudGroups.forEach(({ light, segs }) => {
      if (!light) return;
      const seed = (segs[Math.floor(segs.length / 2)] || segs[0])?.color;
      if (!seed) { base_seeds.push({ ip: light.ip, r: 255, g: 255, b: 255 }); return; }
      base_seeds.push(seed.kelvin != null
        ? { ip: light.ip, color_temp_kelvin: seed.kelvin, brightness: seed.brightness ?? brightness }
        : { ip: light.ip, r: seed.r, g: seed.g, b: seed.b, brightness: seed.brightness ?? brightness });
    });

    // Hue: RGB, or true CT (mireds) for tunable-white lights in white mode.
    const hue = [];
    hueEntries.forEach(([key, color]) => {
      const light = lightMap[key];
      if (!light) return;
      const bri = Math.round((color.brightness ?? brightness) * 254 / 100);
      hue.push(color.kelvin != null && light.capabilities?.has_color_temp
        ? { light_id: key.slice(4), on: true, color_temp: kelvinToMired(color.kelvin), brightness: bri, label: nameForKey(key) }
        : { light_id: key.slice(4), on: true, r: color.r, g: color.g, b: color.b, brightness: bri, label: nameForKey(key) });
    });

    // Govee whole-device: RGB or color_temp_kelvin (server resolves ct_rgb).
    const govee_whole = [];
    goveeEntries.forEach(([key, color]) => {
      const light = lightMap[key];
      if (!light) return;
      govee_whole.push(color.kelvin != null
        ? { ip: light.ip, on: true, color_temp_kelvin: color.kelvin, brightness: color.brightness ?? brightness, label: nameForKey(key) }
        : { ip: light.ip, on: true, r: color.r, g: color.g, b: color.b, brightness: color.brightness ?? brightness, label: nameForKey(key) });
    });

    // Razer: one bulk packet per device, full N segments (missing → black).
    // Per-entry (beacon) dimming folded into RGB; device brightness sent apart.
    const razer = [];
    razerGroups.forEach(({ parent, light, segs }) => {
      if (!light) return;
      const segCountFromInfo = segmentInfo?.sku_table?.[light.sku]?.count || segs.length;
      const colors = Array.from({ length: segCountFromInfo }, () => [0, 0, 0]);
      segs.forEach(({ idx, color }) => {
        const f = color.brightness !== undefined ? color.brightness / 100 : 1;
        colors[idx] = [Math.round(color.r * f), Math.round(color.g * f), Math.round(color.b * f)];
      });
      razer.push({ ip: light.ip, sku: light.sku, colors, brightness, label: nameForKey(parent) });
    });

    // Cloud_v2: batch segments by color so each distinct color is ONE V2 call.
    const cloud = [];
    cloudGroups.forEach(({ parent, light, segs }) => {
      if (!light) return;
      const byColor = new Map();
      segs.forEach(({ idx, color }) => {
        const f = color.brightness !== undefined ? color.brightness / 100 : 1;
        const rr = Math.round(color.r * f), gg = Math.round(color.g * f), bb = Math.round(color.b * f);
        // Calibrated CT only when the segment isn't dimmed (f === 1); a dimmed
        // beacon segment must send the pre-scaled RGB.
        const useKelvin = color.kelvin != null && f === 1;
        const ckey = useKelvin ? `k${color.kelvin}` : `${rr},${gg},${bb}`;
        if (!byColor.has(ckey)) byColor.set(ckey, { segments: [], r: rr, g: gg, b: bb, color_temp_kelvin: useKelvin ? color.kelvin : undefined });
        byColor.get(ckey).segments.push(idx);
      });
      cloud.push({
        ip: light.ip, sku: light.sku, device_mac: light.mac,
        unit: light.sku === "H6061" ? "panel" : "segment",
        label: nameForKey(parent),
        groups: [...byColor.values()],
      });
    });

    // Optimistic local progress + rough ETA until the first SSE event lands
    // (matches the backend's estimate so the countdown doesn't jump).
    const cloudGroupCount = cloud.reduce((s, d) => s + d.groups.length, 0);
    const roughMs = (base_seeds.length ? 600 : 0) + (cloudGroupCount ? 2000 : 0)
      + Math.max(cloudGroupCount ? (cloudGroupCount - 1) * 1800 + 100 : 0,
                 govee_whole.length ? (govee_whole.length - 1) * 150 + 200 : 0,
                 hue.length ? 50 : 0);
    setApplying(true);
    setApplyPhase(base_seeds.length ? "resetting" : "applying");
    setApplyTotal(applyCount);
    setApplyDone(0);
    setApplyLabel("Starting…");
    setApplyEndAt(Date.now() + Math.max(roughMs, 300));
    setTickNow(Date.now());

    // One POST. The backend runs the staggered apply in a background task and
    // streams progress back over SSE — so the browser can be closed now.
    api("/scenes/room-apply", {
      method: "POST",
      body: JSON.stringify({ room: roomName, brightness, base_seeds, hue, govee_whole, razer, cloud }),
      headers: { "Content-Type": "application/json" },
    }).catch(e => {
      console.warn("[ColorMode] room-apply failed:", e);
      setApplying(false); setApplyPhase(null); setApplyLabel("");
    });

    // Notify map so it updates dot colors and clears Identify active state.
    // The third arg is a display-only snapshot of the current selection so the
    // backend can pre-select the same palette/mode on another device.
    const colorStateSnapshot = {
      mode,
      color_space: colorSpace,
      palette_colors: paletteColors,
      base_color: baseColor,
      brightness,
      direction,
      address_segments: addressSegments,
      shuffle_seed: shuffleSeed,
      target_vendor: targetVendor,
      selected_team: selectedTeam,
      selected_ncaa: selectedNcaa,
      selected_flag: selectedFlag,
      // Per-mode settings so custom/beacon/white/shade toggle rehydrate too.
      custom_colors: customColors,
      custom_shade_mode: customShadeMode,
      beacon_source_key: beaconSourceKey,
      max_kelvin: maxKelvin,
      ct_preset: ctPreset,
    };
    if (onApply) onApply(preview, addressSegments, colorStateSnapshot);
  };

  // ─── Palette color management ───────────────────────────────────────
  // Adding a color pulls from paletteSource first (restoring a previously
  // trimmed color). Only if source is exhausted do we generate a new one.
  const addPaletteColor = () => {
    if (paletteColors.length >= 24) return;
    const newCount = paletteColors.length + 1;
    if (paletteSource.length >= newCount) {
      setPaletteColors(paletteSource.slice(0, newCount));
    } else {
      const newSource = extendPalette(paletteSource, newCount);
      setPaletteSource(newSource);
      setPaletteColors(newSource.slice(0, newCount));
    }
  };

  // Explicit × removal on a swatch: drop from both visible and source
  // (user is explicitly discarding this color from memory).
  const removePaletteColor = (idx) => {
    if (paletteColors.length <= 2) return;
    setPaletteColors(prev => prev.filter((_, i) => i !== idx));
    setPaletteSource(prev => prev.filter((_, i) => i !== idx));
    if (editingPaletteIdx === idx) setEditingPaletteIdx(null);
    else if (editingPaletteIdx !== null && editingPaletteIdx > idx) setEditingPaletteIdx(editingPaletteIdx - 1);
  };

  // Stepper − removes only from the visible set, preserving source memory
  // so the user can grow back to the original palette.
  const removeLastPaletteColor = () => {
    if (paletteColors.length <= 2) return;
    const lastIdx = paletteColors.length - 1;
    setPaletteColors(prev => prev.slice(0, -1));
    if (editingPaletteIdx === lastIdx) setEditingPaletteIdx(null);
  };

  const updatePaletteColor = (idx, r, g, b) => {
    setPaletteColors(prev => prev.map((c, i) => i === idx ? { r, g, b } : c));
    setPaletteSource(prev => prev.map((c, i) => i === idx ? { r, g, b } : c));
  };

  // ─── Curated palette library — categorized, 8 colors each ──────────────────
  // To add a palette: append to the appropriate category block. To feature it
  // in the default "Featured" view, add featured: true.
  const paletteLibrary = [
    // Spring
    { name: "Easter Pastel", category: "Spring", featured: true, colors: [{r:230,g:180,b:230},{r:160,g:220,b:190},{r:160,g:210,b:240},{r:255,g:235,b:150},{r:255,g:200,b:210},{r:255,g:210,b:180},{r:200,g:170,b:240},{r:180,g:240,b:180}] },
    { name: "Spring Bloom", category: "Spring", colors: [{r:255,g:175,b:200},{r:255,g:220,b:40},{r:100,g:195,b:100},{r:120,g:160,b:235},{r:255,g:140,b:120},{r:255,g:245,b:180},{r:80,g:200,b:170},{r:160,g:100,b:220}] },
    { name: "Easter Egg", category: "Spring", colors: [{r:240,g:130,b:160},{r:120,g:170,b:240},{r:200,g:145,b:235},{r:100,g:215,b:175},{r:255,g:170,b:80},{r:220,g:190,b:60},{r:255,g:100,b:130},{r:80,g:220,b:230}] },
    { name: "Spring Garden", category: "Spring", colors: [{r:195,g:135,b:255},{r:255,g:155,b:130},{r:155,g:230,b:165},{r:135,g:200,b:255},{r:255,g:225,b:80},{r:255,g:180,b:180},{r:160,g:240,b:200},{r:100,g:180,b:255}] },
    { name: "Cherry Blossom", category: "Spring", colors: [{r:255,g:200,b:220},{r:255,g:170,b:200},{r:255,g:230,b:240},{r:200,g:130,b:170},{r:240,g:180,b:200},{r:180,g:140,b:170},{r:255,g:240,b:245},{r:200,g:160,b:190}] },
    { name: "Daffodil", category: "Spring", colors: [{r:255,g:230,b:80},{r:255,g:200,b:50},{r:255,g:245,b:160},{r:140,g:200,b:90},{r:255,g:180,b:30},{r:200,g:235,b:130},{r:255,g:215,b:0},{r:160,g:210,b:80}] },
    { name: "Tulip Field", category: "Spring", colors: [{r:230,g:50,b:80},{r:255,g:140,b:60},{r:255,g:220,b:80},{r:200,g:80,b:160},{r:120,g:200,b:80},{r:80,g:170,b:230},{r:200,g:50,b:120},{r:255,g:180,b:200}] },
    { name: "Morning Dew", category: "Spring", colors: [{r:200,g:240,b:230},{r:160,g:220,b:200},{r:140,g:200,b:220},{r:200,g:230,b:180},{r:230,g:240,b:220},{r:120,g:200,b:180},{r:180,g:230,b:240},{r:160,g:240,b:210}] },
    { name: "Lavender Field", category: "Spring", colors: [{r:200,g:160,b:240},{r:160,g:120,b:220},{r:220,g:180,b:255},{r:140,g:100,b:200},{r:200,g:200,b:240},{r:180,g:140,b:230},{r:240,g:200,b:255},{r:120,g:80,b:180}] },
    { name: "Robin's Egg", category: "Spring", colors: [{r:140,g:220,b:230},{r:180,g:230,b:240},{r:120,g:200,b:220},{r:200,g:240,b:240},{r:160,g:210,b:230},{r:100,g:180,b:200},{r:220,g:240,b:240},{r:140,g:200,b:220}] },

    // Summer
    { name: "Tropical", category: "Summer", featured: true, colors: [{r:255,g:100,b:100},{r:255,g:200,b:50},{r:50,g:200,b:200},{r:80,g:230,b:120},{r:255,g:140,b:50},{r:255,g:80,b:160},{r:130,g:230,b:240},{r:255,g:230,b:100}] },
    { name: "Beach Day", category: "Summer", colors: [{r:255,g:230,b:180},{r:80,g:200,b:240},{r:255,g:180,b:120},{r:140,g:230,b:240},{r:255,g:240,b:200},{r:80,g:180,b:200},{r:255,g:200,b:140},{r:160,g:220,b:255}] },
    { name: "Watermelon", category: "Summer", featured: true, colors: [{r:255,g:80,b:100},{r:80,g:200,b:80},{r:255,g:130,b:140},{r:50,g:180,b:60},{r:255,g:200,b:200},{r:120,g:230,b:120},{r:200,g:40,b:60},{r:50,g:140,b:50}] },
    { name: "Lemonade", category: "Summer", colors: [{r:255,g:240,b:80},{r:200,g:230,b:90},{r:255,g:220,b:140},{r:255,g:180,b:120},{r:255,g:255,b:200},{r:160,g:220,b:60},{r:255,g:200,b:50},{r:200,g:240,b:160}] },
    { name: "Coral Reef", category: "Summer", colors: [{r:255,g:120,b:100},{r:80,g:200,b:200},{r:255,g:180,b:140},{r:100,g:220,b:180},{r:255,g:140,b:160},{r:140,g:230,b:230},{r:230,g:90,b:80},{r:80,g:180,b:170}] },
    { name: "Surf & Sand", category: "Summer", colors: [{r:230,g:210,b:170},{r:80,g:170,b:200},{r:255,g:230,b:190},{r:60,g:140,b:180},{r:200,g:180,b:140},{r:120,g:200,b:220},{r:255,g:240,b:210},{r:40,g:120,b:160}] },
    { name: "Pool Party", category: "Summer", colors: [{r:0,g:200,b:240},{r:255,g:100,b:160},{r:255,g:230,b:80},{r:80,g:240,b:200},{r:255,g:160,b:80},{r:140,g:220,b:255},{r:255,g:80,b:120},{r:60,g:200,b:160}] },
    { name: "Mango", category: "Summer", colors: [{r:255,g:170,b:50},{r:255,g:120,b:80},{r:255,g:220,b:100},{r:255,g:200,b:80},{r:200,g:240,b:80},{r:255,g:140,b:60},{r:255,g:160,b:120},{r:230,g:180,b:60}] },
    { name: "Hibiscus", category: "Summer", colors: [{r:255,g:60,b:120},{r:255,g:140,b:80},{r:255,g:200,b:60},{r:200,g:60,b:160},{r:80,g:200,b:120},{r:255,g:80,b:60},{r:255,g:180,b:200},{r:200,g:80,b:200}] },
    { name: "Citrus", category: "Summer", colors: [{r:255,g:180,b:0},{r:255,g:230,b:60},{r:200,g:240,b:60},{r:255,g:140,b:0},{r:255,g:200,b:80},{r:140,g:220,b:40},{r:255,g:220,b:120},{r:200,g:230,b:80}] },

    // Autumn
    { name: "Autumn", category: "Autumn", featured: true, colors: [{r:205,g:92,b:40},{r:255,g:140,b:0},{r:180,g:60,b:30},{r:218,g:165,b:32},{r:160,g:80,b:20},{r:240,g:120,b:30},{r:140,g:60,b:20},{r:240,g:185,b:50}] },
    { name: "Pumpkin Spice", category: "Autumn", colors: [{r:255,g:130,b:50},{r:200,g:100,b:40},{r:160,g:80,b:40},{r:255,g:170,b:80},{r:140,g:70,b:30},{r:220,g:140,b:60},{r:200,g:80,b:30},{r:255,g:200,b:120}] },
    { name: "Harvest Moon", category: "Autumn", colors: [{r:240,g:180,b:60},{r:200,g:120,b:40},{r:255,g:200,b:100},{r:160,g:100,b:30},{r:240,g:160,b:50},{r:120,g:60,b:20},{r:255,g:220,b:140},{r:200,g:140,b:60}] },
    { name: "Maple", category: "Autumn", colors: [{r:200,g:50,b:30},{r:255,g:100,b:30},{r:200,g:120,b:30},{r:160,g:50,b:20},{r:255,g:140,b:50},{r:140,g:30,b:10},{r:218,g:165,b:32},{r:200,g:80,b:20}] },
    { name: "Spiced Cider", category: "Autumn", colors: [{r:160,g:80,b:30},{r:200,g:120,b:60},{r:255,g:170,b:80},{r:120,g:60,b:30},{r:200,g:140,b:80},{r:140,g:80,b:40},{r:220,g:160,b:90},{r:160,g:100,b:50}] },
    { name: "Falling Leaves", category: "Autumn", colors: [{r:255,g:140,b:30},{r:200,g:60,b:30},{r:240,g:200,b:60},{r:140,g:80,b:30},{r:255,g:180,b:60},{r:160,g:50,b:20},{r:200,g:140,b:40},{r:240,g:120,b:30}] },
    { name: "Cornfield", category: "Autumn", colors: [{r:240,g:200,b:80},{r:200,g:160,b:60},{r:255,g:230,b:140},{r:160,g:120,b:40},{r:240,g:180,b:60},{r:140,g:110,b:40},{r:255,g:215,b:100},{r:200,g:170,b:80}] },
    { name: "Cranberry", category: "Autumn", colors: [{r:200,g:30,b:50},{r:160,g:30,b:50},{r:240,g:80,b:80},{r:140,g:30,b:30},{r:200,g:60,b:80},{r:255,g:120,b:120},{r:160,g:40,b:50},{r:200,g:80,b:100}] },
    { name: "Rust Belt", category: "Autumn", colors: [{r:160,g:60,b:30},{r:120,g:50,b:30},{r:200,g:90,b:50},{r:140,g:80,b:50},{r:180,g:100,b:60},{r:100,g:50,b:30},{r:220,g:120,b:70},{r:160,g:80,b:50}] },
    { name: "Apple Orchard", category: "Autumn", colors: [{r:200,g:40,b:40},{r:140,g:200,b:60},{r:240,g:180,b:80},{r:160,g:80,b:40},{r:255,g:120,b:80},{r:120,g:160,b:40},{r:200,g:200,b:120},{r:200,g:90,b:40}] },

    // Winter
    { name: "Frostbite", category: "Winter", featured: true, colors: [{r:200,g:230,b:255},{r:140,g:200,b:240},{r:230,g:240,b:255},{r:100,g:170,b:220},{r:180,g:220,b:240},{r:200,g:240,b:255},{r:120,g:180,b:230},{r:240,g:250,b:255}] },
    { name: "Snowfall", category: "Winter", colors: [{r:240,g:240,b:255},{r:200,g:220,b:240},{r:255,g:255,b:255},{r:180,g:200,b:230},{r:230,g:230,b:240},{r:160,g:180,b:210},{r:220,g:230,b:250},{r:140,g:160,b:200}] },
    { name: "Pine", category: "Winter", colors: [{r:30,g:120,b:60},{r:60,g:150,b:80},{r:50,g:100,b:60},{r:90,g:170,b:110},{r:40,g:130,b:70},{r:120,g:190,b:130},{r:70,g:130,b:80},{r:140,g:200,b:140}] },
    { name: "Icicle", category: "Winter", colors: [{r:200,g:240,b:255},{r:100,g:200,b:240},{r:160,g:220,b:255},{r:80,g:170,b:230},{r:220,g:250,b:255},{r:120,g:200,b:230},{r:90,g:180,b:230},{r:200,g:230,b:255}] },
    { name: "Glacier", category: "Winter", colors: [{r:140,g:200,b:230},{r:100,g:170,b:210},{r:200,g:230,b:240},{r:80,g:150,b:190},{r:120,g:180,b:220},{r:60,g:130,b:170},{r:160,g:210,b:230},{r:100,g:160,b:200}] },
    { name: "Arctic Aurora", category: "Winter", colors: [{r:80,g:240,b:200},{r:120,g:160,b:240},{r:60,g:200,b:240},{r:160,g:240,b:200},{r:80,g:140,b:220},{r:200,g:240,b:220},{r:120,g:200,b:240},{r:60,g:180,b:220}] },
    { name: "Fireside", category: "Winter", colors: [{r:255,g:120,b:40},{r:200,g:80,b:30},{r:255,g:180,b:80},{r:160,g:60,b:30},{r:255,g:220,b:140},{r:200,g:120,b:60},{r:255,g:140,b:60},{r:160,g:80,b:40}] },
    { name: "Hot Cocoa", category: "Winter", colors: [{r:130,g:90,b:70},{r:170,g:130,b:100},{r:200,g:160,b:120},{r:255,g:230,b:200},{r:150,g:110,b:90},{r:190,g:150,b:110},{r:230,g:200,b:160},{r:120,g:90,b:70}] },
    { name: "Sleigh Ride", category: "Winter", colors: [{r:200,g:60,b:60},{r:240,g:240,b:240},{r:60,g:120,b:60},{r:180,g:200,b:230},{r:160,g:40,b:50},{r:80,g:160,b:80},{r:220,g:230,b:240},{r:200,g:80,b:80}] },
    { name: "Crystal Cave", category: "Winter", colors: [{r:180,g:200,b:240},{r:140,g:160,b:220},{r:200,g:230,b:255},{r:120,g:140,b:200},{r:160,g:180,b:230},{r:100,g:120,b:180},{r:220,g:240,b:255},{r:140,g:160,b:210}] },

    // Holidays
    { name: "Christmas", category: "Holidays", featured: true, colors: [{r:220,g:20,b:20},{r:0,g:120,b:0},{r:218,g:165,b:0},{r:240,g:240,b:240},{r:180,g:0,b:20},{r:0,g:80,b:30},{r:255,g:200,b:0},{r:180,g:210,b:240}] },
    { name: "Hanukkah", category: "Holidays", colors: [{r:65,g:105,b:225},{r:135,g:206,b:235},{r:192,g:192,b:192},{r:255,g:255,b:255},{r:30,g:60,b:160},{r:100,g:149,b:237},{r:220,g:220,b:220},{r:180,g:210,b:240}] },
    { name: "New Year", category: "Holidays", colors: [{r:255,g:215,b:0},{r:192,g:192,b:192},{r:255,g:245,b:180},{r:255,g:180,b:160},{r:200,g:160,b:30},{r:184,g:115,b:51},{r:230,g:230,b:230},{r:255,g:200,b:200}] },
    { name: "Halloween", category: "Holidays", featured: true, colors: [{r:255,g:140,b:0},{r:140,g:60,b:200},{r:255,g:80,b:0},{r:120,g:60,b:160},{r:255,g:200,b:0},{r:90,g:30,b:120},{r:200,g:60,b:0},{r:160,g:100,b:200}] },
    { name: "Valentine's", category: "Holidays", colors: [{r:255,g:60,b:120},{r:255,g:120,b:160},{r:200,g:30,b:80},{r:255,g:180,b:200},{r:240,g:60,b:120},{r:180,g:40,b:80},{r:255,g:140,b:180},{r:240,g:200,b:220}] },
    { name: "Fourth of July", category: "Holidays", colors: [{r:220,g:30,b:30},{r:240,g:240,b:240},{r:30,g:60,b:200},{r:200,g:30,b:30},{r:60,g:90,b:220},{r:240,g:240,b:240},{r:255,g:80,b:80},{r:80,g:120,b:240}] },
    { name: "St. Patrick's", category: "Holidays", colors: [{r:30,g:160,b:80},{r:80,g:200,b:80},{r:30,g:120,b:60},{r:140,g:220,b:140},{r:60,g:180,b:60},{r:200,g:240,b:160},{r:50,g:140,b:70},{r:255,g:215,b:0}] },
    { name: "Day of the Dead", category: "Holidays", colors: [{r:255,g:140,b:0},{r:255,g:30,b:160},{r:120,g:30,b:200},{r:255,g:230,b:80},{r:30,g:200,b:160},{r:200,g:30,b:80},{r:140,g:60,b:200},{r:255,g:180,b:0}] },
    { name: "Diwali", category: "Holidays", colors: [{r:255,g:180,b:30},{r:255,g:60,b:80},{r:200,g:60,b:160},{r:255,g:215,b:0},{r:255,g:120,b:30},{r:160,g:30,b:140},{r:255,g:200,b:80},{r:200,g:80,b:30}] },
    { name: "Lunar New Year", category: "Holidays", colors: [{r:220,g:30,b:30},{r:255,g:215,b:0},{r:255,g:80,b:80},{r:255,g:160,b:60},{r:200,g:30,b:30},{r:255,g:230,b:120},{r:240,g:120,b:60},{r:160,g:30,b:30}] },

    // Warm
    { name: "Warm", category: "Warm", colors: [{r:255,g:80,b:40},{r:255,g:160,b:30},{r:255,g:220,b:80},{r:200,g:60,b:60},{r:255,g:120,b:60},{r:218,g:165,b:32},{r:255,g:120,b:80},{r:200,g:80,b:40}] },
    { name: "Sunset", category: "Warm", featured: true, colors: [{r:255,g:94,b:77},{r:255,g:154,b:0},{r:255,g:206,b:84},{r:200,g:50,b:100},{r:255,g:180,b:120},{r:220,g:60,b:130},{r:200,g:100,b:20},{r:255,g:130,b:160}] },
    { name: "Campfire", category: "Warm", colors: [{r:220,g:40,b:20},{r:255,g:120,b:0},{r:255,g:215,b:0},{r:255,g:80,b:20},{r:200,g:60,b:30},{r:255,g:165,b:0},{r:255,g:240,b:200},{r:180,g:80,b:30}] },
    { name: "Lava", category: "Warm", colors: [{r:255,g:60,b:0},{r:200,g:30,b:0},{r:255,g:120,b:0},{r:160,g:40,b:20},{r:255,g:180,b:60},{r:140,g:30,b:10},{r:255,g:80,b:30},{r:200,g:80,b:0}] },
    { name: "Desert Sun", category: "Warm", colors: [{r:255,g:170,b:60},{r:240,g:200,b:120},{r:200,g:140,b:60},{r:255,g:220,b:140},{r:160,g:100,b:40},{r:255,g:200,b:80},{r:220,g:160,b:80},{r:255,g:240,b:180}] },
    { name: "Ember", category: "Warm", colors: [{r:255,g:60,b:30},{r:200,g:40,b:20},{r:255,g:120,b:60},{r:160,g:30,b:10},{r:240,g:80,b:30},{r:200,g:60,b:30},{r:255,g:160,b:80},{r:140,g:30,b:10}] },
    { name: "Tangerine", category: "Warm", colors: [{r:255,g:140,b:50},{r:255,g:180,b:80},{r:255,g:120,b:30},{r:255,g:200,b:120},{r:240,g:160,b:60},{r:255,g:100,b:20},{r:255,g:220,b:160},{r:200,g:120,b:40}] },
    { name: "Sahara", category: "Warm", colors: [{r:240,g:200,b:130},{r:200,g:160,b:100},{r:255,g:220,b:160},{r:160,g:120,b:80},{r:220,g:180,b:120},{r:140,g:100,b:60},{r:255,g:240,b:200},{r:200,g:140,b:80}] },
    { name: "Brick Oven", category: "Warm", colors: [{r:200,g:80,b:50},{r:160,g:50,b:30},{r:240,g:120,b:60},{r:120,g:40,b:20},{r:200,g:100,b:60},{r:255,g:140,b:80},{r:140,g:60,b:30},{r:200,g:120,b:80}] },
    { name: "Honey", category: "Warm", colors: [{r:255,g:200,b:60},{r:240,g:170,b:40},{r:255,g:220,b:120},{r:200,g:140,b:30},{r:255,g:180,b:60},{r:220,g:160,b:80},{r:255,g:230,b:160},{r:200,g:150,b:50}] },

    // Cool
    { name: "Cool", category: "Cool", colors: [{r:40,g:120,b:255},{r:80,g:200,b:255},{r:40,g:255,b:200},{r:100,g:80,b:220},{r:0,g:220,b:255},{r:60,g:60,b:180},{r:150,g:130,b:255},{r:100,g:240,b:200}] },
    { name: "Ocean", category: "Cool", featured: true, colors: [{r:0,g:105,b:148},{r:0,g:168,b:198},{r:72,g:202,b:228},{r:144,g:224,b:239},{r:30,g:80,b:140},{r:30,g:100,b:150},{r:100,g:210,b:200},{r:200,g:230,b:240}] },
    { name: "Aurora", category: "Cool", featured: true, colors: [{r:30,g:230,b:150},{r:30,g:200,b:255},{r:120,g:60,b:220},{r:30,g:180,b:100},{r:160,g:40,b:220},{r:30,g:220,b:200},{r:30,g:180,b:160},{r:180,g:40,b:200}] },
    { name: "Midnight", category: "Cool", colors: [{r:30,g:60,b:180},{r:80,g:30,b:160},{r:140,g:60,b:200},{r:30,g:100,b:200},{r:30,g:80,b:120},{r:100,g:30,b:180},{r:30,g:80,b:220},{r:120,g:40,b:160}] },
    { name: "Twilight", category: "Cool", colors: [{r:80,g:60,b:160},{r:200,g:120,b:200},{r:60,g:80,b:140},{r:255,g:140,b:200},{r:120,g:80,b:200},{r:160,g:120,b:240},{r:80,g:100,b:180},{r:240,g:160,b:200}] },
    { name: "Deep Sea", category: "Cool", colors: [{r:30,g:80,b:120},{r:30,g:120,b:160},{r:50,g:100,b:160},{r:60,g:140,b:180},{r:30,g:60,b:100},{r:40,g:120,b:160},{r:80,g:160,b:200},{r:30,g:100,b:140}] },
    { name: "Mint", category: "Cool", colors: [{r:120,g:240,b:200},{r:80,g:220,b:180},{r:160,g:240,b:220},{r:60,g:200,b:160},{r:200,g:255,b:230},{r:100,g:230,b:190},{r:140,g:240,b:210},{r:50,g:180,b:140}] },
    { name: "Sapphire", category: "Cool", colors: [{r:40,g:80,b:200},{r:80,g:120,b:240},{r:60,g:100,b:200},{r:120,g:160,b:255},{r:30,g:60,b:160},{r:140,g:180,b:255},{r:80,g:140,b:220},{r:30,g:60,b:140}] },
    { name: "Periwinkle", category: "Cool", colors: [{r:160,g:170,b:240},{r:130,g:140,b:220},{r:180,g:190,b:250},{r:120,g:140,b:230},{r:200,g:210,b:255},{r:100,g:120,b:200},{r:170,g:180,b:240},{r:140,g:160,b:230}] },
    { name: "Iceberg", category: "Cool", colors: [{r:200,g:230,b:240},{r:140,g:200,b:230},{r:60,g:140,b:180},{r:180,g:220,b:240},{r:100,g:170,b:210},{r:230,g:240,b:250},{r:80,g:160,b:200},{r:160,g:210,b:230}] },

    // Pastel
    { name: "Cotton Candy", category: "Pastel", featured: true, colors: [{r:255,g:200,b:230},{r:200,g:230,b:255},{r:255,g:220,b:240},{r:220,g:200,b:240},{r:255,g:230,b:200},{r:200,g:240,b:230},{r:240,g:210,b:240},{r:230,g:240,b:255}] },
    { name: "Macaron", category: "Pastel", colors: [{r:255,g:210,b:220},{r:210,g:230,b:200},{r:230,g:200,b:230},{r:255,g:230,b:180},{r:200,g:220,b:240},{r:240,g:230,b:200},{r:220,g:240,b:230},{r:240,g:200,b:200}] },
    { name: "Powder Puff", category: "Pastel", colors: [{r:240,g:230,b:230},{r:220,g:230,b:240},{r:240,g:240,b:220},{r:230,g:220,b:230},{r:220,g:240,b:230},{r:240,g:220,b:230},{r:230,g:240,b:240},{r:240,g:230,b:220}] },
    { name: "Soft Bloom", category: "Pastel", colors: [{r:255,g:200,b:210},{r:255,g:220,b:200},{r:230,g:240,b:200},{r:200,g:230,b:220},{r:200,g:220,b:240},{r:220,g:200,b:240},{r:240,g:200,b:230},{r:255,g:230,b:200}] },
    { name: "Baby Nursery", category: "Pastel", colors: [{r:255,g:220,b:230},{r:200,g:230,b:240},{r:230,g:240,b:200},{r:255,g:240,b:200},{r:230,g:220,b:240},{r:200,g:240,b:230},{r:255,g:230,b:220},{r:220,g:240,b:240}] },
    { name: "Bubblegum", category: "Pastel", colors: [{r:255,g:170,b:200},{r:255,g:200,b:230},{r:240,g:140,b:180},{r:255,g:220,b:230},{r:200,g:130,b:170},{r:255,g:160,b:190},{r:240,g:180,b:210},{r:200,g:170,b:200}] },
    { name: "Ice Cream", category: "Pastel", colors: [{r:255,g:220,b:200},{r:200,g:240,b:230},{r:255,g:200,b:220},{r:240,g:230,b:180},{r:200,g:220,b:240},{r:240,g:200,b:230},{r:230,g:240,b:200},{r:255,g:230,b:200}] },
    { name: "Lullaby", category: "Pastel", colors: [{r:200,g:220,b:240},{r:220,g:200,b:230},{r:240,g:230,b:240},{r:200,g:230,b:230},{r:230,g:220,b:200},{r:220,g:240,b:230},{r:230,g:230,b:240},{r:240,g:220,b:230}] },
    { name: "Petal", category: "Pastel", colors: [{r:255,g:200,b:200},{r:255,g:220,b:200},{r:240,g:200,b:220},{r:255,g:230,b:210},{r:230,g:200,b:230},{r:255,g:210,b:200},{r:240,g:220,b:240},{r:255,g:240,b:220}] },
    { name: "Seafoam", category: "Pastel", colors: [{r:200,g:240,b:220},{r:180,g:230,b:210},{r:220,g:240,b:230},{r:160,g:220,b:200},{r:200,g:250,b:230},{r:140,g:210,b:190},{r:230,g:250,b:240},{r:170,g:230,b:210}] },

    // Vibrant
    { name: "Pop Art", category: "Vibrant", featured: true, colors: [{r:255,g:30,b:30},{r:255,g:230,b:30},{r:30,g:60,b:255},{r:240,g:240,b:240},{r:255,g:80,b:200},{r:30,g:200,b:255},{r:255,g:140,b:30},{r:80,g:230,b:30}] },
    { name: "Bollywood", category: "Vibrant", colors: [{r:255,g:80,b:140},{r:255,g:200,b:30},{r:255,g:140,b:30},{r:80,g:200,b:80},{r:200,g:30,b:120},{r:30,g:160,b:200},{r:255,g:60,b:60},{r:160,g:80,b:200}] },
    { name: "Carnival", category: "Vibrant", colors: [{r:255,g:60,b:120},{r:255,g:200,b:30},{r:30,g:200,b:200},{r:200,g:30,b:200},{r:255,g:140,b:30},{r:80,g:240,b:80},{r:255,g:80,b:30},{r:120,g:80,b:240}] },
    { name: "Festival", category: "Vibrant", colors: [{r:255,g:80,b:80},{r:255,g:200,b:60},{r:80,g:200,b:80},{r:80,g:160,b:240},{r:200,g:80,b:200},{r:255,g:140,b:80},{r:80,g:240,b:200},{r:240,g:160,b:80}] },
    { name: "Color Burst", category: "Vibrant", colors: [{r:255,g:30,b:80},{r:30,g:255,b:160},{r:255,g:200,b:30},{r:120,g:30,b:240},{r:30,g:200,b:255},{r:255,g:120,b:30},{r:160,g:240,b:30},{r:255,g:80,b:200}] },
    { name: "Holi", category: "Vibrant", colors: [{r:255,g:30,b:120},{r:30,g:200,b:80},{r:255,g:200,b:30},{r:120,g:30,b:200},{r:30,g:160,b:240},{r:255,g:80,b:40},{r:80,g:240,b:160},{r:240,g:60,b:200}] },
    { name: "Mardi Gras", category: "Vibrant", colors: [{r:120,g:30,b:160},{r:200,g:160,b:30},{r:30,g:140,b:80},{r:160,g:80,b:200},{r:240,g:200,b:60},{r:60,g:180,b:120},{r:200,g:60,b:200},{r:255,g:180,b:30}] },
    { name: "Confetti", category: "Vibrant", colors: [{r:255,g:80,b:80},{r:80,g:200,b:80},{r:80,g:160,b:255},{r:255,g:200,b:80},{r:200,g:80,b:240},{r:255,g:140,b:80},{r:80,g:240,b:200},{r:255,g:80,b:200}] },
    { name: "Rainbow", category: "Vibrant", featured: true, colors: [{r:255,g:30,b:30},{r:255,g:127,b:30},{r:255,g:230,b:30},{r:30,g:200,b:30},{r:30,g:60,b:255},{r:75,g:30,b:130},{r:148,g:30,b:211},{r:255,g:30,b:150}] },
    { name: "Candy", category: "Vibrant", colors: [{r:255,g:30,b:150},{r:30,g:200,b:220},{r:180,g:255,b:30},{r:180,g:100,b:255},{r:255,g:100,b:180},{r:100,g:255,b:200},{r:255,g:220,b:50},{r:140,g:60,b:220}] },

    // Neon
    { name: "Neon", category: "Neon", featured: true, colors: [{r:255,g:30,b:255},{r:30,g:255,b:255},{r:255,g:255,b:30},{r:30,g:255,b:128},{r:255,g:30,b:100},{r:255,g:100,b:30},{r:30,g:100,b:255},{r:100,g:255,b:30}] },
    { name: "Cyberpunk", category: "Neon", featured: true, colors: [{r:255,g:30,b:200},{r:30,g:255,b:255},{r:255,g:240,b:30},{r:80,g:30,b:200},{r:255,g:30,b:80},{r:30,g:200,b:255},{r:200,g:30,b:255},{r:255,g:60,b:30}] },
    { name: "Synthwave", category: "Neon", colors: [{r:255,g:60,b:200},{r:120,g:60,b:240},{r:30,g:200,b:240},{r:255,g:200,b:80},{r:200,g:30,b:160},{r:80,g:80,b:240},{r:255,g:80,b:160},{r:60,g:160,b:240}] },
    { name: "Vaporwave", category: "Neon", colors: [{r:255,g:100,b:200},{r:100,g:200,b:255},{r:200,g:140,b:255},{r:255,g:200,b:200},{r:120,g:240,b:240},{r:255,g:160,b:240},{r:160,g:200,b:255},{r:240,g:120,b:200}] },
    { name: "Tokyo Night", category: "Neon", colors: [{r:255,g:30,b:120},{r:30,g:200,b:255},{r:255,g:200,b:30},{r:160,g:30,b:200},{r:30,g:255,b:160},{r:255,g:60,b:60},{r:140,g:60,b:240},{r:60,g:180,b:240}] },
    { name: "Miami Vice", category: "Neon", colors: [{r:255,g:60,b:200},{r:60,g:240,b:200},{r:255,g:200,b:80},{r:120,g:200,b:255},{r:255,g:120,b:160},{r:80,g:240,b:240},{r:255,g:160,b:200},{r:160,g:240,b:255}] },
    { name: "Arcade", category: "Neon", colors: [{r:255,g:60,b:60},{r:60,g:255,b:60},{r:60,g:60,b:255},{r:255,g:255,b:60},{r:255,g:60,b:255},{r:60,g:255,b:255},{r:255,g:160,b:30},{r:160,g:30,b:255}] },
    { name: "Laser Show", category: "Neon", colors: [{r:255,g:30,b:30},{r:30,g:255,b:30},{r:30,g:80,b:255},{r:255,g:30,b:160},{r:30,g:255,b:200},{r:255,g:200,b:30},{r:200,g:30,b:255},{r:80,g:255,b:60}] },
    { name: "Electric", category: "Neon", colors: [{r:30,g:255,b:255},{r:255,g:30,b:255},{r:200,g:255,b:30},{r:30,g:200,b:255},{r:255,g:80,b:200},{r:80,g:255,b:200},{r:255,g:200,b:30},{r:120,g:30,b:255}] },
    { name: "Acid", category: "Neon", colors: [{r:200,g:255,b:30},{r:30,g:255,b:120},{r:255,g:255,b:30},{r:120,g:255,b:30},{r:30,g:200,b:60},{r:200,g:240,b:60},{r:80,g:255,b:80},{r:160,g:255,b:60}] },

    // Retro
    { name: "Retro", category: "Retro", featured: true, colors: [{r:30,g:188,b:188},{r:255,g:100,b:90},{r:218,g:165,b:30},{r:100,g:170,b:100},{r:210,g:150,b:80},{r:160,g:40,b:80},{r:200,g:100,b:40},{r:80,g:120,b:160}] },
    { name: "50s Diner", category: "Retro", colors: [{r:255,g:80,b:120},{r:60,g:200,b:240},{r:255,g:240,b:240},{r:240,g:200,b:80},{r:200,g:60,b:80},{r:80,g:160,b:200},{r:255,g:180,b:200},{r:120,g:200,b:220}] },
    { name: "70s Disco", category: "Retro", colors: [{r:240,g:140,b:30},{r:200,g:60,b:120},{r:120,g:200,b:80},{r:240,g:200,b:80},{r:160,g:80,b:200},{r:240,g:120,b:80},{r:200,g:160,b:60},{r:240,g:60,b:140}] },
    { name: "80s Pop", category: "Retro", colors: [{r:255,g:80,b:200},{r:80,g:240,b:240},{r:255,g:240,b:80},{r:200,g:80,b:240},{r:80,g:200,b:255},{r:255,g:140,b:80},{r:160,g:80,b:240},{r:240,g:200,b:60}] },
    { name: "90s Grunge", category: "Retro", colors: [{r:160,g:120,b:90},{r:200,g:160,b:120},{r:120,g:140,b:120},{r:220,g:140,b:80},{r:140,g:90,b:60},{r:180,g:160,b:120},{r:140,g:100,b:70},{r:200,g:180,b:140}] },
    { name: "Y2K", category: "Retro", colors: [{r:200,g:240,b:240},{r:255,g:200,b:240},{r:240,g:240,b:200},{r:200,g:200,b:240},{r:240,g:200,b:200},{r:200,g:240,b:200},{r:240,g:220,b:240},{r:220,g:240,b:240}] },
    { name: "Polaroid", category: "Retro", colors: [{r:240,g:200,b:140},{r:200,g:160,b:120},{r:240,g:180,b:160},{r:160,g:140,b:120},{r:220,g:180,b:140},{r:200,g:200,b:160},{r:240,g:220,b:180},{r:180,g:160,b:120}] },
    { name: "Western", category: "Retro", colors: [{r:200,g:120,b:60},{r:160,g:100,b:60},{r:200,g:160,b:100},{r:140,g:80,b:40},{r:240,g:200,b:140},{r:160,g:80,b:40},{r:200,g:100,b:40},{r:255,g:200,b:120}] },
    { name: "Atomic Age", category: "Retro", colors: [{r:255,g:160,b:80},{r:80,g:200,b:200},{r:255,g:220,b:60},{r:160,g:80,b:140},{r:200,g:120,b:60},{r:120,g:180,b:200},{r:255,g:200,b:120},{r:200,g:80,b:80}] },
    { name: "Mid-Century", category: "Retro", colors: [{r:200,g:140,b:60},{r:80,g:140,b:120},{r:200,g:180,b:120},{r:160,g:80,b:60},{r:140,g:160,b:120},{r:220,g:200,b:160},{r:120,g:120,b:80},{r:200,g:120,b:80}] },

    // Nature
    { name: "Forest", category: "Nature", featured: true, colors: [{r:34,g:139,b:34},{r:107,g:142,b:35},{r:85,g:107,b:47},{r:144,g:238,b:144},{r:30,g:168,b:107},{r:130,g:170,b:100},{r:120,g:200,b:50},{r:60,g:120,b:60}] },
    { name: "Meadow", category: "Nature", colors: [{r:140,g:200,b:80},{r:200,g:230,b:120},{r:255,g:200,b:80},{r:160,g:220,b:140},{r:120,g:180,b:60},{r:255,g:180,b:200},{r:240,g:230,b:120},{r:180,g:200,b:100}] },
    { name: "Mountain", category: "Nature", colors: [{r:120,g:140,b:160},{r:200,g:220,b:230},{r:80,g:100,b:120},{r:160,g:180,b:200},{r:60,g:80,b:100},{r:140,g:160,b:180},{r:230,g:240,b:240},{r:100,g:120,b:140}] },
    { name: "Desert", category: "Nature", colors: [{r:240,g:200,b:140},{r:200,g:140,b:80},{r:255,g:220,b:170},{r:160,g:100,b:60},{r:220,g:180,b:120},{r:140,g:80,b:40},{r:255,g:230,b:180},{r:200,g:160,b:100}] },
    { name: "Jungle", category: "Nature", colors: [{r:30,g:120,b:60},{r:80,g:160,b:60},{r:30,g:80,b:40},{r:140,g:200,b:80},{r:40,g:140,b:80},{r:255,g:140,b:60},{r:200,g:80,b:40},{r:80,g:200,b:120}] },
    { name: "Savanna", category: "Nature", colors: [{r:240,g:200,b:120},{r:200,g:160,b:80},{r:160,g:100,b:60},{r:220,g:180,b:100},{r:140,g:80,b:40},{r:240,g:220,b:160},{r:120,g:80,b:40},{r:200,g:140,b:80}] },
    { name: "Wildflower", category: "Nature", colors: [{r:255,g:140,b:200},{r:255,g:200,b:80},{r:120,g:200,b:80},{r:200,g:80,b:200},{r:255,g:80,b:120},{r:80,g:200,b:240},{r:200,g:160,b:240},{r:255,g:200,b:160}] },
    { name: "Botanical", category: "Nature", colors: [{r:80,g:160,b:80},{r:140,g:200,b:100},{r:60,g:120,b:60},{r:200,g:220,b:120},{r:100,g:180,b:80},{r:160,g:200,b:120},{r:60,g:120,b:60},{r:220,g:240,b:180}] },
    { name: "Tundra", category: "Nature", colors: [{r:200,g:210,b:200},{r:160,g:170,b:160},{r:220,g:230,b:220},{r:140,g:160,b:160},{r:180,g:200,b:190},{r:120,g:140,b:140},{r:230,g:240,b:230},{r:160,g:180,b:180}] },
    { name: "Coastline", category: "Nature", colors: [{r:240,g:220,b:170},{r:80,g:170,b:200},{r:200,g:180,b:140},{r:60,g:140,b:170},{r:240,g:230,b:200},{r:120,g:200,b:220},{r:200,g:170,b:130},{r:60,g:120,b:160}] },

    // Cosmic
    { name: "Galaxy", category: "Cosmic", featured: true, colors: [{r:80,g:30,b:160},{r:255,g:60,b:200},{r:60,g:80,b:240},{r:200,g:120,b:240},{r:60,g:30,b:120},{r:120,g:60,b:240},{r:200,g:60,b:200},{r:80,g:140,b:255}] },
    { name: "Nebula", category: "Cosmic", colors: [{r:200,g:60,b:200},{r:60,g:200,b:255},{r:255,g:80,b:120},{r:140,g:60,b:240},{r:80,g:200,b:240},{r:255,g:160,b:200},{r:200,g:120,b:255},{r:80,g:80,b:200}] },
    { name: "Solar Flare", category: "Cosmic", colors: [{r:255,g:200,b:30},{r:255,g:120,b:30},{r:255,g:80,b:60},{r:255,g:240,b:160},{r:240,g:160,b:30},{r:255,g:60,b:30},{r:255,g:180,b:60},{r:200,g:80,b:30}] },
    { name: "Lunar", category: "Cosmic", colors: [{r:220,g:220,b:240},{r:180,g:200,b:240},{r:200,g:220,b:255},{r:240,g:240,b:240},{r:160,g:180,b:220},{r:220,g:240,b:255},{r:200,g:200,b:240},{r:140,g:160,b:200}] },
    { name: "Plasma", category: "Cosmic", colors: [{r:255,g:30,b:200},{r:200,g:30,b:255},{r:60,g:80,b:255},{r:30,g:200,b:255},{r:255,g:60,b:160},{r:120,g:60,b:255},{r:60,g:160,b:255},{r:240,g:30,b:240}] },
    { name: "Stardust", category: "Cosmic", colors: [{r:200,g:180,b:240},{r:240,g:220,b:160},{r:160,g:180,b:240},{r:255,g:240,b:200},{r:180,g:160,b:220},{r:255,g:200,b:240},{r:200,g:220,b:255},{r:240,g:200,b:220}] },
    { name: "Supernova", category: "Cosmic", colors: [{r:255,g:240,b:120},{r:255,g:140,b:30},{r:255,g:60,b:60},{r:200,g:30,b:140},{r:120,g:30,b:200},{r:255,g:200,b:80},{r:255,g:80,b:160},{r:160,g:60,b:240}] },
    { name: "Void", category: "Cosmic", colors: [{r:80,g:60,b:200},{r:200,g:120,b:240},{r:60,g:40,b:140},{r:255,g:160,b:60},{r:90,g:60,b:160},{r:160,g:80,b:240},{r:255,g:200,b:120},{r:80,g:80,b:160}] },
    { name: "Comet", category: "Cosmic", colors: [{r:60,g:140,b:240},{r:200,g:240,b:255},{r:120,g:160,b:240},{r:255,g:240,b:200},{r:80,g:120,b:200},{r:240,g:240,b:255},{r:160,g:200,b:255},{r:80,g:140,b:220}] },
    { name: "Eclipse", category: "Cosmic", colors: [{r:255,g:160,b:30},{r:200,g:60,b:30},{r:255,g:200,b:60},{r:120,g:60,b:140},{r:255,g:120,b:30},{r:160,g:60,b:200},{r:200,g:80,b:30},{r:140,g:80,b:160}] },

    // Earth
    { name: "Terracotta", category: "Earth", colors: [{r:200,g:100,b:60},{r:160,g:80,b:50},{r:220,g:140,b:90},{r:140,g:70,b:40},{r:200,g:120,b:80},{r:160,g:80,b:50},{r:240,g:160,b:120},{r:180,g:100,b:60}] },
    { name: "Sandstone", category: "Earth", colors: [{r:240,g:210,b:170},{r:200,g:170,b:130},{r:220,g:190,b:150},{r:160,g:130,b:90},{r:240,g:220,b:180},{r:180,g:150,b:110},{r:200,g:180,b:140},{r:140,g:110,b:80}] },
    { name: "Clay", category: "Earth", colors: [{r:180,g:100,b:60},{r:140,g:80,b:40},{r:200,g:140,b:90},{r:160,g:80,b:40},{r:160,g:120,b:80},{r:200,g:80,b:40},{r:140,g:100,b:60},{r:160,g:60,b:30}] },
    { name: "Mocha", category: "Earth", colors: [{r:140,g:90,b:70},{r:170,g:130,b:100},{r:120,g:80,b:60},{r:200,g:160,b:130},{r:130,g:90,b:70},{r:160,g:120,b:90},{r:110,g:80,b:60},{r:180,g:140,b:110}] },
    { name: "Driftwood", category: "Earth", colors: [{r:160,g:140,b:120},{r:200,g:180,b:160},{r:120,g:100,b:80},{r:180,g:160,b:140},{r:140,g:120,b:100},{r:220,g:200,b:180},{r:130,g:110,b:90},{r:200,g:180,b:150}] },
    { name: "Stone", category: "Earth", colors: [{r:160,g:160,b:160},{r:200,g:200,b:200},{r:130,g:130,b:130},{r:180,g:180,b:180},{r:140,g:140,b:140},{r:220,g:220,b:220},{r:140,g:130,b:120},{r:200,g:200,b:180}] },
    { name: "Adobe", category: "Earth", featured: true, colors: [{r:200,g:120,b:80},{r:240,g:180,b:120},{r:160,g:90,b:50},{r:220,g:160,b:100},{r:180,g:100,b:60},{r:255,g:200,b:140},{r:140,g:80,b:40},{r:200,g:140,b:80}] },
    { name: "Espresso", category: "Earth", colors: [{r:120,g:80,b:60},{r:160,g:100,b:70},{r:90,g:60,b:40},{r:180,g:140,b:100},{r:130,g:90,b:60},{r:170,g:130,b:90},{r:100,g:70,b:50},{r:200,g:160,b:120}] },
    { name: "Olive Grove", category: "Earth", colors: [{r:140,g:140,b:80},{r:170,g:170,b:100},{r:120,g:130,b:70},{r:200,g:200,b:140},{r:140,g:160,b:90},{r:180,g:180,b:120},{r:120,g:120,b:60},{r:200,g:210,b:150}] },
    { name: "Wheat", category: "Earth", colors: [{r:240,g:220,b:170},{r:200,g:180,b:120},{r:240,g:200,b:140},{r:180,g:160,b:100},{r:220,g:200,b:150},{r:160,g:140,b:80},{r:240,g:230,b:180},{r:200,g:170,b:110}] },

    // Mood
    { name: "Calm", category: "Mood", colors: [{r:160,g:200,b:220},{r:200,g:230,b:240},{r:140,g:180,b:200},{r:220,g:230,b:230},{r:180,g:210,b:220},{r:160,g:220,b:200},{r:200,g:220,b:220},{r:140,g:200,b:220}] },
    { name: "Energetic", category: "Mood", colors: [{r:255,g:80,b:30},{r:255,g:200,b:30},{r:30,g:200,b:80},{r:30,g:160,b:240},{r:255,g:30,b:120},{r:200,g:80,b:255},{r:255,g:140,b:30},{r:80,g:240,b:200}] },
    { name: "Romantic", category: "Mood", featured: true, colors: [{r:200,g:60,b:80},{r:255,g:120,b:140},{r:160,g:40,b:60},{r:255,g:180,b:200},{r:200,g:80,b:120},{r:140,g:60,b:80},{r:255,g:160,b:180},{r:200,g:120,b:140}] },
    { name: "Mysterious", category: "Mood", colors: [{r:80,g:50,b:140},{r:120,g:60,b:160},{r:60,g:40,b:100},{r:90,g:50,b:140},{r:160,g:100,b:200},{r:70,g:50,b:120},{r:100,g:60,b:160},{r:140,g:80,b:180}] },
    { name: "Joyful", category: "Mood", colors: [{r:255,g:220,b:80},{r:255,g:140,b:60},{r:80,g:240,b:120},{r:80,g:200,b:255},{r:255,g:200,b:200},{r:200,g:240,b:80},{r:255,g:160,b:200},{r:80,g:240,b:200}] },
    { name: "Melancholy", category: "Mood", colors: [{r:80,g:100,b:140},{r:140,g:160,b:180},{r:60,g:80,b:120},{r:120,g:140,b:160},{r:160,g:180,b:200},{r:80,g:120,b:160},{r:100,g:140,b:180},{r:140,g:160,b:200}] },
    { name: "Focus", category: "Mood", colors: [{r:200,g:230,b:240},{r:240,g:240,b:200},{r:220,g:230,b:200},{r:230,g:240,b:230},{r:240,g:230,b:220},{r:220,g:240,b:240},{r:230,g:230,b:240},{r:240,g:240,b:230}] },
    { name: "Cozy", category: "Mood", featured: true, colors: [{r:200,g:120,b:80},{r:240,g:180,b:120},{r:160,g:80,b:60},{r:220,g:160,b:100},{r:255,g:200,b:140},{r:180,g:100,b:60},{r:240,g:200,b:160},{r:200,g:140,b:80}] },
    { name: "Dreamy", category: "Mood", colors: [{r:200,g:180,b:240},{r:240,g:200,b:240},{r:180,g:200,b:240},{r:240,g:220,b:255},{r:200,g:220,b:240},{r:220,g:200,b:240},{r:255,g:220,b:240},{r:200,g:200,b:255}] },
    { name: "Zen", category: "Mood", colors: [{r:200,g:220,b:200},{r:230,g:240,b:220},{r:160,g:180,b:160},{r:220,g:230,b:210},{r:180,g:200,b:180},{r:240,g:240,b:230},{r:160,g:200,b:160},{r:210,g:230,b:210}] },

    // Cinematic
    { name: "Wes Anderson", category: "Cinematic", featured: true, colors: [{r:240,g:180,b:160},{r:200,g:160,b:120},{r:240,g:200,b:140},{r:160,g:200,b:180},{r:220,g:160,b:140},{r:200,g:180,b:160},{r:160,g:120,b:100},{r:240,g:220,b:180}] },
    { name: "Blade Runner", category: "Cinematic", colors: [{r:255,g:80,b:120},{r:60,g:80,b:200},{r:255,g:180,b:60},{r:120,g:60,b:200},{r:30,g:200,b:240},{r:200,g:60,b:80},{r:80,g:120,b:240},{r:255,g:140,b:30}] },
    { name: "The Matrix", category: "Cinematic", colors: [{r:30,g:200,b:60},{r:80,g:240,b:120},{r:30,g:140,b:40},{r:120,g:240,b:160},{r:40,g:180,b:80},{r:30,g:120,b:50},{r:160,g:255,b:200},{r:80,g:200,b:100}] },
    { name: "Tron", category: "Cinematic", colors: [{r:30,g:240,b:255},{r:255,g:120,b:30},{r:30,g:160,b:240},{r:80,g:240,b:255},{r:255,g:60,b:30},{r:30,g:200,b:255},{r:255,g:80,b:60},{r:120,g:240,b:255}] },
    { name: "Ghibli", category: "Cinematic", colors: [{r:160,g:200,b:140},{r:200,g:230,b:240},{r:240,g:200,b:140},{r:160,g:180,b:200},{r:220,g:240,b:200},{r:240,g:220,b:180},{r:200,g:160,b:140},{r:180,g:220,b:230}] },
    { name: "Pixar", category: "Cinematic", colors: [{r:255,g:200,b:80},{r:80,g:200,b:240},{r:255,g:140,b:120},{r:160,g:240,b:160},{r:255,g:160,b:200},{r:120,g:160,b:240},{r:255,g:230,b:120},{r:200,g:240,b:200}] },
    { name: "Cyberscape", category: "Cinematic", colors: [{r:30,g:200,b:255},{r:255,g:60,b:200},{r:120,g:30,b:200},{r:30,g:255,b:160},{r:255,g:200,b:30},{r:80,g:80,b:240},{r:200,g:80,b:240},{r:60,g:240,b:200}] },
    { name: "Noir", category: "Cinematic", colors: [{r:200,g:200,b:200},{r:120,g:120,b:120},{r:160,g:160,b:160},{r:140,g:140,b:140},{r:240,g:240,b:240},{r:100,g:100,b:100},{r:180,g:180,b:180},{r:130,g:130,b:130}] },
    { name: "Spaghetti Western", category: "Cinematic", colors: [{r:200,g:160,b:100},{r:160,g:100,b:60},{r:240,g:200,b:140},{r:140,g:80,b:50},{r:220,g:180,b:120},{r:180,g:120,b:80},{r:200,g:140,b:80},{r:160,g:120,b:80}] },
    { name: "Studio Ghibli Sky", category: "Cinematic", colors: [{r:140,g:200,b:240},{r:200,g:230,b:255},{r:255,g:230,b:200},{r:255,g:200,b:160},{r:180,g:220,b:240},{r:240,g:220,b:200},{r:200,g:240,b:255},{r:255,g:180,b:140}] },
  ];

  // Build category list, with "Featured" and "All" pinned at the front.
  const paletteCategoryList = (() => {
    const seen = new Set();
    const ordered = [];
    paletteLibrary.forEach(p => {
      if (!seen.has(p.category)) {
        seen.add(p.category);
        ordered.push(p.category);
      }
    });
    return ["Featured", "All", ...ordered];
  })();

  const isLinear = layout?.mode === "linear";
  // Preset modes (Teams/NCAA/Flags) are exact-color only — no Color/White space.
  const isPresetMode = mode === "teams" || mode === "ncaa" || mode === "flags";
  const availableDirections = isLinear
    ? ["left-right", "right-left", "center-out"]
    : ["left-right", "right-left", "top-bottom", "bottom-top", "center-out"];

  // Reset direction if current one isn't available for this layout mode
  useEffect(() => {
    if (!availableDirections.includes(direction)) {
      setDirection("left-right");
    }
  }, [isLinear]);

  const btnStyle = (active) => ({
    padding: "4px 12px", borderRadius: 6, border: "1px solid #334155",
    background: active ? "rgba(52,211,153,0.15)" : "transparent",
    color: active ? "#34d399" : "#64748b", fontSize: 11, fontWeight: 600, cursor: "pointer",
  });

  return (
    <div style={{
      background: "linear-gradient(135deg, #1e293b 0%, #172033 100%)",
      borderRadius: 16, padding: isMobile ? 14 : 20, marginBottom: 16,
      border: "1px solid #334155",
    }}>
      {/* Header with mode tabs */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
        <div style={{
          fontSize: 12, fontWeight: 600, color: "#34d399",
          textTransform: "uppercase", letterSpacing: 0.8,
        }}>
          Color Mode
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button onClick={() => setMode("palette")} style={btnStyle(mode === "palette")}>
            Palette
          </button>
          <button onClick={() => setMode("gradient")} style={btnStyle(mode === "gradient")}>
            Gradient
          </button>
          <button onClick={() => setMode("tonal")} style={btnStyle(mode === "tonal")}>
            Tonal
          </button>
          <button onClick={() => setMode("custom")} style={btnStyle(mode === "custom")}>
            Custom
          </button>
          <button onClick={() => setMode("beacon")} style={btnStyle(mode === "beacon")}>
            Beacon
          </button>
          <button onClick={() => setMode("teams")} style={btnStyle(mode === "teams")}>
            Teams
          </button>
          <button onClick={() => setMode("ncaa")} style={btnStyle(mode === "ncaa")}>
            NCAA
          </button>
          <button onClick={() => setMode("flags")} style={btnStyle(mode === "flags")}>
            Flags
          </button>
        </div>
      </div>

      {/* Color vs White (color temperature) toggle — hidden for preset modes,
          which are exact-color only. */}
      {!isPresetMode && (
      <div style={{
        display: "flex", gap: 4, marginBottom: 14,
        background: "#0f172a", borderRadius: 8, padding: 3,
        border: "1px solid #1e293b", maxWidth: 260,
      }}>
        {[
          { key: "color", label: "Color" },
          { key: "white", label: "White" },
        ].map(opt => (
          <button key={opt.key}
            onClick={() => setColorSpace(opt.key)}
            style={{
              flex: 1, padding: "6px 10px", borderRadius: 6, border: "none",
              background: colorSpace === opt.key ? "#6366f1" : "transparent",
              color: colorSpace === opt.key ? "#fff" : "#94a3b8",
              fontSize: 12, fontWeight: 600, cursor: "pointer",
            }}
          >{opt.label}</button>
        ))}
      </div>
      )}

      {/* Target vendor filter — only when the room has both Hue and Govee
          color devices, otherwise the choice is meaningless. Lets a scene
          apply to all devices, Hue only, or Govee only. */}
      {placedVendors.hue && placedVendors.govee && (
        <div style={{
          display: "flex", alignItems: "center", gap: 8, marginBottom: 14, flexWrap: "wrap",
        }}>
          <span style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600 }}>Apply to:</span>
          <div style={{
            display: "flex", gap: 4, background: "#0f172a", borderRadius: 8,
            padding: 3, border: "1px solid #1e293b",
          }}>
            {[
              { key: "all", label: "All" },
              { key: "hue", label: "Hue only" },
              { key: "govee", label: "Govee only" },
            ].map(opt => (
              <button key={opt.key}
                onClick={() => setTargetVendor(opt.key)}
                style={{
                  padding: "6px 12px", borderRadius: 6, border: "none",
                  background: targetVendor === opt.key ? "#6366f1" : "transparent",
                  color: targetVendor === opt.key ? "#fff" : "#94a3b8",
                  fontSize: 12, fontWeight: 600, cursor: "pointer",
                }}
              >{opt.label}</button>
            ))}
          </div>
        </div>
      )}

      {/* Address-segments toggle. Only shown when this room actually has a
          segmented device — otherwise it has no effect and is just noise. */}
      {allLights.some(l => l?.sku && (segmentInfo?.sku_table?.[l.sku]?.count || 0) > 1) && (
        <div style={{
          display: "flex", alignItems: "center", gap: 8, marginBottom: 14,
          padding: "8px 10px", background: "rgba(15,23,42,0.5)",
          borderRadius: 8, border: "1px solid #1e293b", flexWrap: "wrap",
        }}>
          <span style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600 }}>Segmented devices:</span>
          <div style={{ display: "flex", gap: 4, background: "#0f172a", borderRadius: 6, padding: 2 }}>
            {[
              { key: "individual", label: "Address individually" },
              { key: "unit", label: "Address as a unit" },
            ].map(opt => (
              <button key={opt.key}
                onClick={() => setAddressSegments(opt.key)}
                style={{
                  padding: "5px 10px", borderRadius: 5, border: "none",
                  background: addressSegments === opt.key ? "#6366f1" : "transparent",
                  color: addressSegments === opt.key ? "#fff" : "#94a3b8",
                  fontSize: 11, fontWeight: 600, cursor: "pointer",
                }}
              >{opt.label}</button>
            ))}
          </div>
        </div>
      )}

      {!hasColorLights && (
        <div style={{ fontSize: 12, color: "#64748b", padding: "12px 0" }}>
          This room has no color lights.
        </div>
      )}

      {/* Layout not finished: still let the user pick a palette/scene (it's
          saved), but warn that color separation needs the room laid out. */}
      {hasColorLights && !hasLayout && (
        <div style={{
          fontSize: 12, color: "#fbbf24", marginBottom: 12, padding: "8px 12px",
          background: "rgba(251,191,36,0.1)", border: "1px solid rgba(251,191,36,0.3)",
          borderRadius: 8, lineHeight: 1.4,
        }}>
          Finish setting up the room layout in Controls for better color separation in this room.
        </div>
      )}

      {hasColorLights && (
        <>
          {/* ─── Gradient mode ───────────────────────────────────── */}
          {mode === "gradient" && (
            <div>
              <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 8 }}>
                Shades of one color, distributed along a direction across your room layout.
              </div>

              {/* Direction picker with mini map */}
              <GradientDirectionPicker
                direction={direction}
                onDirectionChange={setDirection}
                availableDirections={availableDirections}
                placedLights={placedColorLights}
                layout={layout}
                preview={preview}
                lightMap={lightMap}
                nicknames={nicknames}
                isLinear={isLinear}
              />

              {/* Base color (Color mode) / max temperature (White mode) */}
              {colorSpace === "color" ? (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 11, color: "#64748b", marginBottom: 4 }}>Base color:</div>
                  <ColorPicker
                    size={120}
                    currentColor={baseColor}
                    onColorSelect={(r, g, b) => setBaseColor({ r, g, b })}
                    favorites={favorites}
                    onFavoritesChange={onFavoritesChange}
                    compact={true}
                  />
                </div>
              ) : (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 11, color: "#64748b", marginBottom: 6 }}>
                    Coolest temperature — the gradient runs from {CT_MIN_K}K up to this across the layout.
                  </div>
                  <ColorTempSlider kelvin={maxKelvin} onChange={setMaxKelvin} />
                </div>
              )}
            </div>
          )}

          {/* ─── Tonal mode ──────────────────────────────────────── */}
          {mode === "tonal" && (
            <div>
              <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 10 }}>
                {colorSpace === "color"
                  ? "8 shades of one color, randomly assigned so no adjacent lights share a similar tone."
                  : `8 white temperatures across the full ${CT_MIN_K}K–${CT_MAX_K}K range, randomly assigned so no adjacent lights share a similar tone.`}
              </div>

              {/* Live swatch row showing the 8 generated shades */}
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: "#64748b", marginBottom: 4 }}>Generated shades:</div>
                <div style={{ display: "flex", gap: 4 }}>
                  {(colorSpace === "color"
                    ? generateTonalShades(baseColor.r, baseColor.g, baseColor.b, 8)
                    : spreadKelvin(CT_MIN_K, CT_MAX_K, 8).map(kelvinToRGB)
                  ).map((c, i) => (
                    <div key={i} style={{
                      width: 24, height: 24, borderRadius: 5,
                      background: `rgb(${c.r},${c.g},${c.b})`,
                      border: "1px solid rgba(255,255,255,0.12)",
                    }} />
                  ))}
                </div>
              </div>

              {/* Base color picker (Color mode only — White uses the full range) */}
              {colorSpace === "color" && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 11, color: "#64748b", marginBottom: 4 }}>Base color:</div>
                  <ColorPicker
                    size={120}
                    currentColor={baseColor}
                    onColorSelect={(r, g, b) => setBaseColor({ r, g, b })}
                    favorites={favorites}
                    onFavoritesChange={onFavoritesChange}
                    compact={true}
                  />
                </div>
              )}
            </div>
          )}

          {/* ─── Palette mode ────────────────────────────────────── */}
          {mode === "palette" && (
            <div>
              <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 8 }}>
                {colorSpace === "color"
                  ? "Distinct colors assigned to devices. Adjacent lights on the map won't share a color."
                  : "A band of white temperatures assigned across devices. Adjacent lights won't share a temperature."}
              </div>

              {/* White-mode: 4 temperature-band presets */}
              {colorSpace === "white" && (
                <div style={{
                  display: "grid",
                  gridTemplateColumns: isMobile ? "repeat(2, 1fr)" : "repeat(4, 1fr)",
                  gap: 6, marginBottom: 12,
                }}>
                  {CT_PALETTES.map((p, i) => {
                    const active = ctPreset === i;
                    const lo = kelvinToRGB(p.min), hi = kelvinToRGB(p.max);
                    return (
                      <button key={p.name}
                        onClick={() => setCtPreset(i)}
                        style={{
                          padding: "8px 8px", borderRadius: 8,
                          border: `1px solid ${active ? "#34d399" : "#334155"}`,
                          background: active ? "rgba(52,211,153,0.12)" : "rgba(15,23,42,0.4)",
                          cursor: "pointer", display: "flex", flexDirection: "column", gap: 6,
                        }}
                      >
                        <span style={{
                          height: 14, borderRadius: 3,
                          background: `linear-gradient(90deg, rgb(${lo.r},${lo.g},${lo.b}), rgb(${hi.r},${hi.g},${hi.b}))`,
                        }} />
                        <span style={{
                          fontSize: 10, fontWeight: 600,
                          color: active ? "#34d399" : "#cbd5e1",
                          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                        }}>{p.name}</span>
                        <span style={{ fontSize: 9, color: "#64748b" }}>{p.min}–{p.max}K</span>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Search + category filter + filtered grid */}
              {colorSpace === "color" && (<>
              <div style={{ marginBottom: 12 }}>
                <input
                  type="text"
                  value={paletteSearch}
                  onChange={(e) => setPaletteSearch(e.target.value)}
                  placeholder={`Search ${paletteLibrary.length} palettes…`}
                  style={{
                    width: "100%", boxSizing: "border-box",
                    padding: "6px 10px", borderRadius: 6,
                    border: "1px solid #334155", background: "rgba(15,23,42,0.6)",
                    color: "#e2e8f0", fontSize: 12, outline: "none", marginBottom: 8,
                  }}
                />

                {/* Category chip strip */}
                <div style={{
                  display: "flex", gap: 4, marginBottom: 8,
                  overflowX: isMobile ? "auto" : "visible",
                  flexWrap: isMobile ? "nowrap" : "wrap",
                  paddingBottom: isMobile ? 4 : 0,
                  WebkitOverflowScrolling: "touch",
                }}>
                  {paletteCategoryList.map((cat) => {
                    const active = cat === paletteCategory;
                    return (
                      <button key={cat}
                        onClick={() => setPaletteCategory(cat)}
                        style={{
                          padding: "3px 10px", borderRadius: 12,
                          border: `1px solid ${active ? "#34d399" : "#334155"}`,
                          background: active ? "rgba(52,211,153,0.15)" : "transparent",
                          color: active ? "#34d399" : "#94a3b8",
                          fontSize: 10, fontWeight: 600, cursor: "pointer",
                          whiteSpace: "nowrap", flexShrink: 0,
                        }}
                      >
                        {cat}
                      </button>
                    );
                  })}
                </div>

                {/* Filtered palette grid */}
                {(() => {
                  const q = paletteSearch.trim().toLowerCase();
                  const filtered = paletteLibrary.filter((p) => {
                    if (paletteCategory === "Featured" && !p.featured) return false;
                    if (paletteCategory !== "Featured" && paletteCategory !== "All" && p.category !== paletteCategory) return false;
                    if (q && !p.name.toLowerCase().includes(q) && !p.category.toLowerCase().includes(q)) return false;
                    return true;
                  });
                  if (filtered.length === 0) {
                    return (
                      <div style={{ fontSize: 11, color: "#64748b", padding: "8px 0" }}>
                        No palettes match.
                      </div>
                    );
                  }
                  return (
                    <div style={{
                      display: "grid",
                      gridTemplateColumns: isMobile ? "repeat(2, 1fr)" : "repeat(auto-fill, minmax(140px, 1fr))",
                      gap: 6,
                      maxHeight: isMobile ? 280 : 340, overflowY: "auto",
                      paddingRight: 4,
                    }}>
                      {filtered.map((scheme) => (
                        <button key={`${scheme.category}:${scheme.name}`}
                          onClick={() => {
                            const visibleLen = Math.max(scheme.colors.length, paletteColors.length);
                            const newSource = extendPalette([...scheme.colors], Math.max(visibleLen, scheme.colors.length));
                            setPaletteSource(newSource);
                            setPaletteColors(newSource.slice(0, visibleLen));
                            setEditingPaletteIdx(null);
                          }}
                          style={{
                            padding: "6px 8px", borderRadius: 6, border: "1px solid #334155",
                            background: "rgba(15,23,42,0.4)", cursor: "pointer",
                            display: "flex", flexDirection: "column", gap: 4, alignItems: "stretch",
                            textAlign: "left",
                          }}
                        >
                          <span style={{ display: "flex", gap: 0, height: 14, borderRadius: 3, overflow: "hidden" }}>
                            {scheme.colors.map((c, j) => (
                              <span key={j} style={{
                                flex: 1,
                                background: `rgb(${c.r},${c.g},${c.b})`,
                              }} />
                            ))}
                          </span>
                          <span style={{
                            fontSize: 10, color: "#cbd5e1", fontWeight: 500,
                            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                          }}>{scheme.name}</span>
                        </button>
                      ))}
                    </div>
                  );
                })()}
              </div>

              {/* Color count stepper */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <span style={{ fontSize: 11, color: "#64748b" }}>Colors:</span>
                <button
                  onClick={removeLastPaletteColor}
                  disabled={paletteColors.length <= 2}
                  style={{
                    width: 24, height: 24, borderRadius: 6, border: "1px solid #334155",
                    background: paletteColors.length <= 2 ? "transparent" : "rgba(255,255,255,0.05)",
                    color: paletteColors.length <= 2 ? "#334155" : "#94a3b8",
                    fontSize: 16, lineHeight: 1, cursor: paletteColors.length <= 2 ? "default" : "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center", padding: 0,
                  }}
                >−</button>
                <span style={{ fontSize: 14, fontWeight: 700, color: "#f1f5f9", minWidth: 22, textAlign: "center" }}>
                  {paletteColors.length}
                </span>
                <button
                  onClick={addPaletteColor}
                  disabled={paletteColors.length >= 24}
                  style={{
                    width: 24, height: 24, borderRadius: 6, border: "1px solid #334155",
                    background: paletteColors.length >= 24 ? "transparent" : "rgba(255,255,255,0.05)",
                    color: paletteColors.length >= 24 ? "#334155" : "#94a3b8",
                    fontSize: 16, lineHeight: 1, cursor: paletteColors.length >= 24 ? "default" : "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center", padding: 0,
                  }}
                >+</button>
              </div>

              {/* Editable palette swatches */}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
                {paletteColors.map((c, i) => (
                  <div key={i} style={{ position: "relative" }}>
                    <div
                      onClick={() => setEditingPaletteIdx(editingPaletteIdx === i ? null : i)}
                      style={{
                        width: 32, height: 32, borderRadius: 6, cursor: "pointer",
                        background: `rgb(${c.r},${c.g},${c.b})`,
                        border: editingPaletteIdx === i ? "2px solid #34d399" : "2px solid rgba(255,255,255,0.15)",
                        transition: "border 0.15s",
                      }}
                    />
                    {paletteColors.length > 2 && (
                      <button onClick={(e) => { e.stopPropagation(); removePaletteColor(i); }}
                        style={{
                          position: "absolute", top: -6, right: -6,
                          width: 14, height: 14, borderRadius: "50%", border: "none",
                          background: "#475569", color: "#e2e8f0", fontSize: 9,
                          cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                          lineHeight: 1, padding: 0,
                        }}
                      >&times;</button>
                    )}
                  </div>
                ))}
              </div>

              {/* Inline color picker for selected swatch */}
              {editingPaletteIdx !== null && editingPaletteIdx < paletteColors.length && (
                <div style={{ marginBottom: 12 }}>
                  <ColorPicker
                    size={120}
                    currentColor={paletteColors[editingPaletteIdx]}
                    onColorSelect={(r, g, b) => updatePaletteColor(editingPaletteIdx, r, g, b)}
                    favorites={favorites}
                    onFavoritesChange={onFavoritesChange}
                    compact={true}
                  />
                </div>
              )}
              </>)}
            </div>
          )}

          {/* ─── Custom mode ─────────────────────────────────────── */}
          {mode === "custom" && (
            <div>
              <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 10 }}>
                {colorSpace === "color"
                  ? "1-4 of your own colors. Lights are randomly assigned a seed so neighbors prefer different families. Shuffle to re-roll."
                  : `Temperatures at or below your chosen maximum, spread from ${CT_MIN_K}K and assigned so neighbors differ.`}
              </div>

              {colorSpace === "white" && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 11, color: "#64748b", marginBottom: 6 }}>
                    Maximum temperature:
                  </div>
                  <ColorTempSlider kelvin={maxKelvin} onChange={setMaxKelvin} />
                </div>
              )}

              {/* Exact vs Shades toggle */}
              {colorSpace === "color" && (<>
              <div style={{
                display: "flex", gap: 4, marginBottom: 12,
                background: "#0f172a", borderRadius: 8, padding: 3,
                border: "1px solid #1e293b",
              }}>
                {[
                  { key: "shades", label: "Create shades" },
                  { key: "exact", label: "Use exact seed colors" },
                ].map(opt => (
                  <button key={opt.key}
                    onClick={() => setCustomShadeMode(opt.key)}
                    style={{
                      flex: 1, padding: "6px 10px", borderRadius: 6, border: "none",
                      background: customShadeMode === opt.key ? "#6366f1" : "transparent",
                      color: customShadeMode === opt.key ? "#fff" : "#94a3b8",
                      fontSize: 11, fontWeight: 600, cursor: "pointer",
                    }}
                  >{opt.label}</button>
                ))}
              </div>

              {/* Color slots — each is a Color (hue) or White (temperature)
                  selector, so one scene can mix vivid colors and white shades. */}
              <div style={{ fontSize: 11, color: "#64748b", marginBottom: 6 }}>
                Seed colors ({customColors.length} of 4):
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
                {customColors.map((c, idx) => {
                  const isWhite = c.kelvin != null;
                  const setSlot = (next) =>
                    setCustomColors(prev => prev.map((cc, i) => i === idx ? next : cc));
                  return (
                  <div key={idx} style={{
                    display: "flex", flexDirection: "column", gap: 6,
                    background: "#0f172a", border: "1px solid #1e293b",
                    borderRadius: 8, padding: 8,
                  }}>
                    {/* Header row: swatch | Color/White toggle | readout | × */}
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{
                        width: 24, height: 24, borderRadius: 6, flexShrink: 0,
                        background: `rgb(${c.r},${c.g},${c.b})`,
                        border: "1px solid rgba(255,255,255,0.2)",
                      }} />
                      <div style={{ display: "flex", gap: 3, background: "#1e293b", borderRadius: 6, padding: 2 }}>
                        {[{ k: "color", l: "Color" }, { k: "white", l: "White" }].map(opt => {
                          const active = (opt.k === "white") === isWhite;
                          return (
                            <button key={opt.k}
                              onClick={() => {
                                if (opt.k === "white" && !isWhite) setSlot({ ...kelvinToRGB(3000), kelvin: 3000 });
                                else if (opt.k === "color" && isWhite) { const { kelvin, ...rgb } = c; setSlot(rgb); }
                              }}
                              style={{
                                padding: "3px 10px", borderRadius: 4, border: "none",
                                background: active ? "#6366f1" : "transparent",
                                color: active ? "#fff" : "#94a3b8",
                                fontSize: 10, fontWeight: 600, cursor: "pointer",
                              }}
                            >{opt.l}</button>
                          );
                        })}
                      </div>
                      <span style={{
                        marginLeft: "auto", fontSize: 10, color: "#94a3b8",
                        fontFamily: "monospace", flexShrink: 0,
                      }}>{isWhite ? `${c.kelvin}K` : `R:${c.r} G:${c.g} B:${c.b}`}</span>
                      {idx > 0 && (
                        <button
                          onClick={() => setCustomColors(prev => prev.filter((_, i) => i !== idx))}
                          style={{
                            width: 22, height: 22, borderRadius: 11,
                            background: "transparent", color: "#f87171",
                            border: "1px solid #7f1d1d", cursor: "pointer",
                            fontSize: 12, fontWeight: 700, lineHeight: 1,
                            padding: 0, flexShrink: 0,
                          }}
                          title="Remove slot"
                        >×</button>
                      )}
                    </div>
                    {/* Selector: hue bar (color) or temperature slider (white) */}
                    {isWhite ? (
                      <ColorTempSlider
                        kelvin={c.kelvin}
                        onChange={(k) => setSlot({ ...kelvinToRGB(k), kelvin: k })}
                      />
                    ) : (
                      <HueBar currentColor={c} onChange={(rgb) => setSlot(rgb)} />
                    )}
                  </div>
                  );
                })}
                {customColors.length < 4 && (
                  <button
                    onClick={() => {
                      const last = customColors[customColors.length - 1];
                      setCustomColors(prev => [...prev, { ...last }]);
                    }}
                    style={{
                      alignSelf: "flex-start",
                      padding: "5px 12px", borderRadius: 6,
                      background: "transparent", color: "#a5b4fc",
                      border: "1px dashed #475569", cursor: "pointer",
                      fontSize: 11, fontWeight: 600,
                    }}
                  >+ Add color</button>
                )}
              </div>
              </>)}
            </div>
          )}

          {/* ─── Beacon mode ─────────────────────────────────────── */}
          {mode === "beacon" && (
            <div>
              <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 10 }}>
                {colorSpace === "color"
                  ? "One color radiating from a single source. Brightness falls off with distance, down to 5% at the far extent."
                  : "One white temperature radiating from a single source. Brightness falls off with distance, down to 5% at the far extent."}
              </div>

              <BeaconSourcePicker
                sourceKey={beaconSourceKey}
                onSourceChange={setBeaconSourceKey}
                placedLights={placedColorLights}
                layout={layout}
                preview={preview}
                lightMap={lightMap}
                nicknames={nicknames}
                isLinear={isLinear}
              />

              {colorSpace === "color" ? (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 11, color: "#64748b", marginBottom: 4 }}>Color:</div>
                  <ColorPicker
                    size={120}
                    currentColor={baseColor}
                    onColorSelect={(r, g, b) => setBaseColor({ r, g, b })}
                    favorites={favorites}
                    onFavoritesChange={onFavoritesChange}
                    compact={true}
                  />
                </div>
              ) : (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 11, color: "#64748b", marginBottom: 6 }}>Temperature:</div>
                  <ColorTempSlider kelvin={maxKelvin} onChange={setMaxKelvin} />
                </div>
              )}
            </div>
          )}

          {/* ─── Teams mode ──────────────────────────────────────── */}
          {mode === "teams" && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 10 }}>
                Pick a pro team (NFL · NBA · MLB · NHL); its colors fill the room in a repeating pattern. Shuffle rotates the pattern.
              </div>
              <ShadeToggle value={customShadeMode} onChange={setCustomShadeMode} />
              <PresetPicker items={PRESET_TEAMS} value={selectedTeam} onChange={setSelectedTeam} placeholder="Search teams…" isMobile={isMobile} />
            </div>
          )}

          {/* ─── NCAA mode ───────────────────────────────────────── */}
          {mode === "ncaa" && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 10 }}>
                Pick a Power 5 program (SEC · Big Ten · Big 12 · ACC · Pac-12); its colors fill the room in a repeating pattern.
              </div>
              <ShadeToggle value={customShadeMode} onChange={setCustomShadeMode} />
              <PresetPicker items={PRESET_NCAA} value={selectedNcaa} onChange={setSelectedNcaa} placeholder="Search schools…" isMobile={isMobile} />
            </div>
          )}

          {/* ─── Flags mode ──────────────────────────────────────── */}
          {mode === "flags" && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 10 }}>
                Pick a country; its flag colors fill the room in a repeating pattern (black is skipped).
              </div>
              <ShadeToggle value={customShadeMode} onChange={setCustomShadeMode} />
              <PresetPicker items={PRESET_FLAGS} value={selectedFlag} onChange={setSelectedFlag} placeholder="Search countries…" isMobile={isMobile} />
            </div>
          )}

          {/* ─── Preview swatches ────────────────────────────────── */}
          {preview && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: "#64748b", marginBottom: 6 }}>Preview:</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {Object.entries(preview)
                  .sort(([aKey], [bKey]) => {
                    const aEntry = placedColorLights.find(p => p.key === aKey);
                    const bEntry = placedColorLights.find(p => p.key === bKey);
                    const aPos = aEntry || { x: 0, y: 0 };
                    const bPos = bEntry || { x: 0, y: 0 };
                    return aPos.x !== bPos.x ? aPos.x - bPos.x : aPos.y - bPos.y;
                  })
                  .map(([key, c]) => {
                    const sm = key.match(/^(.+):seg(\d+)$/);
                    const lk = sm ? sm[1] : key;
                    const bn = getDeviceLabel(lightMap[lk], nicknames);
                    const letter = sm ? String.fromCharCode(65 + parseInt(sm[2])) : null;
                    const label = sm ? `${bn.split(" ")[0]} ${letter}` : bn;
                    return (
                      <div key={key} title={sm ? `${bn} — Segment ${letter}` : bn}
                        style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, cursor: "default" }}>
                        <div style={{ position: "relative", width: 40, height: 40 }}>
                          <div style={{
                            width: 40, height: 40, borderRadius: sm ? 6 : 8,
                            background: dimRgbCss(c),
                            border: sm ? "2px dashed rgba(255,255,255,0.4)" : "1px solid rgba(255,255,255,0.2)",
                          }} />
                          {c.brightness !== undefined && (
                            <span style={{
                              position: "absolute", top: 1, left: 3,
                              fontSize: 9, fontWeight: 700, color: "rgba(255,255,255,0.85)",
                              textShadow: "0 0 3px rgba(0,0,0,0.8)",
                            }}>{Math.round(c.brightness)}%</span>
                          )}
                          {sm && (
                            <span style={{
                              position: "absolute", bottom: 2, right: 4,
                              fontSize: 11, fontWeight: 800, color: "rgba(255,255,255,0.9)",
                              textShadow: "0 0 4px rgba(0,0,0,0.8)",
                            }}>{letter}</span>
                          )}
                        </div>
                        <span style={{ fontSize: 9, color: "#94a3b8", maxWidth: 46, textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {label}
                        </span>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}

          {/* ─── Brightness slider ─────────────────────────────────── */}
          <div style={{ marginBottom: 12 }}>
            <Slider
              label={mode === "beacon" ? "Source brightness" : "Brightness"}
              value={brightness} min={0} max={100}
              onChange={(val) => setBrightness(val)}
              color="#fbbf24" unit="%"
            />
          </div>

          {/* ─── Action buttons ──────────────────────────────────── */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button onClick={() => {
                // Gradient/beacon are deterministic (spatial) — just regenerate.
                // Palette/tonal/custom re-roll by bumping the seed, which also
                // syncs the new layout to other sessions on Apply.
                if (mode === "gradient" || mode === "beacon") generatePreview();
                else setShuffleSeed(s => s + 1);
              }}
              disabled={applying}
              style={{
                padding: "6px 16px", borderRadius: 8, border: "1px solid #334155",
                background: "transparent", color: applying ? "#475569" : "#94a3b8",
                fontSize: 12, fontWeight: 600, cursor: applying ? "not-allowed" : "pointer",
              }}
            >{mode === "gradient" || mode === "beacon" ? "Preview" : "Shuffle"}</button>
            <button onClick={applyColors}
              disabled={!preview || applying}
              style={{
                padding: "6px 16px", borderRadius: 8, border: "none",
                background: applying ? "#fbbf24" : (preview ? "#34d399" : "#334155"),
                color: applying || preview ? "#0f172a" : "#64748b",
                fontSize: 12, fontWeight: 600,
                cursor: applying ? "wait" : (preview ? "pointer" : "default"),
                minWidth: applying ? 170 : 80,
                position: "relative", overflow: "hidden",
                transition: "background 0.2s",
              }}
            >
              {applying ? (
                <>
                  <span style={{ position: "relative", zIndex: 1 }}>
                    {applyPhase === "resetting" ? "Resetting" : "Applying"} {applyDone}/{applyTotal}{secondsLeft > 0 ? ` · ${secondsLeft}s` : "…"}
                  </span>
                  <div style={{
                    position: "absolute", left: 0, bottom: 0, height: 3,
                    width: `${applyTotal > 0 ? (applyDone / applyTotal) * 100 : 0}%`,
                    background: "#0f172a", transition: "width 0.2s ease",
                  }} />
                </>
              ) : "Apply"}
            </button>
            {applying && (
              <button onClick={cancelApply}
                style={{
                  padding: "6px 16px", borderRadius: 8, border: "1px solid #ef4444",
                  background: "transparent", color: "#f87171",
                  fontSize: 12, fontWeight: 700, cursor: "pointer",
                }}
              >Cancel</button>
            )}
          </div>

          {/* Live progress label — which device/segment is updating right now.
              Helps when a many-segment room takes 40s+ to apply. */}
          {applying && applyLabel && (
            <div style={{
              marginTop: 8, fontSize: 11, color: "#94a3b8",
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
            }}>
              Updating <span style={{ color: "#e2e8f0", fontWeight: 600 }}>{applyLabel}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
