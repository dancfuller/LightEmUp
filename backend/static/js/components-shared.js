// ─── Shared Color Picker & Controls ────────────────────────────────────────

function RgbSliderInput({ label, value, onChange, color }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontSize: 11, fontWeight: 700, color, width: 12, textAlign: "center" }}>{label}</span>
      <input
        type="range" min={0} max={255} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{
          flex: 1, height: 5, appearance: "none", borderRadius: 3,
          background: `linear-gradient(to right, ${
            label === "R" ? `rgb(0,${value > 128 ? 0 : 0},${value > 128 ? 0 : 0}), rgb(255,0,0)` :
            label === "G" ? `rgb(0,0,0), rgb(0,255,0)` :
            `rgb(0,0,0), rgb(0,0,255)`
          })`,
          cursor: "pointer", outline: "none",
        }}
      />
      <input
        type="number" min={0} max={255} value={value}
        onChange={(e) => {
          const v = Math.max(0, Math.min(255, Number(e.target.value) || 0));
          onChange(v);
        }}
        style={{
          width: 46, padding: "3px 6px", borderRadius: 6,
          border: "1px solid #334155", background: "#0f172a",
          color: "#e2e8f0", fontSize: 12, textAlign: "center", outline: "none",
        }}
      />
    </div>
  );
}

function ColorPicker({ size = 140, currentColor, onColorSelect, favorites, onFavoritesChange, compact = false }) {
  const [mode, setMode] = useState("wheel"); // "wheel" | "rgb" | "favorites"
  const [localR, setLocalR] = useState(currentColor?.r ?? 255);
  const [localG, setLocalG] = useState(currentColor?.g ?? 180);
  const [localB, setLocalB] = useState(currentColor?.b ?? 100);
  const [editingFavs, setEditingFavs] = useState(false);
  const [newFavLabel, setNewFavLabel] = useState("");

  // Sync local RGB when currentColor prop changes (e.g. after Apply from ColorMode
  // updates the parent light's state.color)
  useEffect(() => {
    if (currentColor?.r != null) setLocalR(currentColor.r);
    if (currentColor?.g != null) setLocalG(currentColor.g);
    if (currentColor?.b != null) setLocalB(currentColor.b);
  }, [currentColor?.r, currentColor?.g, currentColor?.b]);

  // Sync local RGB when currentColor changes from external source (wheel pick)
  const handleWheelPick = (r, g, b) => {
    setLocalR(r);
    setLocalG(g);
    setLocalB(b);
    onColorSelect(r, g, b);
  };

  const handleRgbChange = (channel, val) => {
    const r = channel === "r" ? val : localR;
    const g = channel === "g" ? val : localG;
    const b = channel === "b" ? val : localB;
    if (channel === "r") setLocalR(val);
    if (channel === "g") setLocalG(val);
    if (channel === "b") setLocalB(val);
    onColorSelect(r, g, b);
  };

  const addCurrentAsFavorite = () => {
    const label = newFavLabel.trim() || `${localR},${localG},${localB}`;
    const updated = [...favorites, { r: localR, g: localG, b: localB, label }];
    onFavoritesChange(updated);
    setNewFavLabel("");
  };

  const removeFavorite = (index) => {
    const updated = favorites.filter((_, i) => i !== index);
    onFavoritesChange(updated);
  };

  const tabStyle = (active) => ({
    padding: compact ? "4px 10px" : "5px 12px", borderRadius: 6, border: "none",
    background: active ? "#334155" : "transparent",
    color: active ? "#e2e8f0" : "#64748b",
    fontSize: 11, fontWeight: 600, cursor: "pointer",
    transition: "all 0.15s",
  });

  return (
    <div>
      {/* Mode tabs */}
      <div style={{
        display: "flex", gap: 2, marginBottom: 10, padding: 2,
        background: "#0f172a", borderRadius: 8,
      }}>
        <button style={tabStyle(mode === "wheel")} onClick={() => setMode("wheel")}>Wheel</button>
        <button style={tabStyle(mode === "rgb")} onClick={() => setMode("rgb")}>RGB</button>
        <button style={tabStyle(mode === "favorites")} onClick={() => setMode("favorites")}>
          Favorites{favorites.length > 0 ? ` (${favorites.length})` : ""}
        </button>
      </div>

      {/* Current color preview */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10, marginBottom: 10,
        padding: "6px 10px", background: "#0f172a", borderRadius: 8,
      }}>
        <div style={{
          width: 28, height: 28, borderRadius: 8, flexShrink: 0,
          background: `rgb(${localR},${localG},${localB})`,
          border: "1px solid rgba(255,255,255,0.1)",
        }} />
        <span style={{ fontSize: 12, color: "#94a3b8" }}>
          R:{localR} G:{localG} B:{localB}
        </span>
        {mode !== "favorites" && (
          <button
            onClick={() => { setMode("favorites"); setEditingFavs(true); }}
            style={{
              marginLeft: "auto", padding: "3px 8px", borderRadius: 6, border: "none",
              background: "rgba(99,102,241,0.15)", color: "#a5b4fc",
              fontSize: 10, fontWeight: 600, cursor: "pointer",
            }}
          >★ Save</button>
        )}
      </div>

      {/* Wheel mode */}
      {mode === "wheel" && (
        <div style={{ display: "flex", justifyContent: "center" }}>
          <ColorWheel size={size} onColorSelect={handleWheelPick} />
        </div>
      )}

      {/* RGB sliders mode */}
      {mode === "rgb" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <RgbSliderInput label="R" value={localR} onChange={(v) => handleRgbChange("r", v)} color="#f87171" />
          <RgbSliderInput label="G" value={localG} onChange={(v) => handleRgbChange("g", v)} color="#4ade80" />
          <RgbSliderInput label="B" value={localB} onChange={(v) => handleRgbChange("b", v)} color="#60a5fa" />
        </div>
      )}

      {/* Favorites mode */}
      {mode === "favorites" && (
        <div>
          {favorites.length === 0 ? (
            <div style={{
              padding: 20, textAlign: "center", color: "#475569", fontSize: 13,
              borderRadius: 10, border: "1px dashed #334155",
            }}>
              No favorites yet. Pick a color and tap ★ Save.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {favorites.map((fav, i) => (
                <div key={i} style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "8px 10px", borderRadius: 8,
                  background: "#0f172a", border: "1px solid #1e293b",
                }}>
                  <button
                    onClick={() => {
                      setLocalR(fav.r); setLocalG(fav.g); setLocalB(fav.b);
                      onColorSelect(fav.r, fav.g, fav.b);
                    }}
                    style={{
                      display: "flex", alignItems: "center", gap: 8,
                      background: "none", border: "none", cursor: "pointer",
                      flex: 1, padding: 0, textAlign: "left",
                    }}
                  >
                    <div style={{
                      width: 24, height: 24, borderRadius: 6, flexShrink: 0,
                      background: `rgb(${fav.r},${fav.g},${fav.b})`,
                      border: "1px solid rgba(255,255,255,0.1)",
                    }} />
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "#e2e8f0" }}>{fav.label}</div>
                      <div style={{ fontSize: 10, color: "#64748b" }}>{fav.r}, {fav.g}, {fav.b}</div>
                    </div>
                  </button>
                  {editingFavs && (
                    <button
                      onClick={() => removeFavorite(i)}
                      style={{
                        padding: "3px 8px", borderRadius: 6, border: "none",
                        background: "rgba(248,113,113,0.12)", color: "#f87171",
                        fontSize: 11, fontWeight: 600, cursor: "pointer",
                      }}
                    >&times;</button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Add favorite / edit toggle */}
          <div style={{ display: "flex", gap: 6, marginTop: 10, alignItems: "center" }}>
            {editingFavs ? (
              <>
                <div style={{
                  width: 20, height: 20, borderRadius: 5, flexShrink: 0,
                  background: `rgb(${localR},${localG},${localB})`,
                  border: "1px solid rgba(255,255,255,0.1)",
                }} />
                <input
                  type="text" value={newFavLabel}
                  onChange={(e) => setNewFavLabel(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addCurrentAsFavorite()}
                  placeholder="Label (optional)..."
                  style={{
                    flex: 1, padding: "6px 10px", borderRadius: 8,
                    border: "1px solid #334155", background: "#1e293b",
                    color: "#f1f5f9", fontSize: 12, outline: "none",
                  }}
                />
                <button
                  onClick={addCurrentAsFavorite}
                  style={{
                    padding: "6px 12px", borderRadius: 8, border: "none",
                    background: "#6366f1", color: "#fff",
                    fontSize: 11, fontWeight: 600, cursor: "pointer",
                  }}
                >Add</button>
                <button
                  onClick={() => setEditingFavs(false)}
                  style={{
                    padding: "6px 10px", borderRadius: 8, border: "1px solid #334155",
                    background: "transparent", color: "#94a3b8",
                    fontSize: 11, fontWeight: 600, cursor: "pointer",
                  }}
                >Done</button>
              </>
            ) : (
              <button
                onClick={() => setEditingFavs(true)}
                style={{
                  padding: "6px 12px", borderRadius: 8, border: "1px solid #334155",
                  background: "transparent", color: "#94a3b8",
                  fontSize: 11, fontWeight: 600, cursor: "pointer",
                }}
              >Edit Favorites</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Light & Room Controls ──────────────────────────────────────────────────

function StatusBadge({ connected, label }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: "4px 12px", borderRadius: 20,
      background: connected ? "rgba(74,222,128,0.15)" : "rgba(248,113,113,0.15)",
      color: connected ? "#4ade80" : "#f87171",
      fontSize: 12, fontWeight: 600, letterSpacing: 0.5,
    }}>
      <span style={{
        width: 7, height: 7, borderRadius: "50%",
        background: connected ? "#4ade80" : "#f87171",
        boxShadow: connected ? "0 0 6px #4ade80" : "none",
      }} />
      {label}
    </span>
  );
}

function ColorWheel({ size = 180, onColorSelect }) {
  const canvasRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const cx = size / 2, cy = size / 2, radius = size / 2 - 4;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - cx, dy = y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist <= radius) {
          const hue = (Math.atan2(dy, dx) / (2 * Math.PI) + 1) % 1;
          const sat = dist / radius;
          const [r, g, b] = hsvToRgb(hue, sat, 1);
          ctx.fillStyle = `rgb(${r},${g},${b})`;
          ctx.fillRect(x, y, 1, 1);
        }
      }
    }
  }, [size]);

  const pickColor = useCallback((e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX || e.touches?.[0]?.clientX) - rect.left;
    const y = (e.clientY || e.touches?.[0]?.clientY) - rect.top;
    const cx = size / 2, cy = size / 2, radius = size / 2 - 4;
    const dx = x - cx, dy = y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= radius) {
      const hue = (Math.atan2(dy, dx) / (2 * Math.PI) + 1) % 1;
      const sat = dist / radius;
      const [r, g, b] = hsvToRgb(hue, sat, 1);
      onColorSelect?.(r, g, b);
    }
  }, [size, onColorSelect]);

  return (
    <canvas
      ref={canvasRef} width={size} height={size}
      style={{ borderRadius: "50%", cursor: "crosshair", touchAction: "none" }}
      onMouseDown={(e) => { setIsDragging(true); pickColor(e); }}
      onMouseMove={(e) => isDragging && pickColor(e)}
      onMouseUp={() => setIsDragging(false)}
      onMouseLeave={() => setIsDragging(false)}
      onTouchStart={(e) => { e.preventDefault(); pickColor(e); }}
      onTouchMove={(e) => { e.preventDefault(); pickColor(e); }}
    />
  );
}

function Slider({ label, value, min, max, onChange, color, unit = "" }) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 12, color: "#94a3b8", fontWeight: 500 }}>{label}</span>
        <span style={{ fontSize: 12, color: "#e2e8f0", fontWeight: 600 }}>{value}{unit}</span>
      </div>
      <input
        type="range" min={min} max={max} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{
          width: "100%", height: 6, appearance: "none", borderRadius: 3,
          background: `linear-gradient(to right, ${color || "#6366f1"} ${pct}%, #334155 ${pct}%)`,
          cursor: "pointer", outline: "none",
        }}
      />
    </div>
  );
}
