// ─── Color Mode Panel ──────────────────────────────────────────────────────
// Room-level color scheme control. Reads device positions from room layout.
// Two modes: "Gradient" (directional shades of one color) and "Palette" (distinct colors, no adjacent duplicates).

// ─── Gradient Direction Picker with Mini Map ──────────────────────────────
function GradientDirectionPicker({ direction, onDirectionChange, availableDirections, placedLights, layout, preview, lightMap, nicknames, isLinear }) {
  if (!layout || placedLights.length === 0) return null;

  const boundary = layout.boundary || {};
  const bw = isLinear ? (boundary.length || 20) : (boundary.width || 12);
  const bh = isLinear ? 3 : (boundary.height || 10);

  // Mini map sizing — scale to fit within a max width, keep aspect ratio
  const maxW = 280;
  const maxH = isLinear ? 48 : 160;
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
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
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

function ColorMode({ roomName, hueLights, goveeDevices, onControlHue, onControlGovee, favorites, onFavoritesChange, nicknames, segmentInfo, roomLayouts }) {
  const [mode, setMode] = useState("gradient"); // "gradient" | "palette"
  const [baseColor, setBaseColor] = useState({ r: 40, g: 180, b: 80 });
  const [paletteColors, setPaletteColors] = useState([
    { r: 255, g: 60, b: 60 },
    { r: 60, g: 180, b: 255 },
    { r: 60, g: 255, b: 120 },
    { r: 255, g: 200, b: 40 },
  ]);
  const [editingPaletteIdx, setEditingPaletteIdx] = useState(null);
  const [direction, setDirection] = useState("left-right");
  const [brightness, setBrightness] = useState(100); // 0-100%
  const [preview, setPreview] = useState(null); // { deviceKey: {r,g,b}, ... }

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

  // Build placed lights list, expanding segments where applicable
  const placedColorLights = [];
  Object.entries(devices).forEach(([key, pos]) => {
    const light = lightMap[key];
    if (!light?.capabilities?.has_color) return;
    const segData = segments[key];
    if (segData?.expanded && segData.positions) {
      // Expanded: add each segment as its own entry
      Object.entries(segData.positions).forEach(([si, sp]) => {
        placedColorLights.push({ key: `${key}:seg${si}`, x: sp.x, y: sp.y, parentKey: key, segIndex: parseInt(si) });
      });
    } else {
      placedColorLights.push({ key, x: pos.x, y: pos.y });
    }
  });

  const hasLayout = placedColorLights.length > 0;

  // ─── Adjacency graph (for palette mode) ─────────────────────────────
  // Two devices are "adjacent" if they're within a threshold distance on the map
  const buildAdjacency = useCallback((entries) => {
    const threshold = 8; // grid units — roughly "touching" distance
    const adj = {};
    entries.forEach(e => { adj[e.key] = new Set(); });
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const dx = entries[i].x - entries[j].x;
        const dy = entries[i].y - entries[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < threshold) {
          adj[entries[i].key].add(entries[j].key);
          adj[entries[j].key].add(entries[i].key);
        }
      }
    }
    return adj;
  }, []);

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

  // ─── Palette mode: graph-coloring with adjacency awareness ──────────
  const computePalette = useCallback(() => {
    if (placedColorLights.length === 0 || paletteColors.length === 0) return null;

    const adj = buildAdjacency(placedColorLights);
    const colors = paletteColors;

    // Sort devices by number of neighbors (most constrained first)
    const sorted = [...placedColorLights].sort((a, b) =>
      (adj[b.key]?.size || 0) - (adj[a.key]?.size || 0)
    );

    const assignment = {};

    sorted.forEach(device => {
      // Collect colors used by neighbors
      const neighborColors = new Set();
      adj[device.key]?.forEach(nk => {
        if (assignment[nk] !== undefined) neighborColors.add(assignment[nk]);
      });

      // Pick first color not used by a neighbor; if all used, pick randomly
      let chosen = -1;
      // Shuffle order so repeated calls vary
      const indices = Array.from({ length: colors.length }, (_, i) => i);
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }
      for (const idx of indices) {
        if (!neighborColors.has(idx)) { chosen = idx; break; }
      }
      if (chosen === -1) chosen = indices[0]; // fallback
      assignment[device.key] = chosen;
    });

    const result = {};
    Object.entries(assignment).forEach(([key, ci]) => {
      result[key] = colors[ci];
    });
    return result;
  }, [placedColorLights, paletteColors, buildAdjacency]);

  // ─── Generate preview ───────────────────────────────────────────────
  const generatePreview = () => {
    if (mode === "gradient") {
      setPreview(computeGradient());
    } else {
      setPreview(computePalette());
    }
  };

  // Auto-generate preview when inputs change
  useEffect(() => {
    if (!hasLayout) return;
    if (mode === "gradient") {
      setPreview(computeGradient());
    } else {
      setPreview(computePalette());
    }
  }, [mode, baseColor, direction, paletteColors, hasLayout, layout]);

  // ─── Apply colors to lights ─────────────────────────────────────────
  const applyColors = () => {
    if (!preview) return;
    const entries = Object.entries(preview);
    // Hue lights: parallel (REST API)
    // Govee whole-device: stagger 150ms (LAN UDP)
    // Govee segments: stagger 1500ms (V2 cloud API rate limit)
    let goveeDelay = 0;
    let segDelay = 0;
    entries.forEach(([key, color]) => {
      // Check if this is a segment key (e.g. "govee:192.168.0.186:seg0")
      const segMatch = key.match(/^(govee:.+):seg(\d+)$/);
      if (segMatch) {
        const parentKey = segMatch[1];
        const segIdx = parseInt(segMatch[2]);
        const light = lightMap[parentKey];
        if (!light) return;
        // Send segment color via V2 cloud API
        const cmd = { ip: light.ip, sku: light.sku, device_mac: light.mac, segment_idx: segIdx, r: color.r, g: color.g, b: color.b, brightness };
        setTimeout(() => {
          api("/govee/segment-control", { method: "POST", body: JSON.stringify(cmd), headers: { "Content-Type": "application/json" } })
            .catch(e => console.warn("[ColorMode] Segment control failed:", key, e));
        }, segDelay);
        segDelay += 1500; // V2 API rate limit ~1 req/sec
        return;
      }

      const light = lightMap[key];
      if (!light || !light._controlFn) return;
      const bri = light.type === "hue" ? Math.round(brightness * 254 / 100) : brightness;
      const cmd = { on: true, r: color.r, g: color.g, b: color.b, brightness: bri };
      if (light.type === "govee") {
        setTimeout(() => light._controlFn(light, cmd), goveeDelay);
        goveeDelay += 150;
      } else {
        light._controlFn(light, cmd);
      }
    });
  };

  // ─── Palette color management ───────────────────────────────────────
  const addPaletteColor = () => {
    setPaletteColors(prev => [...prev, { r: 128, g: 128, b: 128 }]);
  };

  const removePaletteColor = (idx) => {
    if (paletteColors.length <= 2) return; // need at least 2
    setPaletteColors(prev => prev.filter((_, i) => i !== idx));
    if (editingPaletteIdx === idx) setEditingPaletteIdx(null);
  };

  const updatePaletteColor = (idx, r, g, b) => {
    setPaletteColors(prev => prev.map((c, i) => i === idx ? { r, g, b } : c));
  };

  // ─── Color scheme presets (grouped into rows) ───────────────────────
  const schemePresetRows = [
    {
      label: "Spring / Easter",
      presets: [
        { name: "Easter Pastel", colors: [{ r: 230, g: 180, b: 230 }, { r: 160, g: 220, b: 190 }, { r: 160, g: 210, b: 240 }, { r: 255, g: 235, b: 150 }] },
        { name: "Spring Bloom", colors: [{ r: 255, g: 175, b: 200 }, { r: 255, g: 220, b: 40 }, { r: 100, g: 195, b: 100 }, { r: 120, g: 160, b: 235 }] },
        { name: "Easter Egg", colors: [{ r: 240, g: 130, b: 160 }, { r: 120, g: 170, b: 240 }, { r: 200, g: 145, b: 235 }, { r: 100, g: 215, b: 175 }] },
        { name: "Spring Garden", colors: [{ r: 195, g: 135, b: 255 }, { r: 255, g: 155, b: 130 }, { r: 155, g: 230, b: 165 }, { r: 135, g: 200, b: 255 }] },
      ],
    },
    {
      label: "Warm",
      presets: [
        { name: "Warm", colors: [{ r: 255, g: 80, b: 40 }, { r: 255, g: 160, b: 30 }, { r: 255, g: 220, b: 80 }, { r: 200, g: 60, b: 60 }] },
        { name: "Sunset", colors: [{ r: 255, g: 94, b: 77 }, { r: 255, g: 154, b: 0 }, { r: 255, g: 206, b: 84 }, { r: 200, g: 50, b: 100 }] },
        { name: "Autumn", colors: [{ r: 205, g: 92, b: 40 }, { r: 255, g: 140, b: 0 }, { r: 180, g: 60, b: 30 }, { r: 218, g: 165, b: 32 }] },
        { name: "Campfire", colors: [{ r: 220, g: 40, b: 20 }, { r: 255, g: 120, b: 0 }, { r: 255, g: 215, b: 0 }, { r: 255, g: 80, b: 20 }] },
      ],
    },
    {
      label: "Cool",
      presets: [
        { name: "Cool", colors: [{ r: 40, g: 120, b: 255 }, { r: 80, g: 200, b: 255 }, { r: 40, g: 255, b: 200 }, { r: 100, g: 80, b: 220 }] },
        { name: "Ocean", colors: [{ r: 0, g: 105, b: 148 }, { r: 0, g: 168, b: 198 }, { r: 72, g: 202, b: 228 }, { r: 144, g: 224, b: 239 }] },
        { name: "Aurora", colors: [{ r: 0, g: 230, b: 150 }, { r: 0, g: 200, b: 255 }, { r: 120, g: 60, b: 220 }, { r: 0, g: 180, b: 100 }] },
        { name: "Midnight", colors: [{ r: 30, g: 60, b: 180 }, { r: 80, g: 30, b: 160 }, { r: 140, g: 60, b: 200 }, { r: 10, g: 100, b: 200 }] },
      ],
    },
    {
      label: "Nature / Bold",
      presets: [
        { name: "Forest", colors: [{ r: 34, g: 139, b: 34 }, { r: 107, g: 142, b: 35 }, { r: 85, g: 107, b: 47 }, { r: 144, g: 238, b: 144 }] },
        { name: "Neon", colors: [{ r: 255, g: 0, b: 255 }, { r: 0, g: 255, b: 255 }, { r: 255, g: 255, b: 0 }, { r: 0, g: 255, b: 128 }] },
        { name: "Retro", colors: [{ r: 0, g: 188, b: 188 }, { r: 255, g: 100, b: 90 }, { r: 218, g: 165, b: 0 }, { r: 100, g: 170, b: 100 }] },
        { name: "Candy", colors: [{ r: 255, g: 0, b: 150 }, { r: 0, g: 200, b: 220 }, { r: 180, g: 255, b: 0 }, { r: 180, g: 100, b: 255 }] },
      ],
    },
  ];

  const isLinear = layout?.mode === "linear";
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
      borderRadius: 16, padding: 20, marginBottom: 16,
      border: "1px solid #334155",
    }}>
      {/* Header with mode tabs */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div style={{
          fontSize: 12, fontWeight: 600, color: "#34d399",
          textTransform: "uppercase", letterSpacing: 0.8,
        }}>
          Color Mode
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => setMode("gradient")} style={btnStyle(mode === "gradient")}>
            Gradient
          </button>
          <button onClick={() => setMode("palette")} style={btnStyle(mode === "palette")}>
            Palette
          </button>
        </div>
      </div>

      {!hasLayout && (
        <div style={{ fontSize: 12, color: "#64748b", padding: "12px 0" }}>
          Place color lights on the room map first (Map &rarr; Edit Layout).
        </div>
      )}

      {hasLayout && (
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

              {/* Base color */}
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
            </div>
          )}

          {/* ─── Palette mode ────────────────────────────────────── */}
          {mode === "palette" && (
            <div>
              <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 8 }}>
                Distinct colors assigned to devices. Adjacent lights on the map won't share a color.
              </div>

              {/* Scheme presets — grouped rows */}
              <div style={{ marginBottom: 12 }}>
                {schemePresetRows.map((row) => (
                  <div key={row.label} style={{ marginBottom: 6 }}>
                    <div style={{ fontSize: 9, color: "#475569", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 3 }}>
                      {row.label}
                    </div>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {row.presets.map((scheme) => (
                        <button key={scheme.name}
                          onClick={() => { setPaletteColors([...scheme.colors]); setEditingPaletteIdx(null); }}
                          style={{
                            padding: "4px 10px", borderRadius: 6, border: "1px solid #334155",
                            background: "transparent", cursor: "pointer",
                            display: "flex", alignItems: "center", gap: 4,
                          }}
                        >
                          <span style={{ display: "flex", gap: 2 }}>
                            {scheme.colors.map((c, j) => (
                              <span key={j} style={{
                                width: 8, height: 8, borderRadius: 2,
                                background: `rgb(${c.r},${c.g},${c.b})`,
                                display: "inline-block",
                              }} />
                            ))}
                          </span>
                          <span style={{ fontSize: 10, color: "#94a3b8" }}>{scheme.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
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
                <button onClick={addPaletteColor}
                  style={{
                    width: 32, height: 32, borderRadius: 6, border: "1px dashed #475569",
                    background: "transparent", color: "#64748b", fontSize: 16,
                    cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                >+</button>
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
                            background: `rgb(${c.r},${c.g},${c.b})`,
                            border: sm ? "2px dashed rgba(255,255,255,0.4)" : "1px solid rgba(255,255,255,0.2)",
                          }} />
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
              label="Brightness" value={brightness} min={0} max={100}
              onChange={(val) => setBrightness(val)}
              color="#fbbf24" unit="%"
            />
          </div>

          {/* ─── Action buttons ──────────────────────────────────── */}
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={generatePreview}
              style={{
                padding: "6px 16px", borderRadius: 8, border: "1px solid #334155",
                background: "transparent", color: "#94a3b8", fontSize: 12, fontWeight: 600, cursor: "pointer",
              }}
            >{mode === "palette" ? "Shuffle" : "Preview"}</button>
            <button onClick={applyColors}
              disabled={!preview}
              style={{
                padding: "6px 16px", borderRadius: 8, border: "none",
                background: preview ? "#34d399" : "#334155",
                color: preview ? "#0f172a" : "#64748b",
                fontSize: 12, fontWeight: 600, cursor: preview ? "pointer" : "default",
              }}
            >Apply</button>
          </div>
        </>
      )}
    </div>
  );
}
