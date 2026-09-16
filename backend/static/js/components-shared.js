// ─── Shared Color Picker & Controls ────────────────────────────────────────

// Scene fill: how a room scene paints a device that scenes address by segment.
// Shared by the LightCard control and the scenes panel's mirror of it (v3.36.0)
// so the two can never drift into describing the same setting differently.
// `effect` says what the mode DOES to one specific device — its segment count
// and the word for a single segment — because the label "Solid" on its own
// doesn't explain a preview showing fifteen identical swatches.
const SCENE_FILL_MODES = [
  {
    key: "follow", label: "Follow",
    title: "Each segment follows the scene's per-segment color",
    effect: (n, unit) => `Each ${unit} takes its own color from the scene`,
  },
  {
    key: "solid", label: "Solid",
    title: "All segments are the same color from the scene",
    effect: (n, unit) => `All ${n} ${unit}s share one color — the scene's per-${unit} colors are overridden`,
  },
  {
    key: "shades", label: "Shades",
    title: "All segments are shades of one scene color",
    effect: (n, unit) => `All ${n} ${unit}s are shades of one scene color`,
  },
];

// HueBar: a single-row horizontal hue strip (ROYGBIV). Click or drag to
// pick a hue at full saturation and 50% lightness. Compact alternative to
// the full ColorPicker when you only need a primary hue and don't care
// about tinting/shading. Returns full RGB via onChange.
// One command per `ms` while a color control is dragged, trailing — the final
// position always lands. The same cadence useThrottledControl gives the sliders;
// without it a slow drag across the bar sent dozens of commands to the light.
function useCommitThrottle(fn, ms = 180) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const slot = useRef({ timer: null, pending: null });
  useEffect(() => () => clearTimeout(slot.current.timer), []);
  return useCallback((v) => {
    const s = slot.current;
    s.pending = v;
    if (s.timer) return;
    const fire = () => {
      if (s.pending == null) { s.timer = null; return; }
      const x = s.pending; s.pending = null;
      fnRef.current(x);
      s.timer = setTimeout(fire, ms);
    };
    fire();
  }, [ms]);
}

// An accidental TOUCH must never change a light (v3.50.0). This bar used to pick
// a color on touch-DOWN and call preventDefault, so a scroll that happened to
// start on it was swallowed and sent whatever hue sat under the finger — the
// v3.32.0 slider accident, left open on the default color control of every light
// card. Now, on touch:
//   - touch-down picks nothing;
//   - a mostly-vertical move is a scroll: `touchAction: pan-y` hands it to the
//     page and the bar lets go;
//   - a mostly-horizontal move past TAP_SLOP_PX is a drag: it picks, throttled;
//   - a tap that never moved picks once, on release — tapping a hue is a real
//     gesture on this control, unlike tapping a slider's track.
// The mouse is exempt, as with the sliders: a pointer can't brush a control
// while scrolling.
function HueBar({ currentColor, onChange, height = 22 }) {
  const ref = useRef(null);
  const g = useRef({ active: false, touch: false, moved: false, x: 0, y: 0 });
  const lastTouchAt = useRef(0);                // see onMouseDown
  const [localH, setLocalH] = useState(null);   // thumb follows the finger at once
  const send = useCommitThrottle(onChange);

  const hueAt = (clientX) => {
    const el = ref.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };
  const pickAt = (clientX) => {
    const t = hueAt(clientX);
    if (t == null) return;
    setLocalH(t);
    send(hslToRgb(t, 1, 0.5));
  };

  const onMouseDown = (e) => {
    // A tap on a phone is followed by compatibility mouse events. The touch path
    // already handled it, so a mousedown right after a touch is not a second pick.
    if (Date.now() - lastTouchAt.current < 800) return;
    g.current = { active: true, touch: false, moved: true, x: e.clientX, y: e.clientY };
    pickAt(e.clientX);
    e.preventDefault();
  };
  const onTouchStart = (e) => {
    const t = e.touches[0];
    g.current = { active: true, touch: true, moved: false, x: t.clientX, y: t.clientY };
  };

  useEffect(() => {
    const onMove = (e) => {
      const s = g.current;
      if (!s.active) return;
      if (!s.touch) { pickAt(e.clientX); return; }
      const t = e.touches[0];
      if (!s.moved) {
        const dx = Math.abs(t.clientX - s.x), dy = Math.abs(t.clientY - s.y);
        if (dy > TAP_SLOP_PX && dy >= dx) { s.active = false; return; }   // a scroll
        if (dx <= TAP_SLOP_PX) return;                                    // not yet anything
        s.moved = true;
      }
      e.preventDefault();
      pickAt(t.clientX);
    };
    const onEnd = (e) => {
      const s = g.current;
      if (s.touch) lastTouchAt.current = Date.now();
      // A TAP picks where it landed. Judged from where the finger LIFTED, not from
      // the moves we happened to see: once the page starts scrolling a browser may
      // stop reporting moves, and a scroll must never read as a tap. A
      // touchcancel never picks.
      if (s.active && s.touch && !s.moved && e.type === "touchend") {
        const t = e.changedTouches && e.changedTouches[0];
        if (t && Math.abs(t.clientX - s.x) <= TAP_SLOP_PX
              && Math.abs(t.clientY - s.y) <= TAP_SLOP_PX) {
          if (e.cancelable) e.preventDefault();
          pickAt(s.x);
        }
      }
      g.current = { active: false, touch: false, moved: false, x: 0, y: 0 };
      setLocalH(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onEnd);
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onEnd);
    window.addEventListener("touchcancel", onEnd);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onEnd);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
    };
  }, []);

  // Thumb: the finger's position while dragging, else currentColor's hue.
  const { h: colorH } = currentColor
    ? rgbToHsl(currentColor.r, currentColor.g, currentColor.b)
    : { h: 0 };
  const h = localH != null ? localH : colorH;

  return (
    <div
      ref={ref}
      onMouseDown={onMouseDown}
      onTouchStart={onTouchStart}
      style={{
        width: "100%", height, flexShrink: 0, borderRadius: height / 2, position: "relative",
        cursor: "pointer", userSelect: "none", touchAction: "pan-y",
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
  const [local, onInput, guard] = useThrottledControl(value, onChange, 180);
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
        {...guard}
        style={{
          // pan-y: a vertical swipe scrolls the page instead of dragging this.
          touchAction: "pan-y",
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
                       stageApply = false, onApply, applyLabel, sourceLabel }) {
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
  // Copied colors, shared by every ColorPicker in the app (module-level store in
  // utils.js). Copy here, paste from any other picker — that's the whole feature.
  const clipboard = useColorClipboard();
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef(null);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);
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

  // Copy takes what the preview is SHOWING (the local pick), not the light's
  // last-reported color — otherwise dragging the wheel and hitting Copy would
  // silently copy the color you just moved away from. The in-app clipboard is
  // the feature; mirroring the hex to the system clipboard is a bonus that may
  // silently no-op (see copyTextToSystemClipboard).
  const copyCurrent = () => {
    copyColorToClipboard({ r: localR, g: localG, b: localB }, sourceLabel);
    copyTextToSystemClipboard(rgbToHex(localR, localG, localB));
    setCopied(true);
    clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1200);
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

      {/* Current color preview — and the copy control, which lives here because
          this row already means "the color you have right now". */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        marginBottom: clipboard.length > 0 ? 6 : 10,
        padding: "6px 10px", background: "#0f172a", borderRadius: 8, flexWrap: "wrap",
      }}>
        <div style={{
          width: 28, height: 28, borderRadius: 8, flexShrink: 0,
          background: `rgb(${localR},${localG},${localB})`,
          border: "1px solid rgba(255,255,255,0.1)",
        }} />
        <span style={{ fontSize: 12, color: "#94a3b8" }}>
          R:{localR} G:{localG} B:{localB}
        </span>
        {/* Copy and ★ Save wrap together as a unit, so a narrow card drops both
            onto the second line rather than splitting them. */}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
          <button
            onClick={copyCurrent}
            title={`Copy ${rgbToHex(localR, localG, localB)} — then paste it onto another light or segment`}
            style={{
              padding: "3px 8px", borderRadius: 6, border: "none",
              background: copied ? "rgba(74,222,128,0.18)" : "rgba(148,163,184,0.14)",
              color: copied ? "#86efac" : "#cbd5e1",
              fontSize: 10, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
              transition: "background .15s, color .15s",
            }}
          >{copied ? "Copied" : "Copy"}</button>
          {mode !== "favorites" && (
            <button
              onClick={() => { setMode("favorites"); setEditingFavs(true); }}
              style={{
                padding: "3px 8px", borderRadius: 6, border: "none",
                background: "rgba(99,102,241,0.15)", color: "#a5b4fc",
                fontSize: 10, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
              }}
            >★ Save</button>
          )}
        </div>
      </div>

      {/* Paste strip — copied colors, newest first, ringed if it's the one a
          plain system paste would have given you. It only renders once something
          has been copied: that costs nothing until the feature is used, and
          appearing on the very first Copy is how it teaches itself. Clicking a
          swatch goes through chooseColor, so in stageApply mode a paste STAGES
          like any other pick instead of jumping straight to the lights. */}
      {clipboard.length > 0 && (
        <div style={{
          display: "flex", alignItems: "center", gap: 6, marginBottom: 10,
          padding: "5px 8px", background: "#0f172a", borderRadius: 8, flexWrap: "wrap",
        }}>
          <span style={{
            fontSize: 9, fontWeight: 700, letterSpacing: 0.5, color: "#64748b",
          }}>PASTE</span>
          {clipboard.map((c, i) => (
            <button
              key={`${c.r},${c.g},${c.b}`}
              onClick={() => chooseColor(c.r, c.g, c.b)}
              title={`${c.source ? c.source + " — " : ""}${rgbToHex(c.r, c.g, c.b)}${i === 0 ? " (most recent)" : ""}`}
              style={{
                width: 22, height: 22, borderRadius: 6, padding: 0, flexShrink: 0,
                cursor: "pointer", background: `rgb(${c.r},${c.g},${c.b})`,
                border: i === 0 ? "2px solid #a5b4fc" : "1px solid rgba(255,255,255,0.18)",
              }}
            />
          ))}
          <button
            onClick={clearColorClipboard}
            title="Clear copied colors"
            style={{
              marginLeft: "auto", padding: "2px 6px", borderRadius: 6, border: "none",
              background: "transparent", color: "#475569",
              fontSize: 12, fontWeight: 700, lineHeight: 1, cursor: "pointer",
            }}
          >&#10005;</button>
        </div>
      )}

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

// The wheel is a 2D surface, so it can't hand vertical swipes to the page the
// way the bar does (`touchAction: none` stays). What it can do, since v3.50.0:
// not pick on touch-down, pick on a tap's release, pick only once a touch has
// actually travelled, and throttle a drag to one command per 180 ms.
function ColorWheel({ size = 180, onColorSelect }) {
  const canvasRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);
  const touchRef = useRef({ active: false, moved: false, x: 0, y: 0 });
  const lastTouchAt = useRef(0);
  const sendColor = useCommitThrottle((c) => onColorSelect?.(c.r, c.g, c.b));

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
      sendColor({ r, g, b });
    }
  }, [size, sendColor]);

  const at = (t) => ({ clientX: t.clientX, clientY: t.clientY });
  return (
    <canvas
      ref={canvasRef} width={size} height={size}
      style={{ borderRadius: "50%", cursor: "crosshair", touchAction: "none" }}
      onMouseDown={(e) => {
        if (Date.now() - lastTouchAt.current < 800) return;   // a tap's compatibility click
        setIsDragging(true); pickColor(e);
      }}
      onMouseMove={(e) => isDragging && pickColor(e)}
      onMouseUp={() => setIsDragging(false)}
      onMouseLeave={() => setIsDragging(false)}
      onTouchStart={(e) => {
        const t = e.touches[0];
        touchRef.current = { active: true, moved: false, x: t.clientX, y: t.clientY };
      }}
      onTouchMove={(e) => {
        const s = touchRef.current;
        const t = e.touches[0];
        if (!s.active) return;
        if (!s.moved && Math.hypot(t.clientX - s.x, t.clientY - s.y) <= TAP_SLOP_PX) return;
        s.moved = true;
        pickColor(at(t));
      }}
      onTouchEnd={(e) => {
        const s = touchRef.current;
        const t = e.changedTouches && e.changedTouches[0];
        lastTouchAt.current = Date.now();
        if (s.active && !s.moved && t
            && Math.hypot(t.clientX - s.x, t.clientY - s.y) <= TAP_SLOP_PX) {
          pickColor({ clientX: s.x, clientY: s.y });
        }
        touchRef.current = { active: false, moved: false, x: 0, y: 0 };
      }}
      onTouchCancel={() => { touchRef.current = { active: false, moved: false, x: 0, y: 0 }; }}
    />
  );
}

function Slider({ label, value, min, max, onChange, color, unit = "", throttleMs = 180, valueLabel }) {
  const [local, onInput, guard] = useThrottledControl(value, onChange, throttleMs);
  const pct = ((local - min) / (max - min)) * 100;
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 12, color: "#94a3b8", fontWeight: 500 }}>{label}</span>
        <span style={{ fontSize: 12, color: "#e2e8f0", fontWeight: 600 }}>{valueLabel ?? `${local}${unit}`}</span>
      </div>
      <input
        type="range" min={min} max={max} value={local}
        onChange={(e) => onInput(Number(e.target.value))}
        {...guard}
        style={{
          touchAction: "pan-y",
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
  const [local, onInput, guard] = useThrottledControl(kelvin, onChange, throttleMs);
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 12, color: "#94a3b8", fontWeight: 500 }}>{label}</span>
        <span style={{ fontSize: 12, color: "#e2e8f0", fontWeight: 600 }}>{local}K</span>
      </div>
      <input
        type="range" min={min} max={max} step={50} value={local}
        onChange={(e) => onInput(Number(e.target.value))}
        {...guard}
        style={{
          touchAction: "pan-y",
          width: "100%", height: 10, appearance: "none", borderRadius: 5,
          background: `linear-gradient(to right, rgb(${warm.r},${warm.g},${warm.b}), rgb(${mid.r},${mid.g},${mid.b}), rgb(${cool.r},${cool.g},${cool.b}))`,
          cursor: "pointer", outline: "none",
        }}
      />
    </div>
  );
}

// ─── Scene addressing toggle (v3.20.0) ──────────────────────────────────────
// Segments vs whole for ONE segmented Govee device. Rendered in two places —
// Settings → Govee Devices (where you set a light's default once) and each
// room's Scenes panel (where you flip it while building a look) — and both edit
// the SAME stored value, config `govee_scene_address`. It lives here rather than
// being written twice precisely so the two surfaces can't drift apart, which is
// the exact failure that made the scheduler and the scene tool disagree before
// v3.18.0.
//
// `value` is "segments" | "whole" | undefined; undefined means segments, the
// default for anything with more than one segment.
function SceneAddressToggle({ value, count, onChange, isMobile, small }) {
  const pad = small ? (isMobile ? "3px 8px" : "3px 10px") : (isMobile ? "5px 10px" : "5px 12px");
  const fs = small ? (isMobile ? 10 : 11) : (isMobile ? 11 : 12);
  return (
    <div style={{
      display: "inline-flex", gap: 4, background: "#0f172a",
      borderRadius: 6, padding: 2, flexShrink: 0,
    }}>
      {[["segments", "Segments"], ["whole", "Whole"]].map(([k, lbl]) => {
        const active = (value === "whole" ? "whole" : "segments") === k;
        return (
          <button key={k} onClick={() => onChange(k)}
            title={k === "segments"
              ? `Spread a scene's colors across its ${count || ""} segments`.replace("  ", " ")
              : "Give the whole device one color"}
            style={{
              padding: pad, borderRadius: 5, border: "none",
              background: active ? "#6366f1" : "transparent",
              color: active ? "#fff" : "#94a3b8",
              fontSize: fs, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
            }}>{lbl}</button>
        );
      })}
    </div>
  );
}

// ─── Device picker (shared by Assign Rooms and the Rooms tab, v3.26.0) ──────
// Multi-select list of devices with a confirm. It lived in room-assignment.js
// until the Rooms tab needed it too: a room created there had no way to get
// lights into it without a detour to another tab. Shared here rather than
// reached across files, because room-assignment.js loads AFTER room-section.js
// and depending upward would invert the script order index.html defines.
function DevicePickerModal({ title, devices, onSelect, onClose, nicknames }) {
  // The hook runs BEFORE the early return (v3.51.1). React counts hooks per
  // render, so when `devices` went empty while this modal was open — the last
  // unassigned light claimed from another tab, or an SSE refresh landing — the
  // early return skipped the useState, React threw "rendered fewer hooks than
  // expected", and with no error boundary the whole page went blank.
  const [selected, setSelected] = useState(new Set());
  if (devices.length === 0) return null;

  const toggle = (d) => {
    const key = d.type === "hue" ? `hue:${d.id}` : `govee:${goveeSlug(d)}`;
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const getKey = (d) => d.type === "hue" ? `hue:${d.id}` : `govee:${goveeSlug(d)}`;

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1000,
      background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: 16,
    }} onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#1e293b", borderRadius: 20, border: "1px solid #334155",
          width: "100%", maxWidth: 420, maxHeight: "80vh",
          display: "flex", flexDirection: "column",
        }}
      >
        <div style={{ padding: "20px 20px 12px", borderBottom: "1px solid #0f172a" }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, color: "#f1f5f9", margin: 0 }}>{title}</h3>
          <p style={{ fontSize: 12, color: "#64748b", margin: "4px 0 0" }}>
            Tap to select, then confirm.
          </p>
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: "12px 20px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {devices.map((d, i) => {
              const key = getKey(d);
              const isSelected = selected.has(key);
              const isHue = d.type === "hue";
              const { nickname, friendlyName } = getDeviceDisplayName(d, nicknames);
              const subtitle = isHue ? (d.product_name || d.model || "Hue") : (d.sku || d.ip);
              return (
                <button
                  key={`pick-${key}-${i}`}
                  onClick={() => toggle(d)}
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "12px 14px", borderRadius: 12, border: "none",
                    background: isSelected ? "rgba(99,102,241,0.15)" : "#0f172a",
                    outline: isSelected ? "2px solid #6366f1" : "1px solid #334155",
                    cursor: "pointer", textAlign: "left", width: "100%",
                    transition: "all 0.15s ease",
                  }}
                >
                  <div style={{
                    width: 22, height: 22, borderRadius: 6, flexShrink: 0,
                    border: isSelected ? "none" : "2px solid #475569",
                    background: isSelected ? "#6366f1" : "transparent",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 14, color: "#fff",
                  }}>
                    {isSelected ? "✓" : ""}
                  </div>
                  <div style={{
                    width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
                    background: isHue ? "#c084fc" : "#34d399",
                  }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {nickname && (
                      <div style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0" }}>{nickname}</div>
                    )}
                    <div style={{
                      fontSize: nickname ? 11 : 13, fontWeight: nickname ? 500 : 600,
                      color: nickname ? "#94a3b8" : "#e2e8f0",
                    }}>{friendlyName}</div>
                    <div style={{ fontSize: 10, color: "#64748b", marginTop: 1 }}>{subtitle}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
        <div style={{
          padding: "12px 20px 20px", borderTop: "1px solid #0f172a",
          display: "flex", gap: 8, justifyContent: "flex-end",
        }}>
          <button onClick={onClose} style={{
            padding: "10px 20px", borderRadius: 10, border: "1px solid #334155",
            background: "transparent", color: "#94a3b8", fontSize: 13,
            fontWeight: 600, cursor: "pointer",
          }}>Cancel</button>
          <button
            disabled={selected.size === 0}
            onClick={() => {
              const picked = devices.filter(d => selected.has(getKey(d)));
              onSelect(picked);
              onClose();
            }}
            style={{
              padding: "10px 20px", borderRadius: 10, border: "none",
              background: selected.size > 0 ? "#6366f1" : "#334155",
              color: selected.size > 0 ? "#fff" : "#64748b",
              fontSize: 13, fontWeight: 600,
              cursor: selected.size > 0 ? "pointer" : "default",
            }}
          >Add {selected.size > 0 ? `(${selected.size})` : ""}</button>
        </div>
      </div>
    </div>
  );
}