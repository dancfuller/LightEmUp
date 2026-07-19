// ─── Shared Color Picker & Controls ────────────────────────────────────────

// HueBar: a single-row horizontal hue strip (ROYGBIV). Click or drag to
// pick a hue at full saturation and 50% lightness. Compact alternative to
// the full ColorPicker when you only need a primary hue and don't care
// about tinting/shading. Returns full RGB via onChange.
function HueBar({ currentColor, onChange, height = 22 }) {
  const ref = useRef(null);
  const draggingRef = useRef(false);

  const pickAt = (clientX) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const rgb = hslToRgb(t, 1, 0.5);
    onChange(rgb);
  };

  const onDown = (e) => {
    draggingRef.current = true;
    pickAt(e.touches ? e.touches[0].clientX : e.clientX);
    e.preventDefault();
  };
  const onMove = (e) => {
    if (!draggingRef.current) return;
    pickAt(e.touches ? e.touches[0].clientX : e.clientX);
  };
  const onUp = () => { draggingRef.current = false; };

  useEffect(() => {
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
  }, []);

  // Compute thumb position from currentColor's hue.
  const { h } = currentColor
    ? rgbToHsl(currentColor.r, currentColor.g, currentColor.b)
    : { h: 0 };

  return (
    <div
      ref={ref}
      onMouseDown={onDown}
      onTouchStart={onDown}
      style={{
        width: "100%", height, flexShrink: 0, borderRadius: height / 2, position: "relative",
        cursor: "pointer", userSelect: "none",
        background: "linear-gradient(to right, "
          + "hsl(0,100%,50%), hsl(30,100%,50%), hsl(60,100%,50%), "
          + "hsl(120,100%,50%), hsl(180,100%,50%), hsl(240,100%,50%), "
          + "hsl(275,100%,50%), hsl(300,100%,50%), hsl(360,100%,50%))",
        border: "1px solid rgba(255,255,255,0.1)",
      }}
    >
      <div style={{
        position: "absolute", top: -2, bottom: -2,
        left: `${h * 100}%`, width: 4, transform: "translateX(-2px)",
        background: "#fff", borderRadius: 2,
        boxShadow: "0 0 4px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.4)",
        pointerEvents: "none",
      }} />
    </div>
  );
}

function RgbSliderInput({ label, value, onChange, color }) {
  const [local, onInput] = useThrottledControl(value, onChange, 180);
  // The number box keeps its own draft string while focused: without it, clearing
  // the field to retype snaps the value to 0 mid-keystroke (and fires the light).
  // A draft that isn't a number is simply not committed; blur restores the real value.
  const [draft, setDraft] = useState(null);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontSize: 11, fontWeight: 700, color, width: 12, textAlign: "center" }}>{label}</span>
      <input
        type="range" min={0} max={255} value={local}
        onChange={(e) => onInput(Number(e.target.value))}
        style={{
          flex: 1, minWidth: 0, height: 5, appearance: "none", borderRadius: 3,
          background: `linear-gradient(to right, ${
            label === "R" ? `rgb(0,0,0), rgb(255,0,0)` :
            label === "G" ? `rgb(0,0,0), rgb(0,255,0)` :
            `rgb(0,0,0), rgb(0,0,255)`
          })`,
          cursor: "pointer", outline: "none",
        }}
      />
      <input
        type="number" min={0} max={255} inputMode="numeric"
        value={draft ?? String(local)}
        onFocus={(e) => e.target.select()}
        onChange={(e) => {
          const text = e.target.value;
          setDraft(text);
          if (text.trim() !== "" && !Number.isNaN(Number(text))) {
            onInput(Math.max(0, Math.min(255, Math.round(Number(text)))));
          }
        }}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }}
        style={{
          width: 46, flexShrink: 0, padding: "3px 6px", borderRadius: 6,
          border: "1px solid #334155", background: "#0f172a",
          color: "#e2e8f0", fontSize: 12, textAlign: "center", outline: "none",
        }}
      />
    </div>
  );
}

// HexColorInput: type or paste a hex code to set the color exactly. The "#" is
// shown as a fixed prefix and stripped from anything pasted, so both "#1E90FF"
// and "1e90ff" work (3-digit shorthand too). While you're typing, the field
// holds a draft: it only drives the light once the text actually parses, and an
// unparseable draft turns red instead of sending garbage. Blur re-normalizes to
// the canonical value.
function HexColorInput({ value, onChange }) {
  const [draft, setDraft] = useState(null);
  const canonical = rgbToHex(value?.r ?? 0, value?.g ?? 0, value?.b ?? 0).slice(1);
  const shown = draft ?? canonical;
  const parsed = hexToRgb(shown);
  const invalid = draft !== null && draft.trim() !== "" && !parsed;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8", width: 12, textAlign: "center" }}>#</span>
      <input
        type="text" value={shown} placeholder="RRGGBB"
        spellCheck={false} autoComplete="off" autoCapitalize="off"
        onFocus={(e) => e.target.select()}
        onChange={(e) => {
          const text = e.target.value;
          setDraft(text);
          const rgb = hexToRgb(text);
          if (rgb) onChange(rgb);
        }}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }}
        style={{
          flex: 1, minWidth: 0, padding: "4px 8px", borderRadius: 6,
          border: `1px solid ${invalid ? "#f87171" : "#334155"}`,
          background: "#0f172a", color: invalid ? "#fca5a5" : "#e2e8f0",
          fontSize: 12, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          letterSpacing: 1, textTransform: "uppercase", outline: "none",
        }}
      />
      <div style={{
        width: 46, height: 22, flexShrink: 0, borderRadius: 6,
        background: parsed ? `rgb(${parsed.r},${parsed.g},${parsed.b})` : "transparent",
        border: "1px solid rgba(255,255,255,0.1)",
      }} />
    </div>
  );
}

function ColorPicker({ size = 140, currentColor, onColorSelect, favorites, onFavoritesChange, compact = false,
                       stageApply = false, onApply, applyLabel }) {
  // stageApply (opt-in): picking a color/favorite/RGB does NOT drive the lights —
  // it *stages* a pending color, committed only by the "Apply to …" button
  // (onApply). Used by the room Controls so selecting a favorite or nudging RGB
  // no longer silently applies with no feedback. Default off, so every other
  // ColorPicker (per-device, room map, the color-tool base pickers that must
  // live-preview) keeps its immediate onColorSelect behavior untouched.
  const pickerStyle = useContext(PickerStyleContext); // "huebar" | "wheel"
  const [mode, setMode] = useState("wheel"); // "wheel" | "rgb" | "favorites"
  const [localR, setLocalR] = useState(currentColor?.r ?? 255);
  const [localG, setLocalG] = useState(currentColor?.g ?? 180);
  const [localB, setLocalB] = useState(currentColor?.b ?? 100);
  const [editingFavs, setEditingFavs] = useState(false);
  const [newFavLabel, setNewFavLabel] = useState("");
  // staged = there's a pending color the user picked but hasn't Applied yet
  // (stageApply mode only). A ref mirrors it so the currentColor sync effect can
  // read it without re-subscribing.
  const [staged, setStaged] = useState(false);
  const stagedRef = useRef(false);
  const setStagedFlag = (v) => { stagedRef.current = v; setStaged(v); };

  // Sync local RGB when currentColor prop changes (e.g. after Apply from ColorMode
  // updates the parent light's state.color). In stageApply mode, don't clobber a
  // pending stage with an incoming refresh — the user's unapplied pick wins until
  // they Apply (or a fresh external color arrives after they've committed).
  useEffect(() => {
    if (stageApply && stagedRef.current) return;
    if (currentColor?.r != null) setLocalR(currentColor.r);
    if (currentColor?.g != null) setLocalG(currentColor.g);
    if (currentColor?.b != null) setLocalB(currentColor.b);
  }, [currentColor?.r, currentColor?.g, currentColor?.b]);

  // Unified color choice. In stageApply mode it stages (no light command); else it
  // drives the lights immediately (legacy behavior).
  const chooseColor = (r, g, b) => {
    setLocalR(r);
    setLocalG(g);
    setLocalB(b);
    if (stageApply) setStagedFlag(true);
    else onColorSelect(r, g, b);
  };

  const applyStaged = () => {
    onApply?.(localR, localG, localB);
    setStagedFlag(false);
  };

  const handleWheelPick = (r, g, b) => chooseColor(r, g, b);

  const handleRgbChange = (channel, val) => {
    const r = channel === "r" ? val : localR;
    const g = channel === "g" ? val : localG;
    const b = channel === "b" ? val : localB;
    chooseColor(r, g, b);
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
        <button style={tabStyle(mode === "wheel")} onClick={() => setMode("wheel")}>
          {pickerStyle === "huebar" ? "Hue" : "Wheel"}
        </button>
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

      {/* Wheel mode — either the full wheel or the compact HueBar,
          depending on the user's Settings preference. */}
      {mode === "wheel" && pickerStyle === "huebar" && (
        <div style={{ padding: "4px 2px 2px 2px" }}>
          <HueBar
            currentColor={{ r: localR, g: localG, b: localB }}
            onChange={({ r, g, b }) => handleWheelPick(r, g, b)}
            height={compact ? 22 : 28}
          />
        </div>
      )}
      {mode === "wheel" && pickerStyle !== "huebar" && (
        <div style={{ display: "flex", justifyContent: "center" }}>
          <ColorWheel size={size} onColorSelect={handleWheelPick} />
        </div>
      )}

      {/* RGB sliders mode — drag the sliders, type exact channel values, or
          paste a hex code. All three drive the same color. */}
      {mode === "rgb" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <RgbSliderInput label="R" value={localR} onChange={(v) => handleRgbChange("r", v)} color="#f87171" />
          <RgbSliderInput label="G" value={localG} onChange={(v) => handleRgbChange("g", v)} color="#4ade80" />
          <RgbSliderInput label="B" value={localB} onChange={(v) => handleRgbChange("b", v)} color="#60a5fa" />
          <div style={{ height: 1, background: "#1e293b", margin: "2px 0" }} />
          <HexColorInput
            value={{ r: localR, g: localG, b: localB }}
            onChange={({ r, g, b }) => handleWheelPick(r, g, b)}
          />
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
              {favorites.map((fav, i) => {
                // Highlight the favorite that is the currently-APPLIED color (solid
                // ring), or — in stageApply mode — the pending pick the user hasn't
                // committed yet (dashed ring, "Staged"). "Applied" is judged against
                // currentColor (the real light state), NOT the local pick, so the
                // default pick never falsely flags a look-alike favorite.
                const matchesStaged = stageApply && staged
                  && fav.r === localR && fav.g === localG && fav.b === localB;
                const matchesApplied = !matchesStaged && currentColor?.r != null
                  && fav.r === currentColor.r && fav.g === currentColor.g && fav.b === currentColor.b;
                const isCurrent = matchesStaged || matchesApplied;
                return (
                <div key={i} style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "8px 10px", borderRadius: 8,
                  background: isCurrent ? "rgba(99,102,241,0.10)" : "#0f172a",
                  border: isCurrent
                    ? `1px ${matchesStaged ? "dashed" : "solid"} #6366f1`
                    : "1px solid #1e293b",
                }}>
                  <button
                    onClick={() => chooseColor(fav.r, fav.g, fav.b)}
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
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: "#e2e8f0" }}>{fav.label}</span>
                        {stageApply && isCurrent && (
                          <span style={{
                            fontSize: 9, fontWeight: 700, letterSpacing: 0.4,
                            padding: "1px 6px", borderRadius: 10, textTransform: "uppercase",
                            color: "#a5b4fc", background: "rgba(99,102,241,0.18)",
                          }}>{matchesStaged ? "Staged" : "Applied"}</span>
                        )}
                      </div>
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
                );
              })}
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

      {/* Stage-then-Apply commit bar (opt-in). Muted "Applied" until the user
          stages a new color, then a prominent "Apply to {room}". */}
      {stageApply && (
        <button
          onClick={applyStaged}
          disabled={!staged}
          style={{
            width: "100%", marginTop: 12, padding: "11px 12px", borderRadius: 10,
            border: "none", cursor: staged ? "pointer" : "default",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
            background: staged ? "#6366f1" : "#1e293b",
            color: staged ? "#fff" : "#64748b",
            fontSize: 13, fontWeight: 700, transition: "all 0.15s",
          }}
        >
          <span style={{
            width: 18, height: 18, borderRadius: 5, flexShrink: 0,
            background: `rgb(${localR},${localG},${localB})`,
            border: "1px solid rgba(255,255,255,0.25)",
          }} />
          {staged
            ? `Apply to ${applyLabel || "room"}`
            : (currentColor?.r != null ? "Applied ✓" : "Pick a color to apply")}
        </button>
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

function Slider({ label, value, min, max, onChange, color, unit = "", throttleMs = 180 }) {
  const [local, onInput] = useThrottledControl(value, onChange, throttleMs);
  const pct = ((local - min) / (max - min)) * 100;
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 12, color: "#94a3b8", fontWeight: 500 }}>{label}</span>
        <span style={{ fontSize: 12, color: "#e2e8f0", fontWeight: 600 }}>{local}{unit}</span>
      </div>
      <input
        type="range" min={min} max={max} value={local}
        onChange={(e) => onInput(Number(e.target.value))}
        style={{
          width: "100%", height: 6, appearance: "none", borderRadius: 3,
          background: `linear-gradient(to right, ${color || "#6366f1"} ${pct}%, #334155 ${pct}%)`,
          cursor: "pointer", outline: "none",
        }}
      />
    </div>
  );
}

// Tunable-white slider: a warm→cool gradient track, value shown in Kelvin.
// The thumb is the standard one (styled globally in index.html).
function ColorTempSlider({ label = "Color Temperature", kelvin, onChange, min = CT_MIN_K, max = CT_MAX_K, throttleMs = 180 }) {
  const warm = kelvinToRGB(min), cool = kelvinToRGB(max);
  const mid = kelvinToRGB(Math.round((min + max) / 2));
  const [local, onInput] = useThrottledControl(kelvin, onChange, throttleMs);
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 12, color: "#94a3b8", fontWeight: 500 }}>{label}</span>
        <span style={{ fontSize: 12, color: "#e2e8f0", fontWeight: 600 }}>{local}K</span>
      </div>
      <input
        type="range" min={min} max={max} step={50} value={local}
        onChange={(e) => onInput(Number(e.target.value))}
        style={{
          width: "100%", height: 10, appearance: "none", borderRadius: 5,
          background: `linear-gradient(to right, rgb(${warm.r},${warm.g},${warm.b}), rgb(${mid.r},${mid.g},${mid.b}), rgb(${cool.r},${cool.g},${cool.b}))`,
          cursor: "pointer", outline: "none",
        }}
      />
    </div>
  );
}
