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

function ColorMode({ roomName, hueLights, goveeDevices, onControlHue, onControlGovee, favorites, onFavoritesChange, nicknames, segmentInfo, roomLayouts, fixtures, onApply }) {
  const isMobile = useIsMobile();
  const [mode, setMode] = useState("gradient"); // "gradient" | "tonal" | "palette" | "beacon"
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

  // Apply progress state
  const [applying, setApplying] = useState(false);
  const [applyPhase, setApplyPhase] = useState(null); // "resetting" | "applying" | null
  const [applyTotal, setApplyTotal] = useState(0);
  const [applyDone, setApplyDone] = useState(0);
  const [applyEndAt, setApplyEndAt] = useState(0);
  const [tickNow, setTickNow] = useState(0);

  // Tick clock for the countdown while applying
  useEffect(() => {
    if (!applying) return;
    setTickNow(Date.now());
    const id = setInterval(() => setTickNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [applying]);

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
  // Two entries (lights or segments) are adjacent if any of:
  //   1. They're within the spatial threshold on the map
  //   2. Their parent devices share a fixture (intra-fixture distinctness)
  //   3. One is spatially adjacent to a fixture-mate of the other (any
  //      fixture member "borrows" all its fixture-mates' adjacencies)
  const buildAdjacency = useCallback((entries) => {
    const threshold = 8; // grid units — roughly "touching" distance
    const adj = {};
    entries.forEach(e => { adj[e.key] = new Set(); });

    // 1. Spatial adjacency
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

    // Map parent device key → fixture id, and fixture id → entry keys present
    // in this room's adjacency (so a fixture's segments inherit membership).
    const parentKey = (k) => {
      const m = k.match(/^(.+):seg\d+$/);
      return m ? m[1] : k;
    };
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
        chosen = candidates[Math.floor(Math.random() * candidates.length)];
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
        chosen = bestCandidates[Math.floor(Math.random() * bestCandidates.length)];
      }

      assignment[device.key] = chosen;
      usage[chosen]++;
    });

    // Post-pass: greedy local-search swap. The forward pass is myopic —
    // when relax-1 drops the similarity gate it can leave same-family
    // colors on adjacent devices even though a global rearrangement
    // would resolve the conflict. Swapping two device assignments
    // preserves global color usage (and tier counts) but can eliminate
    // a violation that no single-device re-choice could fix.
    const violation = (ci, cj) =>
      (ci === cj || colorDist(ci, cj) < SIMILARITY_THRESHOLD) ? 1 : 0;
    const deltaSwap = (a, b) => {
      const ca = assignment[a], cb = assignment[b];
      if (ca === cb) return 0;
      let before = 0, after = 0;
      adj[a]?.forEach(nk => {
        if (nk === b) return;
        const cn = assignment[nk];
        if (cn === undefined) return;
        before += violation(ca, cn);
        after += violation(cb, cn);
      });
      adj[b]?.forEach(nk => {
        if (nk === a) return;
        const cn = assignment[nk];
        if (cn === undefined) return;
        before += violation(cb, cn);
        after += violation(ca, cn);
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

    const result = {};
    Object.entries(assignment).forEach(([key, ci]) => {
      result[key] = colors[ci];
    });
    return result;
  }, [placedColorLights, paletteColors, buildAdjacency]);

  // ─── Tonal mode: 8 shades of one color, randomly assigned with adjacency gap ─
  const computeTonal = useCallback(() => {
    if (placedColorLights.length === 0) return null;
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
        const j = Math.floor(Math.random() * (i + 1));
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
  }, [placedColorLights, baseColor, buildAdjacency]);

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
  const generatePreview = () => {
    if (mode === "gradient") setPreview(computeGradient());
    else if (mode === "tonal") setPreview(computeTonal());
    else if (mode === "beacon") setPreview(computeBeacon());
    else setPreview(computePalette());
  };

  // Auto-generate preview when inputs change
  useEffect(() => {
    if (!hasLayout) return;
    if (mode === "gradient") setPreview(computeGradient());
    else if (mode === "tonal") setPreview(computeTonal());
    else if (mode === "beacon") setPreview(computeBeacon());
    else setPreview(computePalette());
  }, [mode, baseColor, direction, paletteColors, hasLayout, layout, fixtures, beaconSourceKey, brightness]);

  // ─── Apply colors to lights ─────────────────────────────────────────
  const applyColors = () => {
    if (!preview || applying) return;
    const entries = Object.entries(preview);

    // Split entries by destination protocol so we can schedule each correctly:
    // Hue lights: parallel (REST API, fast)
    // Govee whole-device: stagger 150ms (LAN UDP, fire-and-forget)
    // Govee segments: stagger 1800ms on apply (V2 cloud API, burst-bucket limited).
    //   Reset uses HYBRID: one V1 LAN whole-device white per segmented device
    //   (parallel UDP, ~3s server roundtrip), then 2s hold before V2 apply pass.
    //   Confirmed on 2-pack and 4-pack outdoor spots: V1 cleanly substitutes
    //   for the per-segment V2 reset pass and avoids the burst-bucket pressure.
    const SEG_APPLY_STAGGER = 1800;
    const SEG_WHITE_HOLD = 2000;
    const V1_RESET_BUDGET = 3500;
    const segmentEntries = entries.filter(([key]) => /^govee:.+:seg\d+$/.test(key));
    const hueEntries = entries.filter(([key]) => key.startsWith("hue:"));
    const goveeEntries = entries.filter(([key]) => /^govee:[^:]+$/.test(key));

    // Unique parent device keys for segments needing reset (one V1 white each)
    const resetDeviceKeys = [...new Set(
      segmentEntries
        .map(([key]) => {
          const m = key.match(/^(govee:[^:]+):seg\d+$/);
          return m ? m[1] : null;
        })
        .filter(Boolean)
    )];

    const segCount = segmentEntries.length;
    const hueCount = hueEntries.length;
    const goveeCount = goveeEntries.length;
    const resetCount = resetDeviceKeys.length;
    const applyCount = hueCount + goveeCount + segCount;
    if (applyCount === 0) return;

    // Wall-clock estimates per phase
    const resetMs = resetCount > 0 ? V1_RESET_BUDGET : 0;
    const holdMs = resetCount > 0 ? SEG_WHITE_HOLD : 0;
    const applyMsSeg = segCount > 0 ? (segCount - 1) * SEG_APPLY_STAGGER + 100 : 0;
    const applyMsGovee = goveeCount > 0 ? (goveeCount - 1) * 150 + 200 : 0;
    const applyMs = Math.max(applyMsSeg, applyMsGovee, hueCount > 0 ? 50 : 0);
    const totalMs = Math.max(resetMs + holdMs + applyMs, 300);

    setApplying(true);
    setApplyEndAt(Date.now() + totalMs);
    setTickNow(Date.now());

    // ─── Phase 1: V1 LAN whole-device white reset (skipped if no segments) ──
    if (resetCount > 0) {
      setApplyPhase("resetting");
      setApplyTotal(resetCount);
      setApplyDone(0);

      let resetCompleted = 0;
      const resetTick = () => { resetCompleted++; setApplyDone(resetCompleted); };

      // All V1 LAN whites fire in parallel — UDP fire-and-forget, no rate limit
      resetDeviceKeys.forEach(parentKey => {
        const light = lightMap[parentKey];
        if (!light) { resetTick(); return; }
        api("/govee/control", {
          method: "POST",
          body: JSON.stringify({ ip: light.ip, r: 255, g: 255, b: 255 }),
          headers: { "Content-Type": "application/json" },
        })
          .catch(e => console.warn("[ColorMode] V1 reset failed:", parentKey, e))
          .finally(() => resetTick());
      });
    }

    // ─── Phase 2: apply (Hue + Govee whole-device + Govee segments) ──
    const phase2Start = resetMs + holdMs;
    setTimeout(() => {
      setApplyPhase("applying");
      setApplyTotal(applyCount);
      setApplyDone(0);

      let applyCompleted = 0;
      const applyTick = () => {
        applyCompleted++;
        setApplyDone(applyCompleted);
        if (applyCompleted >= applyCount) {
          setApplying(false);
          setApplyPhase(null);
        }
      };

      // Hue lights: fire immediately (Hue bridge handles concurrency well)
      hueEntries.forEach(([key, color]) => {
        const light = lightMap[key];
        if (!light || !light._controlFn) { applyTick(); return; }
        const briPct = color.brightness ?? brightness;
        const bri = Math.round(briPct * 254 / 100);
        light._controlFn(light, { on: true, r: color.r, g: color.g, b: color.b, brightness: bri });
        applyTick();
      });

      // Govee whole-device (LAN UDP, staggered)
      let goveeDelay = 0;
      goveeEntries.forEach(([key, color]) => {
        const light = lightMap[key];
        if (!light || !light._controlFn) { applyTick(); return; }
        const cmd = { on: true, r: color.r, g: color.g, b: color.b, brightness: color.brightness ?? brightness };
        setTimeout(() => {
          light._controlFn(light, cmd);
          applyTick();
        }, goveeDelay);
        goveeDelay += 150;
      });

      // Govee segments (V2 cloud, staggered)
      let segDelay = 0;
      segmentEntries.forEach(([key, color]) => {
        const segMatch = key.match(/^(govee:.+):seg(\d+)$/);
        const light = lightMap[segMatch[1]];
        if (!light) { applyTick(); return; }
        const cmd = { ip: light.ip, sku: light.sku, device_mac: light.mac, segment_idx: parseInt(segMatch[2]), r: color.r, g: color.g, b: color.b, brightness: color.brightness ?? brightness };
        setTimeout(() => {
          api("/govee/segment-control", { method: "POST", body: JSON.stringify(cmd), headers: { "Content-Type": "application/json" } })
            .catch(e => console.warn("[ColorMode] Segment control failed:", key, e));
          applyTick();
        }, segDelay);
        segDelay += SEG_APPLY_STAGGER;
      });
    }, phase2Start);

    // Notify map so it updates dot colors and clears Identify active state
    if (onApply) onApply(preview);
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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
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
          <button onClick={() => setMode("tonal")} style={btnStyle(mode === "tonal")}>
            Tonal
          </button>
          <button onClick={() => setMode("palette")} style={btnStyle(mode === "palette")}>
            Palette
          </button>
          <button onClick={() => setMode("beacon")} style={btnStyle(mode === "beacon")}>
            Beacon
          </button>
        </div>
      </div>

      {!hasLayout && (
        <div style={{ fontSize: 12, color: "#64748b", padding: "12px 0" }}>
          {allLights.some(l => l.capabilities?.has_color)
            ? <>Place color lights on the room map first (Map &rarr; Edit Layout).</>
            : <>This room has no color lights.</>}
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

          {/* ─── Tonal mode ──────────────────────────────────────── */}
          {mode === "tonal" && (
            <div>
              <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 10 }}>
                8 shades of one color, randomly assigned so no adjacent lights share a similar tone.
              </div>

              {/* Live swatch row showing the 8 generated shades */}
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: "#64748b", marginBottom: 4 }}>Generated shades:</div>
                <div style={{ display: "flex", gap: 4 }}>
                  {generateTonalShades(baseColor.r, baseColor.g, baseColor.b, 8).map((c, i) => (
                    <div key={i} style={{
                      width: 24, height: 24, borderRadius: 5,
                      background: `rgb(${c.r},${c.g},${c.b})`,
                      border: "1px solid rgba(255,255,255,0.12)",
                    }} />
                  ))}
                </div>
              </div>

              {/* Base color picker */}
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

              {/* Search + category filter + filtered grid */}
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
            </div>
          )}

          {/* ─── Beacon mode ─────────────────────────────────────── */}
          {mode === "beacon" && (
            <div>
              <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 10 }}>
                One color radiating from a single source. Brightness falls off with distance, down to 5% at the far extent.
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
            <button onClick={generatePreview}
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
          </div>
        </>
      )}
    </div>
  );
}
