// ─── Room Map Components ───────────────────────────────────────────────────

const FURNITURE_TYPES = {
  door:   { label: "Door",   w: 1,   h: 1,   color: "#78716c" },
  window: { label: "Window", w: 2,   h: 0.6, color: "#7dd3fc" },
  couch:  { label: "Couch",  w: 3,   h: 2,   color: "#a78bfa" },
  table:  { label: "Table",  w: 2,   h: 3,   color: "#fbbf24" },
  tv:     { label: "TV",     w: 2.5, h: 0.6, color: "#64748b" },
  bed:    { label: "Bed",    w: 3,   h: 4,   color: "#f0abfc" },
  desk:   { label: "Desk",   w: 2,   h: 2,   color: "#fdba74" },
  label:  { label: "Label",  w: 1.5, h: 2,   color: "#475569" },
};

let _furnitureIdCounter = Date.now();
function nextFurnitureId() { return "f" + (++_furnitureIdCounter); }

function FurnitureItem({ item, gridSize, isEdit, isSelected, onSelect, onDragEnd, onRotate, onResize }) {
  const [dragging, setDragging] = useState(false);
  const [dragPos, setDragPos] = useState(null);
  const [resizing, setResizing] = useState(false);
  const [resizeSize, setResizeSize] = useState(null);
  const svgRef = useRef(null);

  const rot = item.rotation || 0;
  const w = item.w * gridSize;
  const h = item.h * gridSize;
  const cx = (item.x + 0.5) * gridSize;
  const cy = (item.y + 0.5) * gridSize;

  const dispCx = dragging && dragPos ? (dragPos.x + 0.5) * gridSize : cx;
  const dispCy = dragging && dragPos ? (dragPos.y + 0.5) * gridSize : cy;
  const dispW = resizing && resizeSize ? resizeSize.w * gridSize : w;
  const dispH = resizing && resizeSize ? resizeSize.h * gridSize : h;

  const typeDef = FURNITURE_TYPES[item.type] || FURNITURE_TYPES.label;
  const fillColor = typeDef.color;

  const startDrag = (e) => {
    if (!isEdit || resizing) return;
    e.stopPropagation();
    setDragging(true);
    svgRef.current = e.currentTarget.closest("svg");
  };

  const startResize = (e) => {
    if (!isEdit) return;
    e.stopPropagation();
    setResizing(true);
    svgRef.current = e.currentTarget.closest("svg");
  };

  // Drag movement
  useEffect(() => {
    if (!dragging) return;
    const svg = svgRef.current;
    if (!svg) return;
    const onMove = (e) => {
      const pt = svg.createSVGPoint();
      const src = e.touches ? e.touches[0] : e;
      pt.x = src.clientX; pt.y = src.clientY;
      const svgP = pt.matrixTransform(svg.getScreenCTM().inverse());
      setDragPos({ x: Math.round(svgP.x / gridSize - 0.5), y: Math.round(svgP.y / gridSize - 0.5) });
    };
    const onUp = () => {
      setDragging(false);
      if (dragPos && onDragEnd) onDragEnd(item.id, dragPos);
      setDragPos(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onUp);
    };
  }, [dragging, dragPos, item.id, gridSize, onDragEnd]);

  // Resize drag
  useEffect(() => {
    if (!resizing) return;
    const svg = svgRef.current;
    if (!svg) return;
    const onMove = (e) => {
      const pt = svg.createSVGPoint();
      const src = e.touches ? e.touches[0] : e;
      pt.x = src.clientX; pt.y = src.clientY;
      const svgP = pt.matrixTransform(svg.getScreenCTM().inverse());
      // Compute new size from drag position relative to item origin
      const originX = (item.x + 0.5) * gridSize;
      const originY = (item.y + 0.5) * gridSize;
      // Account for rotation
      let dx = svgP.x - originX;
      let dy = svgP.y - originY;
      if (rot === 90 || rot === 270) { [dx, dy] = [dy, -dx]; }
      if (rot === 180) { dx = -dx; dy = -dy; }
      const newW = Math.max(0.5, Math.round(dx / gridSize * 2) / 2);
      const newH = Math.max(0.3, Math.round(dy / gridSize * 2) / 2);
      setResizeSize({ w: newW, h: newH });
    };
    const onUp = () => {
      setResizing(false);
      if (resizeSize && onResize) onResize(item.id, resizeSize);
      setResizeSize(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onUp);
    };
  }, [resizing, resizeSize, item.id, item.x, item.y, rot, gridSize, onResize]);

  const transition = (dragging || resizing) ? "none" : "all 0.15s";

  return (
    <g
      transform={`rotate(${rot}, ${dispCx}, ${dispCy})`}
      style={{ cursor: isEdit ? "grab" : "default" }}
      onMouseDown={startDrag} onTouchStart={startDrag}
      onClick={(e) => { e.stopPropagation(); if (isEdit) onSelect(item.id); }}
    >
      <rect
        x={dispCx - dispW / 2} y={dispCy - dispH / 2}
        width={dispW} height={dispH}
        rx={3}
        fill={fillColor} opacity={isEdit ? 0.35 : 0.2}
        stroke={isSelected ? "#fff" : fillColor}
        strokeWidth={isSelected ? 2 : 1}
        strokeDasharray={item.type === "window" ? "4,2" : "none"}
        style={{ transition, pointerEvents: isEdit ? "auto" : "none" }}
      />
      {/* Window center line */}
      {item.type === "window" && (
        <line
          x1={dispCx - dispW / 2} y1={dispCy}
          x2={dispCx + dispW / 2} y2={dispCy}
          stroke={fillColor} strokeWidth={1} opacity={0.4}
          style={{ pointerEvents: "none" }}
        />
      )}
      <text
        x={dispCx} y={dispCy + 4}
        textAnchor="middle" fill={isEdit ? "#94a3b8" : "#475569"}
        fontSize={Math.min(10, dispW * 0.35)} fontFamily="sans-serif" fontWeight="600"
        style={{ pointerEvents: "none", userSelect: "none" }}
      >{item.label}</text>
      {/* Resize handle (edit + selected) */}
      {isEdit && isSelected && (
        <rect
          x={dispCx + dispW / 2 - 5} y={dispCy + dispH / 2 - 5}
          width={10} height={10} rx={2}
          fill="#6366f1" stroke="#fff" strokeWidth={1}
          style={{ cursor: "nwse-resize" }}
          onMouseDown={startResize} onTouchStart={startResize}
        />
      )}
    </g>
  );
}

function getDeviceColor(light) {
  // Always return the actual color regardless of on/off state.
  // On/off visual treatment is handled by the node components.
  const c = getInitialColor(light);
  if (c) return `rgb(${c.r},${c.g},${c.b})`;
  // Fallback: warm white for white-only bulbs, teal for Govee
  return light.type === "hue" ? "#c084fc" : "#34d399";
}

function getDeviceLabel(light, nicknames) {
  const key = light.type === "hue" ? `hue:${light.id}` : `govee:${light.ip}`;
  if (nicknames[key]) return nicknames[key];
  return light.name || light.device || key;
}

function autoPlaceDevices(allLights, boundary, mode) {
  const devices = {};
  const n = allLights.length;
  if (n === 0) return devices;

  if (mode === "linear") {
    // Ensure enough length so pills (120px ~= 6 grid units at gs=20) don't overlap
    const minLen = n * 7 + 4;
    const len = Math.max(boundary.length || 30, minLen);
    const pad = 4;
    const usable = len - 2 * pad;
    const spacing = n > 1 ? usable / (n - 1) : 0;
    allLights.forEach((light, i) => {
      const key = light.type === "hue" ? `hue:${light.id}` : `govee:${light.ip}`;
      devices[key] = { x: Math.round(pad + i * spacing), y: 0 };
    });
  } else {
    const w = boundary.width || 20;
    const h = boundary.height || 16;
    // Place on a grid with spacing to avoid pill overlap (pills are ~120px = 6 grid units wide)
    const pad = 3;
    const usableW = w - 2 * pad;
    const usableH = h - 2 * pad;
    const minSpacing = 7;
    const cols = Math.max(1, Math.floor(usableW / minSpacing) + 1);
    const rows = Math.max(1, Math.floor(usableH / minSpacing) + 1);
    // Generate candidate positions across the grid
    const candidates = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        candidates.push({
          x: pad + Math.round(c * (usableW / Math.max(1, cols - 1)) || 0),
          y: pad + Math.round(r * (usableH / Math.max(1, rows - 1)) || 0),
        });
      }
    }
    // Shuffle candidates for random-looking placement
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    // Assign devices to shuffled candidate positions
    allLights.forEach((light, i) => {
      const key = light.type === "hue" ? `hue:${light.id}` : `govee:${light.ip}`;
      const pos = candidates[i % candidates.length];
      devices[key] = { x: pos.x, y: pos.y };
    });
  }
  return devices;
}

function autoPlaceSegments(devicePos, count, occupied) {
  const positions = {};
  let placed = 0;
  for (let ring = 1; placed < count; ring++) {
    for (let dx = -ring; dx <= ring && placed < count; dx++) {
      for (let dy = -ring; dy <= ring && placed < count; dy++) {
        if (Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
        const pos = { x: devicePos.x + dx, y: devicePos.y + dy };
        const k = `${pos.x},${pos.y}`;
        if (!occupied.has(k)) {
          positions[String(placed)] = pos;
          occupied.add(k);
          placed++;
        }
      }
    }
  }
  return positions;
}

function wrapText(text, maxCharsPerLine) {
  const words = text.split(/\s+/);
  const lines = [];
  let current = "";
  for (const word of words) {
    if (current && (current.length + 1 + word.length) > maxCharsPerLine) {
      lines.push(current);
      current = word;
    } else {
      current = current ? current + " " + word : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function DeviceNode({ deviceKey, pos, gridSize, light, nicknames, isEdit, isSelected, onSelect, onDragEnd, segmentInfo, segments, onToggleSegments, colorOverride }) {
  const [dragging, setDragging] = useState(false);
  const [dragPos, setDragPos] = useState(null);
  const dragPosRef = useRef(null);
  const didDragRef = useRef(false);
  const svgRef = useRef(null);
  const color = colorOverride ? `rgb(${colorOverride.r},${colorOverride.g},${colorOverride.b})` : getDeviceColor(light);
  const label = getDeviceLabel(light, nicknames);
  const lines = wrapText(label, 14);
  const cx = pos.x * gridSize;
  const cy = pos.y * gridSize;
  const dotR = 10;

  // Pill dimensions
  const pillW = 120;
  const lineHeight = 13;
  const pillH = Math.max(28, 10 + lines.length * lineHeight);
  const pillX = cx - pillW / 2;
  const pillY = cy - pillH / 2;

  // Segment capability
  const sku = light.sku;
  const segInfo = sku && segmentInfo?.sku_table?.[sku];
  const configuredCount = light.ip && segmentInfo?.configured_counts?.[light.ip];
  const segCount = configuredCount || segInfo?.count;
  const isExpanded = segments?.expanded;
  const canExpand = segCount > 0 && isEdit;

  const startDrag = (e) => {
    if (!isEdit) return;
    e.preventDefault();
    e.stopPropagation();
    didDragRef.current = false;
    setDragging(true);
    svgRef.current = e.currentTarget.closest("svg");
  };

  useEffect(() => {
    if (!dragging) return;
    const svg = svgRef.current;
    if (!svg) return;
    const onMove = (e) => {
      e.preventDefault();
      const pt = svg.createSVGPoint();
      const src = e.touches ? e.touches[0] : e;
      pt.x = src.clientX; pt.y = src.clientY;
      const svgP = pt.matrixTransform(svg.getScreenCTM().inverse());
      const newPos = { x: Math.round(svgP.x / gridSize), y: Math.round(svgP.y / gridSize) };
      dragPosRef.current = newPos;
      didDragRef.current = true;
      setDragPos(newPos);
    };
    const onUp = () => {
      const finalPos = dragPosRef.current;
      setDragging(false);
      setDragPos(null);
      dragPosRef.current = null;
      if (finalPos && onDragEnd) onDragEnd(deviceKey, finalPos);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onUp);
    };
  }, [dragging, deviceKey, gridSize, onDragEnd]);

  if (isExpanded && !isEdit) return null;

  const displayX = dragging && dragPos ? dragPos.x * gridSize : cx;
  const displayY = dragging && dragPos ? dragPos.y * gridSize : cy;
  const dpillX = displayX - pillW / 2;
  const dpillY = displayY - pillH / 2;
  const isOn = light.state?.on || !!colorOverride;
  const transition = dragging ? "none" : "transform 0.15s, opacity 0.3s";

  return (
    <g style={{ cursor: isEdit ? "grab" : "pointer", transition, userSelect: "none", WebkitUserSelect: "none" }}
      transform={`translate(${displayX - cx},${displayY - cy})`}
      onMouseDown={startDrag} onTouchStart={startDrag}
      onDragStart={(e) => e.preventDefault()}
      onClick={(e) => { e.stopPropagation(); if (!didDragRef.current) onSelect(deviceKey); }}
    >
      {/* Pill background */}
      <rect x={pillX} y={pillY} width={pillW} height={pillH} rx={pillH / 2}
        fill={isOn ? "rgba(30,41,59,0.92)" : "rgba(15,23,42,0.85)"}
        stroke={isSelected ? "#a5b4fc" : isOn ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.06)"}
        strokeWidth={isSelected ? 2 : 1}
        style={{ filter: isOn ? `drop-shadow(0 0 6px ${color}40)` : "none" }}
      />
      {/* Color dot on the left side of the pill */}
      <circle cx={pillX + 16} cy={cy} r={dotR}
        fill={color}
        opacity={isOn ? 1 : 0.35}
        stroke={isOn ? "rgba(255,255,255,0.3)" : "rgba(255,255,255,0.1)"}
        strokeWidth={1.5}
        style={{ filter: isOn ? `drop-shadow(0 0 4px ${color})` : "none" }}
      />
      {/* Off indicator on dot */}
      {!isOn && (
        <text x={pillX + 16} y={cy + 4} textAnchor="middle"
          fill="#94a3b8" fontSize={8} fontFamily="sans-serif" fontWeight="bold" pointerEvents="none"
        >OFF</text>
      )}
      {/* Multi-line label text */}
      {lines.map((line, i) => (
        <text key={i} x={pillX + 30} y={pillY + 12 + i * lineHeight}
          fill={isOn ? "#e2e8f0" : "#64748b"} fontSize={10} fontFamily="sans-serif"
          fontWeight={i === 0 ? "600" : "400"} pointerEvents="none"
          dominantBaseline="middle"
        >{line}</text>
      ))}
      {/* Segment expand badge (edit mode) */}
      {canExpand && (
        <g onClick={(e) => { e.stopPropagation(); onToggleSegments(deviceKey); }} style={{ cursor: "pointer" }}>
          <circle cx={pillX + pillW - 4} cy={pillY + 4} r={8} fill="#334155" stroke="#64748b" strokeWidth={1} />
          <text x={pillX + pillW - 4} y={pillY + 8} textAnchor="middle"
            fill="#a5b4fc" fontSize={9} fontFamily="sans-serif" fontWeight="bold" pointerEvents="none"
          >{isExpanded ? "-" : String(segCount)}</text>
        </g>
      )}
    </g>
  );
}

function SegmentNode({ deviceKey, segIndex, pos, gridSize, light, isEdit, isSelected, onSelect, onDragEnd }) {
  const [dragging, setDragging] = useState(false);
  const [dragPos, setDragPos] = useState(null);
  const dragPosRef = useRef(null);
  const didDragRef = useRef(false);
  const svgRef = useRef(null);
  const color = getDeviceColor(light);
  const cx = pos.x * gridSize;
  const cy = pos.y * gridSize;
  const r = 12;

  const startDrag = (e) => {
    if (!isEdit) return;
    e.stopPropagation();
    didDragRef.current = false;
    setDragging(true);
    svgRef.current = e.currentTarget.closest("svg");
  };

  useEffect(() => {
    if (!dragging) return;
    const svg = svgRef.current;
    if (!svg) return;
    const onMove = (e) => {
      const pt = svg.createSVGPoint();
      const src = e.touches ? e.touches[0] : e;
      pt.x = src.clientX; pt.y = src.clientY;
      const svgP = pt.matrixTransform(svg.getScreenCTM().inverse());
      const newPos = { x: Math.round(svgP.x / gridSize), y: Math.round(svgP.y / gridSize) };
      dragPosRef.current = newPos;
      didDragRef.current = true;
      setDragPos(newPos);
    };
    const onUp = () => {
      const finalPos = dragPosRef.current;
      setDragging(false);
      setDragPos(null);
      dragPosRef.current = null;
      if (finalPos && onDragEnd) onDragEnd(deviceKey, segIndex, finalPos);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onUp);
    };
  }, [dragging, deviceKey, segIndex, gridSize, onDragEnd]);

  const displayX = dragging && dragPos ? dragPos.x * gridSize : cx;
  const displayY = dragging && dragPos ? dragPos.y * gridSize : cy;
  const isOn = light.state?.on;
  const transition = dragging ? "none" : "cx 0.15s, cy 0.15s, opacity 0.3s";

  return (
    <g style={{ cursor: isEdit ? "grab" : "pointer" }}
      onMouseDown={startDrag} onTouchStart={startDrag}
      onClick={(e) => { e.stopPropagation(); if (!didDragRef.current) onSelect(deviceKey, segIndex); }}
    >
      {/* Segment circle — always shows device color */}
      <circle cx={displayX} cy={displayY} r={r}
        fill={color}
        opacity={isOn ? 1 : 0.3}
        stroke={isSelected ? "#fff" : isOn ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.1)"}
        strokeWidth={isSelected ? 2.5 : 1}
        strokeDasharray={isOn ? "none" : "3,2"}
        style={{ transition, filter: isOn ? `drop-shadow(0 0 4px ${color})` : "none" }}
      />
      {/* Off: small color preview pip */}
      {!isOn && (
        <circle cx={displayX} cy={displayY} r={3.5}
          fill={color} opacity={0.85}
          stroke="rgba(0,0,0,0.4)" strokeWidth={0.5}
          style={{ transition }} />
      )}
      {/* Segment index label */}
      <text x={displayX} y={displayY + 4} textAnchor="middle"
        fill={isOn ? "#fff" : "#94a3b8"} fontSize={9} fontFamily="sans-serif" fontWeight="bold" pointerEvents="none"
      >{segIndex + 1}</text>
    </g>
  );
}

function RoomMap({ roomName, hueLights, goveeDevices, onControlHue, onControlGovee, favorites, onFavoritesChange, nicknames, onNicknameChange, segmentInfo, roomLayouts, onLayoutChange }) {
  const [layout, setLayout] = useState(null);
  const [isEdit, setIsEdit] = useState(false);
  const [selectedDevice, setSelectedDevice] = useState(null);
  const [placingDevice, setPlacingDevice] = useState(null);
  // Tonal mode
  const [tonalActive, setTonalActive] = useState(false);
  const [tonalBase, setTonalBase] = useState({ r: 40, g: 180, b: 80 });
  const [tonalMode, setTonalMode] = useState("random"); // "random" or "gradient"
  const [tonalPreview, setTonalPreview] = useState(null); // {deviceKey: {r,g,b}, ...}
  const [gradientStart, setGradientStart] = useState(null); // {x, y} SVG coords
  const [gradientEnd, setGradientEnd] = useState(null); // {x, y} SVG coords
  const [draggingGradient, setDraggingGradient] = useState(null); // "start"|"end"|"drawing"|null
  const gradientSvgRef = useRef(null);
  // Furniture / landmarks
  const [selectedFurniture, setSelectedFurniture] = useState(null);
  const [placingFurniture, setPlacingFurniture] = useState(null); // furniture type string
  const [hoverGrid, setHoverGrid] = useState(null); // {x, y} grid pos for furniture ghost
  const [editingLandmark, setEditingLandmark] = useState(null); // index
  const [placingLandmark, setPlacingLandmark] = useState(false);
  // Scene presets
  const [presets, setPresets] = useState([]);
  const [presetName, setPresetName] = useState("");
  const [showPresetSave, setShowPresetSave] = useState(false);

  const allLights = [
    ...hueLights.map(l => ({ ...l, _controlFn: onControlHue })),
    ...goveeDevices.map(d => ({ ...d, _controlFn: onControlGovee })),
  ];

  const lightMap = {};
  allLights.forEach(l => {
    const key = l.type === "hue" ? `hue:${l.id}` : `govee:${l.ip}`;
    lightMap[key] = l;
  });

  // Initialize layout
  useEffect(() => {
    const existing = roomLayouts?.[roomName];
    if (existing) {
      setLayout(existing);
    } else {
      const mode = "2d";
      const count = allLights.length;
      // Default to a generous room size so icons don't crowd each other
      const cols = Math.max(16, Math.ceil(Math.sqrt(count)) * 4 + 4);
      const rows = Math.max(12, Math.ceil(Math.sqrt(count)) * 3 + 4);
      const boundary = { type: "rectangle", width: cols, height: rows };
      const devices = autoPlaceDevices(allLights, boundary, mode);
      const newLayout = { grid_size: 40, mode, boundary, devices, segments: {}, furniture: [], landmarks: [] };
      setLayout(newLayout);
      // Auto-save the initial layout
      saveLayout(newLayout);
    }
  }, [roomName]);


  // Auto-save: debounce layout changes to backend
  const saveTimerRef = useRef(null);
  const saveLayout = useCallback(async (layoutToSave) => {
    if (!layoutToSave) return;
    try {
      await api("/room-layouts", {
        method: "POST",
        body: JSON.stringify({ room_name: roomName, ...layoutToSave }),
      });
      if (onLayoutChange) onLayoutChange(roomName, layoutToSave);
    } catch (e) {
      console.error("Failed to save layout:", e);
    }
  }, [roomName, onLayoutChange]);

  const updateLayout = (updater) => {
    setLayout(prev => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      // Debounced auto-save
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => saveLayout(next), 600);
      return next;
    });
  };

  // ─── Furniture / landmark logic ────────────────────────────────────────
  const addFurniture = (type, x, y) => {
    const def = FURNITURE_TYPES[type] || FURNITURE_TYPES.label;
    const item = { id: nextFurnitureId(), type, label: def.label, x, y, w: def.w, h: def.h, rotation: 0 };
    updateLayout(prev => ({
      ...prev,
      furniture: [...(prev.furniture || []), item],
    }));
  };

  const moveFurniture = (id, pos) => {
    updateLayout(prev => ({
      ...prev,
      furniture: (prev.furniture || []).map(f => f.id === id ? { ...f, x: pos.x, y: pos.y } : f),
    }));
  };

  const rotateFurniture = (id) => {
    updateLayout(prev => ({
      ...prev,
      furniture: (prev.furniture || []).map(f => f.id === id ? { ...f, rotation: ((f.rotation || 0) + 90) % 360 } : f),
    }));
  };

  const resizeFurniture = (id, size) => {
    updateLayout(prev => ({
      ...prev,
      furniture: (prev.furniture || []).map(f => f.id === id ? { ...f, w: size.w, h: size.h } : f),
    }));
  };

  const deleteFurniture = (id) => {
    updateLayout(prev => ({
      ...prev,
      furniture: (prev.furniture || []).filter(f => f.id !== id),
    }));
    setSelectedFurniture(null);
  };

  const renameFurniture = (id, newLabel) => {
    updateLayout(prev => ({
      ...prev,
      furniture: (prev.furniture || []).map(f => f.id === id ? { ...f, label: newLabel } : f),
    }));
  };

  const addLandmark = (x, label) => {
    updateLayout(prev => ({
      ...prev,
      landmarks: [...(prev.landmarks || []), { x, label }],
    }));
  };

  const moveLandmark = (index, newX) => {
    updateLayout(prev => ({
      ...prev,
      landmarks: (prev.landmarks || []).map((lm, i) => i === index ? { ...lm, x: newX } : lm),
    }));
  };

  const deleteLandmark = (index) => {
    updateLayout(prev => ({
      ...prev,
      landmarks: (prev.landmarks || []).filter((_, i) => i !== index),
    }));
    setEditingLandmark(null);
  };

  const renameLandmark = (index, newLabel) => {
    updateLayout(prev => ({
      ...prev,
      landmarks: (prev.landmarks || []).map((lm, i) => i === index ? { ...lm, label: newLabel } : lm),
    }));
  };

  // ─── Tonal mode logic ──────────────────────────────────────────────────
  const computeTonalPreview = useCallback((base, mode, gStart, gEnd) => {
    if (!layout) return null;
    const placedEntries = Object.entries(layout.devices)
      .filter(([k]) => lightMap[k]?.capabilities?.has_color);
    if (placedEntries.length === 0) return null;
    const count = placedEntries.length;
    const shades = generateTonalShades(base.r, base.g, base.b, count);

    if (mode === "gradient" && gStart && gEnd) {
      // Project each device position onto the gradient vector
      const dx = gEnd.x - gStart.x;
      const dy = gEnd.y - gStart.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 0.001) return null;
      const sorted = placedEntries.map(([key, pos]) => {
        const px = pos.x - gStart.x;
        const py = pos.y - gStart.y;
        const proj = (px * dx + py * dy) / (len * len);
        return { key, proj };
      }).sort((a, b) => a.proj - b.proj);
      const preview = {};
      sorted.forEach((item, i) => { preview[item.key] = shades[i]; });
      return preview;
    } else {
      // Random: shuffle shades
      const shuffled = [...shades];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const preview = {};
      placedEntries.forEach(([key], i) => { preview[key] = shuffled[i]; });
      return preview;
    }
  }, [layout, lightMap]);

  const refreshTonalPreview = useCallback(() => {
    const preview = computeTonalPreview(tonalBase, tonalMode, gradientStart, gradientEnd);
    setTonalPreview(preview);
  }, [tonalBase, tonalMode, gradientStart, gradientEnd, computeTonalPreview]);

  // Update preview when gradient endpoints or base color change
  useEffect(() => {
    if (tonalActive && tonalMode === "gradient" && gradientStart && gradientEnd) {
      const preview = computeTonalPreview(tonalBase, "gradient", gradientStart, gradientEnd);
      setTonalPreview(preview);
    }
  }, [gradientStart, gradientEnd, tonalBase, tonalActive]);

  // Gradient handle dragging
  const currentGridSize = layout?.grid_size || 40;
  useEffect(() => {
    if (!draggingGradient) return;
    const svg = gradientSvgRef.current;
    if (!svg) return;
    const gs = currentGridSize;
    const onMove = (e) => {
      const pt = svg.createSVGPoint();
      const src = e.touches ? e.touches[0] : e;
      pt.x = src.clientX; pt.y = src.clientY;
      const svgP = pt.matrixTransform(svg.getScreenCTM().inverse());
      const pos = { x: svgP.x / gs, y: svgP.y / gs };
      if (draggingGradient === "start") setGradientStart(pos);
      else if (draggingGradient === "end") setGradientEnd(pos);
    };
    const onUp = () => setDraggingGradient(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onUp);
    };
  }, [draggingGradient, currentGridSize]);

  const applyTonalColors = () => {
    if (!tonalPreview) return;
    Object.entries(tonalPreview).forEach(([key, color]) => {
      const light = lightMap[key];
      if (light && light._controlFn) {
        light._controlFn(light, { on: true, r: color.r, g: color.g, b: color.b });
      }
    });
  };

  // ─── Scene preset logic ────────────────────────────────────────────────
  // Load presets from config on mount
  useEffect(() => {
    api("/room-presets/" + encodeURIComponent(roomName))
      .then(data => setPresets(data.presets || []))
      .catch(() => setPresets([]));
  }, [roomName]);

  const captureCurrentState = () => {
    const snapshot = {};
    allLights.forEach(light => {
      const key = light.type === "hue" ? `hue:${light.id}` : `govee:${light.ip}`;
      snapshot[key] = {
        on: light.state?.on || false,
        brightness: light.state?.brightness || 0,
        color: light.state?.color || getInitialColor(light) || null,
      };
    });
    return snapshot;
  };

  const savePreset = async (name) => {
    const snapshot = captureCurrentState();
    const newPreset = { name, snapshot, created: Date.now() };
    const updated = [...presets, newPreset];
    setPresets(updated);
    try {
      await api("/room-presets", {
        method: "POST",
        body: JSON.stringify({ room_name: roomName, presets: updated }),
      });
    } catch (e) {
      console.error("Failed to save preset:", e);
    }
  };

  const applyPreset = (preset) => {
    Object.entries(preset.snapshot).forEach(([key, state]) => {
      const light = lightMap[key];
      if (!light) return;
      const cmd = {};
      if (state.on !== undefined) cmd.on = state.on;
      if (state.brightness !== undefined) {
        cmd.brightness = state.brightness;
      }
      if (state.color) {
        cmd.r = state.color.r;
        cmd.g = state.color.g;
        cmd.b = state.color.b;
      }
      light._controlFn(light, cmd);
    });
  };

  const deletePreset = async (index) => {
    const updated = presets.filter((_, i) => i !== index);
    setPresets(updated);
    try {
      await api("/room-presets", {
        method: "POST",
        body: JSON.stringify({ room_name: roomName, presets: updated }),
      });
    } catch (e) {
      console.error("Failed to delete preset:", e);
    }
  };

  if (!layout) return null;

  const { grid_size: gridSize, mode, boundary, devices, segments } = layout;
  const isLinear = mode === "linear";
  const bw = isLinear ? (boundary.length || 20) : (boundary.width || 12);
  const bh = isLinear ? 3 : (boundary.height || 10);
  const svgW = (bw + 1) * gridSize;
  const svgH = (bh + 1) * gridSize;

  // Placed & unplaced device keys
  const placedKeys = new Set(Object.keys(devices));
  const allKeys = allLights.map(l => l.type === "hue" ? `hue:${l.id}` : `govee:${l.ip}`);
  const unplacedKeys = allKeys.filter(k => !placedKeys.has(k));

  // Handle grid click (for placing devices)
  const svgCoordsFromEvent = (e) => {
    const svg = e.currentTarget.closest ? e.currentTarget.closest("svg") || e.currentTarget : e.currentTarget;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  };

  const handleSvgClick = (e) => {
    const svgP = svgCoordsFromEvent(e);
    const gx = Math.round(svgP.x / gridSize);
    const gy = isLinear ? 0 : Math.round(svgP.y / gridSize);
    if (placingDevice) {
      updateLayout(prev => ({
        ...prev,
        devices: { ...prev.devices, [placingDevice]: { x: gx, y: gy } },
      }));
      setPlacingDevice(null);
    } else if (placingFurniture) {
      addFurniture(placingFurniture, gx, gy);
      setPlacingFurniture(null);
      setHoverGrid(null);
    } else if (placingLandmark) {
      const label = prompt("Landmark label:");
      if (label && label.trim()) {
        addLandmark(gx, label.trim());
      }
      setPlacingLandmark(false);
    } else if (tonalActive && tonalMode === "gradient") {
      const gxf = svgP.x / gridSize;
      const gyf = svgP.y / gridSize;
      if (!gradientStart || (gradientStart && gradientEnd)) {
        setGradientStart({ x: gxf, y: gyf });
        setGradientEnd(null);
        setTonalPreview(null);
      } else if (!gradientEnd) {
        setGradientEnd({ x: gxf, y: gyf });
      }
    } else {
      setSelectedDevice(null);
      setSelectedFurniture(null);
    }
  };

  const handleDragEnd = (deviceKey, newPos) => {
    const finalPos = isLinear ? { x: newPos.x, y: 0 } : newPos;
    updateLayout(prev => ({
      ...prev,
      devices: { ...prev.devices, [deviceKey]: finalPos },
    }));
  };

  const handleSegDragEnd = (deviceKey, segIndex, newPos) => {
    const finalPos = isLinear ? { x: newPos.x, y: 0 } : newPos;
    updateLayout(prev => ({
      ...prev,
      segments: {
        ...prev.segments,
        [deviceKey]: {
          ...prev.segments[deviceKey],
          positions: { ...prev.segments[deviceKey].positions, [String(segIndex)]: finalPos },
        },
      },
    }));
  };

  const handleToggleSegments = (deviceKey) => {
    updateLayout(prev => {
      const seg = prev.segments[deviceKey];
      if (seg?.expanded) {
        return { ...prev, segments: { ...prev.segments, [deviceKey]: { ...seg, expanded: false } } };
      }
      // Expand: auto-place segments
      const light = lightMap[deviceKey];
      const sku = light?.sku;
      const segInfo = sku && segmentInfo?.sku_table?.[sku];
      const configuredCount = light?.ip && segmentInfo?.configured_counts?.[light.ip];
      const count = configuredCount || segInfo?.count || 0;
      if (count === 0) return prev;
      const devicePos = prev.devices[deviceKey];
      if (!devicePos) return prev;
      const occupied = new Set();
      Object.values(prev.devices).forEach(p => occupied.add(`${p.x},${p.y}`));
      Object.values(prev.segments).forEach(s => {
        if (s.expanded && s.positions) Object.values(s.positions).forEach(p => occupied.add(`${p.x},${p.y}`));
      });
      const positions = seg?.positions || autoPlaceSegments(devicePos, count, occupied);
      return { ...prev, segments: { ...prev.segments, [deviceKey]: { expanded: true, positions } } };
    });
  };

  const removeDevice = (deviceKey) => {
    updateLayout(prev => {
      const newDevices = { ...prev.devices };
      delete newDevices[deviceKey];
      const newSegments = { ...prev.segments };
      delete newSegments[deviceKey];
      return { ...prev, devices: newDevices, segments: newSegments };
    });
    setSelectedDevice(null);
  };

  const toggleMode = () => {
    updateLayout(prev => {
      const newMode = prev.mode === "linear" ? "2d" : "linear";
      // Save current mode's state before switching
      const savedKey = prev.mode === "linear" ? "saved_linear" : "saved_2d";
      const saved = { ...prev, [savedKey]: undefined }; // current state to save
      const restoreKey = newMode === "linear" ? "saved_linear" : "saved_2d";
      const restored = prev[restoreKey];

      if (restored) {
        // Restore previously saved layout for this mode
        return { ...restored, mode: newMode, [savedKey]: { boundary: prev.boundary, devices: prev.devices, segments: prev.segments, furniture: prev.furniture, landmarks: prev.landmarks }, [restoreKey]: restored[restoreKey] };
      }

      // No saved state — create fresh layout for the new mode
      const deviceCount = Object.keys(prev.devices).length;
      const newBoundary = newMode === "linear"
        ? { type: "line", length: Math.max(30, deviceCount * 8) }
        : { type: "rectangle", width: Math.max(16, 20), height: Math.max(12, 16) };
      const newDevices = autoPlaceDevices(allLights, newBoundary, newMode);
      return {
        ...prev, mode: newMode, boundary: newBoundary, devices: newDevices,
        segments: {}, furniture: newMode === "2d" ? [] : prev.furniture, landmarks: newMode === "linear" ? [] : prev.landmarks,
        [savedKey]: { boundary: prev.boundary, devices: prev.devices, segments: prev.segments, furniture: prev.furniture, landmarks: prev.landmarks },
      };
    });
  };

  // Resize handlers — clamp devices to stay within new boundary
  const adjustSize = (dim, delta) => {
    updateLayout(prev => {
      if (prev.mode === "linear") {
        const newLen = Math.max(10, (prev.boundary.length || 30) + delta);
        const clampedDevices = {};
        Object.entries(prev.devices).forEach(([k, p]) => {
          clampedDevices[k] = { x: Math.min(p.x, newLen - 1), y: 0 };
        });
        return { ...prev, boundary: { ...prev.boundary, length: newLen }, devices: clampedDevices };
      }
      const newBoundary = { ...prev.boundary };
      if (dim === "w") newBoundary.width = Math.max(8, (newBoundary.width || 16) + delta);
      if (dim === "h") newBoundary.height = Math.max(6, (newBoundary.height || 12) + delta);
      const maxX = newBoundary.width - 1;
      const maxY = newBoundary.height - 1;
      const clampedDevices = {};
      Object.entries(prev.devices).forEach(([k, p]) => {
        clampedDevices[k] = { x: Math.min(p.x, maxX), y: Math.min(p.y, maxY) };
      });
      // Also clamp segments
      const clampedSegments = {};
      Object.entries(prev.segments || {}).forEach(([dk, seg]) => {
        if (seg.positions) {
          const newPositions = {};
          Object.entries(seg.positions).forEach(([si, sp]) => {
            newPositions[si] = { x: Math.min(sp.x, maxX), y: Math.min(sp.y, maxY) };
          });
          clampedSegments[dk] = { ...seg, positions: newPositions };
        } else {
          clampedSegments[dk] = seg;
        }
      });
      return { ...prev, boundary: newBoundary, devices: clampedDevices, segments: clampedSegments };
    });
  };

  // Selected device light object
  const selectedLight = selectedDevice ? lightMap[selectedDevice] : null;
  const selectedColor = selectedLight ? getInitialColor(selectedLight) : null;

  return (
    <div style={{ marginBottom: 16 }}>
      {/* Toolbar */}
      <div style={{
        display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 12,
      }}>
        <button onClick={() => { setIsEdit(!isEdit); setPlacingDevice(null); setSelectedDevice(null); }}
          style={{
            padding: "5px 14px", borderRadius: 8, border: "1px solid #334155",
            background: isEdit ? "rgba(99,102,241,0.15)" : "transparent",
            color: isEdit ? "#a5b4fc" : "#94a3b8", fontSize: 12, fontWeight: 600, cursor: "pointer",
          }}
        >{isEdit ? "Done Editing" : "Edit Layout"}</button>

        <button onClick={toggleMode}
          style={{
            padding: "5px 14px", borderRadius: 8, border: "1px solid #334155",
            background: "transparent", color: "#94a3b8", fontSize: 12, fontWeight: 600, cursor: "pointer",
          }}
        >{isLinear ? "Floor Plan" : "Line"}</button>

        {!isEdit && (
          <button onClick={() => { setTonalActive(!tonalActive); if (tonalActive) { setTonalPreview(null); setGradientStart(null); setGradientEnd(null); } }}
            style={{
              padding: "5px 14px", borderRadius: 8, border: "1px solid #334155",
              background: tonalActive ? "rgba(52,211,153,0.15)" : "transparent",
              color: tonalActive ? "#34d399" : "#94a3b8", fontSize: 12, fontWeight: 600, cursor: "pointer",
            }}
          >Tonal</button>
        )}

        {isEdit && (
          <>
            <button onClick={() => adjustSize("w", 2)} style={{ padding: "5px 10px", borderRadius: 8, border: "1px solid #334155", background: "transparent", color: "#94a3b8", fontSize: 11, cursor: "pointer" }}>W+</button>
            <button onClick={() => adjustSize("w", -2)} style={{ padding: "5px 10px", borderRadius: 8, border: "1px solid #334155", background: "transparent", color: "#94a3b8", fontSize: 11, cursor: "pointer" }}>W-</button>
            {!isLinear && (
              <>
                <button onClick={() => adjustSize("h", 2)} style={{ padding: "5px 10px", borderRadius: 8, border: "1px solid #334155", background: "transparent", color: "#94a3b8", fontSize: 11, cursor: "pointer" }}>H+</button>
                <button onClick={() => adjustSize("h", -2)} style={{ padding: "5px 10px", borderRadius: 8, border: "1px solid #334155", background: "transparent", color: "#94a3b8", fontSize: 11, cursor: "pointer" }}>H-</button>
              </>
            )}
            <span style={{ fontSize: 11, color: "#64748b", marginLeft: 4 }}>Grid:</span>
            <input type="range" min={20} max={80} step={5} value={gridSize}
              onChange={(e) => updateLayout(prev => ({ ...prev, grid_size: parseInt(e.target.value) }))}
              style={{ width: 80, accentColor: "#6366f1" }}
            />
          </>
        )}

      </div>

      {/* Tonal mode panel */}
      {tonalActive && !isEdit && (
        <div style={{
          padding: 16, borderRadius: 12, marginBottom: 12,
          background: "linear-gradient(135deg, #1e293b 0%, #172033 100%)",
          border: "1px solid #334155",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#34d399", textTransform: "uppercase", letterSpacing: 0.8 }}>
              Tonal Shades
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={() => { setTonalMode("random"); }}
                style={{
                  padding: "4px 12px", borderRadius: 6, border: "1px solid #334155",
                  background: tonalMode === "random" ? "rgba(52,211,153,0.15)" : "transparent",
                  color: tonalMode === "random" ? "#34d399" : "#64748b", fontSize: 11, fontWeight: 600, cursor: "pointer",
                }}>Random</button>
              <button onClick={() => { setTonalMode("gradient"); }}
                style={{
                  padding: "4px 12px", borderRadius: 6, border: "1px solid #334155",
                  background: tonalMode === "gradient" ? "rgba(52,211,153,0.15)" : "transparent",
                  color: tonalMode === "gradient" ? "#34d399" : "#64748b", fontSize: 11, fontWeight: 600, cursor: "pointer",
                }}>Gradient</button>
            </div>
          </div>

          {/* Base color picker */}
          <div style={{ marginBottom: 12 }}>
            <ColorPicker
              size={120}
              currentColor={tonalBase}
              onColorSelect={(r, g, b) => setTonalBase({ r, g, b })}
              favorites={favorites}
              onFavoritesChange={onFavoritesChange}
              compact={true}
            />
          </div>

          {/* Gradient mode instructions */}
          {tonalMode === "gradient" && !gradientStart && (
            <div style={{ fontSize: 11, color: "#64748b", marginBottom: 8 }}>
              Click two points on the map to set the gradient direction (dark to light).
            </div>
          )}
          {tonalMode === "gradient" && gradientStart && gradientEnd && (
            <div style={{ fontSize: 11, color: "#64748b", marginBottom: 8 }}>
              Gradient set. Drag the endpoints on the map to adjust.
            </div>
          )}

          {/* Preview swatches */}
          {tonalPreview && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: "#64748b", marginBottom: 4 }}>Preview:</div>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {Object.entries(tonalPreview).map(([key, c]) => (
                  <div key={key} style={{
                    width: 20, height: 20, borderRadius: 4,
                    background: `rgb(${c.r},${c.g},${c.b})`,
                    border: "1px solid rgba(255,255,255,0.15)",
                  }} title={getDeviceLabel(lightMap[key], nicknames)} />
                ))}
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => { refreshTonalPreview(); }}
              style={{
                padding: "6px 16px", borderRadius: 8, border: "1px solid #334155",
                background: "transparent", color: "#94a3b8", fontSize: 12, fontWeight: 600, cursor: "pointer",
              }}>{tonalMode === "random" ? "Shuffle" : "Preview"}</button>
            <button onClick={() => { applyTonalColors(); }}
              disabled={!tonalPreview}
              style={{
                padding: "6px 16px", borderRadius: 8, border: "none",
                background: tonalPreview ? "#34d399" : "#334155",
                color: tonalPreview ? "#0f172a" : "#64748b",
                fontSize: 12, fontWeight: 600, cursor: tonalPreview ? "pointer" : "default",
              }}>Apply</button>
          </div>
        </div>
      )}

      {/* Scene presets */}
      {!isEdit && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginBottom: 10 }}>
          {presets.map((preset, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 0 }}>
              <button onClick={() => applyPreset(preset)}
                style={{
                  padding: "5px 12px", borderRadius: "8px 0 0 8px", border: "1px solid #334155",
                  background: "#1e293b", color: "#e2e8f0", fontSize: 11, fontWeight: 600, cursor: "pointer",
                }}
                title={`Apply "${preset.name}"`}
              >
                {/* Mini color swatches */}
                <span style={{ display: "inline-flex", gap: 2, marginRight: 6, verticalAlign: "middle" }}>
                  {Object.values(preset.snapshot).slice(0, 5).map((s, j) => (
                    <span key={j} style={{
                      width: 8, height: 8, borderRadius: 2, display: "inline-block",
                      background: s.color ? `rgb(${s.color.r},${s.color.g},${s.color.b})` : "#475569",
                      opacity: s.on ? 1 : 0.3,
                    }} />
                  ))}
                </span>
                {preset.name}
              </button>
              <button onClick={() => deletePreset(i)}
                style={{
                  padding: "5px 8px", borderRadius: "0 8px 8px 0", border: "1px solid #334155", borderLeft: "none",
                  background: "#1e293b", color: "#64748b", fontSize: 11, cursor: "pointer",
                }}
                title="Delete preset"
              >&times;</button>
            </div>
          ))}
          {showPresetSave ? (
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <input
                type="text" value={presetName} onChange={(e) => setPresetName(e.target.value)}
                placeholder="Preset name..."
                autoFocus
                onKeyDown={(e) => { if (e.key === "Enter" && presetName.trim()) { savePreset(presetName.trim()); setPresetName(""); setShowPresetSave(false); } if (e.key === "Escape") setShowPresetSave(false); }}
                style={{
                  padding: "4px 10px", borderRadius: 6, border: "1px solid #334155",
                  background: "#0f172a", color: "#e2e8f0", fontSize: 11, width: 120, outline: "none",
                }}
              />
              <button onClick={() => { if (presetName.trim()) { savePreset(presetName.trim()); setPresetName(""); setShowPresetSave(false); } }}
                style={{
                  padding: "4px 10px", borderRadius: 6, border: "none",
                  background: "#6366f1", color: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer",
                }}>Save</button>
              <button onClick={() => setShowPresetSave(false)}
                style={{
                  padding: "4px 8px", borderRadius: 6, border: "1px solid #334155",
                  background: "transparent", color: "#64748b", fontSize: 11, cursor: "pointer",
                }}>&times;</button>
            </div>
          ) : (
            <button onClick={() => setShowPresetSave(true)}
              style={{
                padding: "5px 12px", borderRadius: 8, border: "1px dashed #334155",
                background: "transparent", color: "#64748b", fontSize: 11, cursor: "pointer",
              }}>+ Save Scene</button>
          )}
        </div>
      )}

      {/* Placing indicator */}
      {placingDevice && (
        <div style={{
          padding: "8px 14px", borderRadius: 8, marginBottom: 8,
          background: "rgba(99,102,241,0.15)", border: "1px solid rgba(99,102,241,0.3)",
          color: "#a5b4fc", fontSize: 12,
        }}>
          Tap a grid position to place <strong>{getDeviceLabel(lightMap[placingDevice], nicknames)}</strong>
          <button onClick={() => setPlacingDevice(null)} style={{
            marginLeft: 12, padding: "2px 8px", borderRadius: 6, border: "1px solid #6366f1",
            background: "transparent", color: "#a5b4fc", fontSize: 11, cursor: "pointer",
          }}>Cancel</button>
        </div>
      )}

      {/* SVG Map */}
      <div style={{ overflowX: "auto", borderRadius: 12, border: "1px solid #1e293b", background: "#0f172a" }}>
        <svg
          width={svgW} height={svgH}
          viewBox={`0 0 ${svgW} ${svgH}`}
          style={{ display: "block", touchAction: "none", minWidth: svgW, cursor: placingFurniture ? "crosshair" : undefined }}
          onClick={handleSvgClick}
          onMouseMove={(e) => {
            if (!placingFurniture) { setHoverGrid(null); return; }
            const svg = e.currentTarget;
            const pt = svg.createSVGPoint();
            pt.x = e.clientX; pt.y = e.clientY;
            const svgP = pt.matrixTransform(svg.getScreenCTM().inverse());
            setHoverGrid({ x: Math.round(svgP.x / gridSize - 0.5), y: Math.round(svgP.y / gridSize - 0.5) });
          }}
          onMouseLeave={() => setHoverGrid(null)}
        >
          {/* Room boundary */}
          {isLinear ? (
            <line x1={gridSize * 0.5} y1={gridSize * 1.5} x2={(bw + 0.5) * gridSize} y2={gridSize * 1.5}
              stroke="#334155" strokeWidth={2} strokeDasharray="6,4" />
          ) : (
            <rect x={gridSize * 0.5} y={gridSize * 0.5}
              width={bw * gridSize} height={bh * gridSize}
              fill="none" stroke="#334155" strokeWidth={2} strokeDasharray="6,4" rx={8}
            />
          )}

          {/* Grid dots */}
          {isLinear ? (
            Array.from({ length: bw + 1 }, (_, i) => (
              <circle key={`gd-${i}`} cx={(i + 0.5) * gridSize} cy={1.5 * gridSize} r={isEdit ? 2.5 : 1.5}
                fill={isEdit ? "#475569" : "#1e293b"} />
            ))
          ) : (
            Array.from({ length: bw + 1 }, (_, x) =>
              Array.from({ length: bh + 1 }, (_, y) => (
                <circle key={`gd-${x}-${y}`} cx={(x + 0.5) * gridSize} cy={(y + 0.5) * gridSize}
                  r={isEdit ? 2.5 : 1.5} fill={isEdit ? "#475569" : "#1e293b"} />
              ))
            )
          )}

          {/* Furniture items (2D mode) */}
          {!isLinear && (layout.furniture || []).map(item => (
            <FurnitureItem
              key={item.id} item={item} gridSize={gridSize}
              isEdit={isEdit} isSelected={selectedFurniture === item.id}
              onSelect={(id) => { setSelectedFurniture(id); setSelectedDevice(null); }}
              onDragEnd={moveFurniture}
              onRotate={rotateFurniture}
              onResize={resizeFurniture}
            />
          ))}

          {/* Landmarks (linear mode) */}
          {isLinear && (layout.landmarks || []).map((lm, i) => {
            const lx = (lm.x + 0.5) * gridSize;
            const above = i % 2 === 0;
            const ly = 1.5 * gridSize;
            return (
              <g key={`lm-${i}`}
                onClick={(e) => { e.stopPropagation(); if (isEdit) setEditingLandmark(i); }}
                style={{ cursor: isEdit ? "pointer" : "default" }}
              >
                <line x1={lx} y1={ly - 8} x2={lx} y2={ly + 8}
                  stroke="#64748b" strokeWidth={1.5} />
                <text x={lx} y={above ? ly - 14 : ly + 22}
                  textAnchor="middle" fill="#94a3b8"
                  fontSize={9} fontFamily="sans-serif" fontWeight="500"
                  style={{ pointerEvents: "none", userSelect: "none" }}
                >{lm.label}</text>
              </g>
            );
          })}

          {/* Device nodes */}
          {Object.entries(devices).map(([key, pos]) => {
            const light = lightMap[key];
            if (!light) return null;
            const displayPos = isLinear ? { x: pos.x, y: 1.5 } : { x: pos.x + 0.5, y: pos.y + 0.5 };
            const segData = segments[key];
            if (segData?.expanded) {
              // Render segment nodes instead
              return Object.entries(segData.positions || {}).map(([si, sp]) => {
                const segDisplayPos = isLinear ? { x: sp.x, y: 1.5 } : { x: sp.x + 0.5, y: sp.y + 0.5 };
                return (
                  <SegmentNode
                    key={`${key}-seg-${si}`}
                    deviceKey={key} segIndex={parseInt(si)}
                    pos={segDisplayPos} gridSize={gridSize}
                    light={light} isEdit={isEdit}
                    isSelected={selectedDevice === key}
                    onSelect={(dk) => setSelectedDevice(dk)}
                    onDragEnd={handleSegDragEnd}
                  />
                );
              });
            }
            return (
              <DeviceNode
                key={key} deviceKey={key}
                pos={displayPos} gridSize={gridSize}
                light={light} nicknames={nicknames}
                isEdit={isEdit} isSelected={selectedDevice === key}
                onSelect={(dk) => setSelectedDevice(dk)}
                onDragEnd={handleDragEnd}
                segmentInfo={segmentInfo}
                segments={segData}
                onToggleSegments={handleToggleSegments}
                colorOverride={tonalPreview?.[key]}
              />
            );
          })}

          {/* Gradient arrow overlay (tonal mode) */}
          {tonalActive && tonalMode === "gradient" && gradientStart && (
            <g>
              {gradientEnd && (
                <>
                  <defs>
                    <marker id="grad-arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                      <polygon points="0 0, 8 3, 0 6" fill="#34d399" />
                    </marker>
                  </defs>
                  <line
                    x1={gradientStart.x * gridSize} y1={gradientStart.y * gridSize}
                    x2={gradientEnd.x * gridSize} y2={gradientEnd.y * gridSize}
                    stroke="#34d399" strokeWidth={2} strokeDasharray="6,3" opacity={0.7}
                    markerEnd="url(#grad-arrow)"
                  />
                </>
              )}
              {/* Draggable start handle */}
              <circle cx={gradientStart.x * gridSize} cy={gradientStart.y * gridSize} r={8}
                fill="#1e293b" stroke="#34d399" strokeWidth={2} style={{ cursor: "grab" }}
                onMouseDown={(e) => { e.stopPropagation(); setDraggingGradient("start"); gradientSvgRef.current = e.currentTarget.closest("svg"); }}
                onTouchStart={(e) => { e.stopPropagation(); setDraggingGradient("start"); gradientSvgRef.current = e.currentTarget.closest("svg"); }}
              />
              <text x={gradientStart.x * gridSize} y={gradientStart.y * gridSize + 3.5} textAnchor="middle"
                fill="#34d399" fontSize={8} fontFamily="sans-serif" fontWeight="bold" pointerEvents="none">D</text>
              {/* Draggable end handle */}
              {gradientEnd && (
                <>
                  <circle cx={gradientEnd.x * gridSize} cy={gradientEnd.y * gridSize} r={8}
                    fill="#1e293b" stroke="#34d399" strokeWidth={2} style={{ cursor: "grab" }}
                    onMouseDown={(e) => { e.stopPropagation(); setDraggingGradient("end"); gradientSvgRef.current = e.currentTarget.closest("svg"); }}
                    onTouchStart={(e) => { e.stopPropagation(); setDraggingGradient("end"); gradientSvgRef.current = e.currentTarget.closest("svg"); }}
                  />
                  <text x={gradientEnd.x * gridSize} y={gradientEnd.y * gridSize + 3.5} textAnchor="middle"
                    fill="#34d399" fontSize={8} fontFamily="sans-serif" fontWeight="bold" pointerEvents="none">L</text>
                </>
              )}
            </g>
          )}

          {/* Ghost furniture preview while placing */}
          {placingFurniture && hoverGrid && (() => {
            const def = FURNITURE_TYPES[placingFurniture] || FURNITURE_TYPES.label;
            const gw = def.w * gridSize;
            const gh = def.h * gridSize;
            const gcx = (hoverGrid.x + 0.5) * gridSize;
            const gcy = (hoverGrid.y + 0.5) * gridSize;
            return (
              <g style={{ pointerEvents: "none" }}>
                <rect x={gcx - gw / 2} y={gcy - gh / 2} width={gw} height={gh} rx={3}
                  fill={def.color} opacity={0.3}
                  stroke={def.color} strokeWidth={2} strokeDasharray="4,3"
                />
                <text x={gcx} y={gcy + 4} textAnchor="middle"
                  fill="#e2e8f0" fontSize={Math.min(10, gw * 0.35)} fontFamily="sans-serif" fontWeight="600"
                >{def.label}</text>
              </g>
            );
          })()}
        </svg>
      </div>

      {/* Device Controls (view mode) */}
      {selectedLight && !isEdit && (
        <div style={{
          marginTop: 12, padding: 16, borderRadius: 12,
          background: "linear-gradient(135deg, #1e293b 0%, #172033 100%)",
          border: "1px solid #334155",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#f8fafc" }}>
                {getDeviceLabel(selectedLight, nicknames)}
              </div>
              <div style={{ fontSize: 11, color: "#64748b" }}>{selectedLight.name || selectedLight.device}</div>
            </div>
            <button onClick={() => {
              const isOn = selectedLight.state?.on;
              selectedLight._controlFn(selectedLight, { on: !isOn });
            }} style={{
              padding: "6px 16px", borderRadius: 8, border: "none",
              background: selectedLight.state?.on ? "#334155" : "#6366f1",
              color: "#f1f5f9", fontSize: 12, fontWeight: 600, cursor: "pointer",
            }}>{selectedLight.state?.on ? "Off" : "On"}</button>
          </div>
          <Slider
            label="Brightness"
            value={selectedLight.type === "hue" ? Math.round((selectedLight.state?.brightness || 0) * 100 / 254) : (selectedLight.state?.brightness || 0)}
            min={0} max={100}
            onChange={(val) => {
              const cmd = selectedLight.type === "hue" ? { brightness: Math.round(val * 254 / 100) } : { brightness: val };
              selectedLight._controlFn(selectedLight, { on: true, ...cmd });
            }}
            color="#fbbf24" unit="%"
          />
          {selectedLight.capabilities?.has_color && (
            <div style={{ marginTop: 4 }}>
              <ColorPicker
                size={140}
                currentColor={selectedColor}
                onColorSelect={(r, g, b) => {
                  if (selectedLight.type === "hue") {
                    selectedLight._controlFn(selectedLight, { on: true, r, g, b });
                  } else {
                    selectedLight._controlFn(selectedLight, { on: true, r, g, b });
                  }
                }}
                favorites={favorites}
                onFavoritesChange={onFavoritesChange}
              />
            </div>
          )}
        </div>
      )}

      {/* Edit mode: selected device actions */}
      {selectedDevice && isEdit && lightMap[selectedDevice] && (
        <div style={{
          marginTop: 8, padding: 10, borderRadius: 8,
          background: "#1e293b", border: "1px solid #334155",
          display: "flex", gap: 8, alignItems: "center", fontSize: 12, color: "#94a3b8",
        }}>
          <span style={{ fontWeight: 600, color: "#e2e8f0" }}>{getDeviceLabel(lightMap[selectedDevice], nicknames)}</span>
          <button onClick={() => removeDevice(selectedDevice)} style={{
            padding: "4px 10px", borderRadius: 6, border: "1px solid #dc2626",
            background: "transparent", color: "#f87171", fontSize: 11, cursor: "pointer",
          }}>Remove from map</button>
        </div>
      )}

      {/* Unplaced device palette (edit mode) */}
      {isEdit && unplacedKeys.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 6 }}>
            Unplaced Devices
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {unplacedKeys.map(key => {
              const light = lightMap[key];
              if (!light) return null;
              return (
                <button key={key} onClick={() => setPlacingDevice(key)}
                  style={{
                    padding: "6px 12px", borderRadius: 8,
                    border: placingDevice === key ? "1px solid #6366f1" : "1px solid #334155",
                    background: placingDevice === key ? "rgba(99,102,241,0.15)" : "#1e293b",
                    color: placingDevice === key ? "#a5b4fc" : "#94a3b8",
                    fontSize: 11, cursor: "pointer",
                  }}
                >
                  <span style={{ width: 8, height: 8, borderRadius: "50%", display: "inline-block", marginRight: 6, background: getDeviceColor(light) }} />
                  {getDeviceLabel(light, nicknames)}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Furniture palette (edit mode, 2D only) — click to select, then click map to place */}
      {isEdit && !isLinear && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 6 }}>
            Add Reference Items
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {Object.entries(FURNITURE_TYPES).map(([type, def]) => (
              <button key={type}
                onClick={() => {
                  setPlacingFurniture(placingFurniture === type ? null : type);
                  setPlacingDevice(null); setPlacingLandmark(false); setHoverGrid(null);
                }}
                style={{
                  padding: "12px 16px", borderRadius: 10,
                  border: placingFurniture === type ? "1px solid #6366f1" : "1px solid #334155",
                  background: placingFurniture === type ? "rgba(99,102,241,0.15)" : "#1e293b",
                  color: placingFurniture === type ? "#a5b4fc" : "#94a3b8",
                  fontSize: 12, cursor: "pointer",
                  display: "inline-flex", alignItems: "center",
                }}
              >
                <span style={{ width: 10, height: 10, borderRadius: 3, display: "inline-block", marginRight: 8, background: def.color, opacity: 0.6 }} />
                {def.label}
              </button>
            ))}
          </div>
          {placingFurniture && (
            <div style={{
              marginTop: 6, padding: "6px 12px", borderRadius: 8,
              background: "rgba(99,102,241,0.1)", border: "1px solid rgba(99,102,241,0.2)",
              color: "#a5b4fc", fontSize: 11,
            }}>
              Move cursor over map and click to place <strong>{FURNITURE_TYPES[placingFurniture]?.label}</strong>
              <button onClick={() => { setPlacingFurniture(null); setHoverGrid(null); }} style={{
                marginLeft: 10, padding: "2px 8px", borderRadius: 6, border: "1px solid #6366f1",
                background: "transparent", color: "#a5b4fc", fontSize: 10, cursor: "pointer",
              }}>Cancel</button>
            </div>
          )}
        </div>
      )}

      {/* Selected furniture actions (edit mode) */}
      {isEdit && selectedFurniture && (layout.furniture || []).find(f => f.id === selectedFurniture) && (() => {
        const item = layout.furniture.find(f => f.id === selectedFurniture);
        return (
          <div style={{
            marginTop: 8, padding: 10, borderRadius: 8,
            background: "#1e293b", border: "1px solid #334155",
            display: "flex", gap: 8, alignItems: "center", fontSize: 12, color: "#94a3b8", flexWrap: "wrap",
          }}>
            <input type="text" value={item.label}
              onChange={(e) => renameFurniture(item.id, e.target.value)}
              style={{
                padding: "3px 8px", borderRadius: 6, border: "1px solid #334155",
                background: "#0f172a", color: "#e2e8f0", fontSize: 11, width: 100, outline: "none",
              }}
            />
            <button onClick={() => rotateFurniture(item.id)} style={{
              padding: "4px 10px", borderRadius: 6, border: "1px solid #334155",
              background: "transparent", color: "#94a3b8", fontSize: 11, cursor: "pointer",
            }}>Rotate 90&deg;</button>
            <span style={{ fontSize: 10, color: "#64748b" }}>
              {item.w.toFixed(1)}&times;{item.h.toFixed(1)}
            </span>
            <button onClick={() => deleteFurniture(item.id)} style={{
              padding: "4px 10px", borderRadius: 6, border: "1px solid #dc2626",
              background: "transparent", color: "#f87171", fontSize: 11, cursor: "pointer", marginLeft: "auto",
            }}>Delete</button>
          </div>
        );
      })()}

      {/* Landmark controls (edit mode, linear only) */}
      {isEdit && isLinear && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.8 }}>
              Landmarks
            </div>
            <button onClick={() => { setPlacingLandmark(true); setPlacingDevice(null); setPlacingFurniture(null); }}
              style={{
                padding: "4px 10px", borderRadius: 6,
                border: placingLandmark ? "1px solid #6366f1" : "1px solid #334155",
                background: placingLandmark ? "rgba(99,102,241,0.15)" : "transparent",
                color: placingLandmark ? "#a5b4fc" : "#94a3b8", fontSize: 11, cursor: "pointer",
              }}>+ Add</button>
          </div>
          {placingLandmark && (
            <div style={{
              marginBottom: 8, padding: "6px 12px", borderRadius: 8,
              background: "rgba(99,102,241,0.1)", border: "1px solid rgba(99,102,241,0.2)",
              color: "#a5b4fc", fontSize: 11,
            }}>
              Tap the line to place a landmark
              <button onClick={() => setPlacingLandmark(false)} style={{
                marginLeft: 10, padding: "2px 8px", borderRadius: 6, border: "1px solid #6366f1",
                background: "transparent", color: "#a5b4fc", fontSize: 10, cursor: "pointer",
              }}>Cancel</button>
            </div>
          )}
          {(layout.landmarks || []).length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {(layout.landmarks || []).map((lm, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 0 }}>
                  {editingLandmark === i ? (
                    <input type="text" defaultValue={lm.label} autoFocus
                      onBlur={(e) => { renameLandmark(i, e.target.value || lm.label); setEditingLandmark(null); }}
                      onKeyDown={(e) => { if (e.key === "Enter") { renameLandmark(i, e.target.value || lm.label); setEditingLandmark(null); } }}
                      style={{
                        padding: "3px 8px", borderRadius: "6px 0 0 6px", border: "1px solid #6366f1",
                        background: "#0f172a", color: "#e2e8f0", fontSize: 11, width: 80, outline: "none",
                      }}
                    />
                  ) : (
                    <button onClick={() => setEditingLandmark(i)}
                      style={{
                        padding: "4px 10px", borderRadius: "6px 0 0 6px", border: "1px solid #334155",
                        background: "#1e293b", color: "#e2e8f0", fontSize: 11, cursor: "pointer",
                      }}>{lm.label}</button>
                  )}
                  <button onClick={() => deleteLandmark(i)}
                    style={{
                      padding: "4px 6px", borderRadius: "0 6px 6px 0", border: "1px solid #334155", borderLeft: "none",
                      background: "#1e293b", color: "#64748b", fontSize: 10, cursor: "pointer",
                    }}>&times;</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
