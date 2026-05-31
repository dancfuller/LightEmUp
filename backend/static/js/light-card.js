// ─── Light Card Component ───────────────────────────────────────────────────

function LightCard({ light, onControl, favorites, onFavoritesChange, nicknames, onNicknameChange, roomName, segmentColors, segmentInfo, segmentBrightness, onSegmentStateRefresh, controlMode, onControlModeChange, segmentFillMode, onSegmentFillModeChange }) {
  const isMobile = useIsMobile();
  const deviceBrightness = light.type === "hue"
    ? Math.round((light.state?.brightness || 0) / 254 * 100)
    : (light.state?.brightness ?? 50);
  // When the device is in segment mode, the device's own brightness state
  // is meaningless (razer packets carry brightness inline as RGB scale).
  // Prefer the server-stored segment brightness so the slider reflects
  // what the segments are actually showing.
  const initialBrightness = segmentBrightness != null ? segmentBrightness : deviceBrightness;
  const [brightness, setBrightness] = useState(initialBrightness);
  const [lightColor, setLightColor] = useState(() => getInitialColor(light));
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  // controlMode comes from the parent (persisted per device_key). Falls
  // back to "segments" when the server already has segment state for this
  // device, else "whole". The toggle is purely a UI switch — flipping it
  // doesn't push anything to the device. The device only changes when
  // the user actually adjusts a control.
  const supportsSegments = light.type !== "hue" && (segmentInfo?.sku_table?.[light.sku]?.count || 0) > 0;
  const hasInitialSegmentState = segmentColors && Object.keys(segmentColors).length > 0;
  const effectiveMode = controlMode || (hasInitialSegmentState ? "segments" : "whole");
  const setControlMode = (m) => onControlModeChange && onControlModeChange(m);
  const [selectedSegment, setSelectedSegment] = useState(0);
  const [showInfo, setShowInfo] = useState(false);
  // Color vs tunable-white control. Default "color" (color-first UX).
  const [colorMode, setColorMode] = useState("color");
  // Seed the white slider from the device's reported CT when available.
  const seededKelvin = (() => {
    const ct = light.state?.color_temp;
    if (light.type === "hue") return ct ? Math.round(1000000 / ct) : 2700; // mireds → K
    return ct && ct > 0 ? ct : 2700; // Govee reports Kelvin directly
  })();
  const [whiteKelvin, setWhiteKelvin] = useState(seededKelvin);

  // Sync state when light prop or segment brightness changes
  useEffect(() => {
    setBrightness(segmentBrightness != null ? segmentBrightness : deviceBrightness);
    const c = getInitialColor(light);
    if (c) setLightColor(c);
  }, [light.state?.on, light.state?.brightness, light.state?.hue, light.state?.saturation, light.state?.xy, light.state?.color?.r, light.state?.color?.g, light.state?.color?.b, segmentBrightness]);
  const isOn = light.state?.on ?? false;
  const isReachable = light.state?.reachable ?? true;
  const hasColor = light.capabilities?.has_color;
  // Any color light can offer a White (color-temperature) mode. Lights with
  // native tunable white (Hue extended-color, Govee LAN) send a true CT command;
  // color-only lights (e.g. Hue "color lamp") approximate white via RGB.
  const supportsCT = hasColor;
  const nativeCT = light.type === "hue"
    ? !!light.capabilities?.has_color_temp
    : hasColor; // most Govee LAN color devices accept colorTemInKelvin

  // Segment display: show a per-segment color strip when segment colors have been applied
  const configuredSegCount = light.ip && segmentInfo?.configured_counts?.[light.ip];
  const skuSegCount = light.sku && segmentInfo?.sku_table?.[light.sku]?.count;
  const segCount = configuredSegCount || skuSegCount || 0;
  const hasSegmentColors = segCount > 0 && segmentColors && Object.keys(segmentColors).length > 0;

  const deviceKey = light.type === "hue" ? `hue:${light.id}` : `govee:${light.ip}`;
  const nickname = nicknames?.[deviceKey] || "";
  const friendlyName = light.type === "hue"
    ? (light.product_name || light.name || light.model || `Light ${light.id}`)
    : (GOVEE_SKU_NAMES[light.sku] || light.name || light.sku || "Govee Device");
  const modelLine = light.type === "hue"
    ? `Hue · ${light.product_name || light.model}`
    : `Govee · ${light.sku}`;
  const displayName = nickname || friendlyName;
  const dotColor = (hasColor && lightColor)
    ? `rgb(${lightColor.r},${lightColor.g},${lightColor.b})`
    : "#fbbf24";

  const startEdit = () => {
    setEditValue(nickname);
    setEditing(true);
  };

  const saveEdit = () => {
    const val = editValue.trim();
    if (onNicknameChange) {
      onNicknameChange(deviceKey, val);
    }
    setEditing(false);
  };

  const clearNickname = () => {
    if (onNicknameChange) {
      onNicknameChange(deviceKey, "");
    }
  };

  return (
    <div style={{
      background: isOn
        ? "linear-gradient(135deg, #2c3a55 0%, #1a2438 100%)"
        : "linear-gradient(135deg, #0c1322 0%, #060a14 100%)",
      borderRadius: 16, padding: isMobile ? 14 : 20,
      border: isOn ? "1px solid #4f5d7a" : "1px solid #1e293b",
      boxShadow: isOn ? "0 0 0 1px rgba(99,102,241,0.18), 0 6px 18px rgba(99,102,241,0.10)" : "none",
      opacity: isReachable ? 1 : 0.5, transition: "all 0.2s ease",
    }}>
      {/* Slim header: status dot + display name + power toggle */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <span style={{
          width: 12, height: 12, borderRadius: "50%", flexShrink: 0,
          background: isOn ? dotColor : "#1e293b",
          boxShadow: isOn ? `0 0 8px ${dotColor}` : "none",
          border: isOn ? "none" : "1px solid #334155",
        }} />
        <div style={{
          flex: 1, minWidth: 0, fontSize: 14, fontWeight: 700,
          color: isOn ? "#f8fafc" : "#94a3b8",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>{displayName}</div>
        {!isReachable && (
          <span style={{ fontSize: 9, color: "#f87171", fontWeight: 700, textTransform: "uppercase", flexShrink: 0 }}>offline</span>
        )}
        <button
          onClick={() => onControl(light, { on: !isOn })}
          style={{
            width: 44, height: 26, borderRadius: 13, border: "none", flexShrink: 0,
            background: isOn ? "#6366f1" : "#334155",
            cursor: "pointer", position: "relative", transition: "background 0.2s",
          }}
        >
          <div style={{
            width: 20, height: 20, borderRadius: "50%", background: "#fff",
            position: "absolute", top: 3, left: isOn ? 21 : 3, transition: "left 0.2s ease",
          }} />
        </button>
      </div>

      {/* Whole / Segments mode toggle — outside the isOn gate so the user
          can switch modes while the light is off (e.g. set up segments
          before turning the device on). */}
      {supportsSegments && hasColor && (
        <div style={{
          display: "flex", gap: 4, marginBottom: 8,
          background: "#0f172a", borderRadius: 8, padding: 3,
          border: "1px solid #1e293b",
        }}>
          {["whole", "segments"].map(m => (
            <button
              key={m}
              onClick={() => setControlMode(m)}
              style={{
                flex: 1, padding: "6px 10px", borderRadius: 6, border: "none",
                background: effectiveMode === m ? "#6366f1" : "transparent",
                color: effectiveMode === m ? "#fff" : "#94a3b8",
                fontSize: 11, fontWeight: 600, cursor: "pointer",
              }}
            >{m === "whole" ? "Whole light" : "Segments"}</button>
          ))}
        </div>
      )}

      {/* Scene fill — controls how room scenes paint this device's
          segments. Only meaningful when in Segments mode. */}
      {supportsSegments && hasColor && effectiveMode === "segments" && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 10, color: "#64748b", marginBottom: 4 }}>Scene fill:</div>
          <div style={{
            display: "flex", gap: 3, background: "#0f172a", borderRadius: 8,
            padding: 3, border: "1px solid #1e293b",
          }}>
            {[
              { key: "follow", label: "Follow", title: "Each segment follows the scene's per-segment color" },
              { key: "solid", label: "Solid", title: "All segments are the same color from the scene" },
              { key: "shades", label: "Shades", title: "All segments are shades of one scene color" },
            ].map(opt => {
              const active = (segmentFillMode || "follow") === opt.key;
              return (
                <button key={opt.key}
                  onClick={() => onSegmentFillModeChange && onSegmentFillModeChange(opt.key)}
                  title={opt.title}
                  style={{
                    flex: 1, padding: "5px 8px", borderRadius: 5, border: "none",
                    background: active ? "#6366f1" : "transparent",
                    color: active ? "#fff" : "#94a3b8",
                    fontSize: 10, fontWeight: 600, cursor: "pointer",
                  }}
                >{opt.label}</button>
              );
            })}
          </div>
        </div>
      )}

      <Slider
            label="Brightness" value={brightness} min={0} max={100}
            onChange={(v) => {
              setBrightness(v);
              if (light.type === "hue") {
                onControl(light, { brightness: Math.round(v * 254 / 100) });
              } else if (effectiveMode === "segments" && supportsSegments) {
                // Segment mode: scale segment colors via the segments
                // brightness endpoint so per-segment colors are preserved.
                api("/govee/segments-brightness", {
                  method: "POST",
                  body: JSON.stringify({
                    ip: light.ip, sku: light.sku, brightness: v,
                    device_mac: light.mac,
                  }),
                  headers: { "Content-Type": "application/json" },
                }).catch(e => console.warn("[LightCard] segments-brightness failed:", e));
              } else {
                // Whole-light mode: standard LAN brightness. This clears
                // server segment state via the control endpoint.
                onControl(light, { brightness: v });
              }
            }}
            color="#fbbf24" unit="%"
          />

          {hasColor && effectiveMode === "whole" && (
            <div>
              {supportsCT && (
                <div style={{
                  display: "flex", gap: 4, marginBottom: 10,
                  background: "#0f172a", borderRadius: 6, padding: 3,
                }}>
                  {[
                    { key: "color", label: "Color" },
                    { key: "white", label: "White" },
                  ].map(opt => {
                    const active = colorMode === opt.key;
                    return (
                      <button key={opt.key}
                        onClick={() => setColorMode(opt.key)}
                        style={{
                          flex: 1, padding: "5px 8px", borderRadius: 5, border: "none",
                          background: active ? "#6366f1" : "transparent",
                          color: active ? "#fff" : "#94a3b8",
                          fontSize: 11, fontWeight: 600, cursor: "pointer",
                        }}
                      >{opt.label}</button>
                    );
                  })}
                </div>
              )}
              {colorMode === "white" && supportsCT ? (
                <ColorTempSlider
                  kelvin={whiteKelvin}
                  onChange={(k) => {
                    setWhiteKelvin(k);
                    if (!nativeCT) {
                      const rgb = kelvinToRGB(k);
                      setLightColor(rgb);
                      onControl(light, { on: true, ...rgb });
                    } else if (light.type === "hue") {
                      onControl(light, { on: true, color_temp: kelvinToMired(k) });
                    } else {
                      onControl(light, { on: true, color_temp_kelvin: k });
                    }
                  }}
                />
              ) : (
                <ColorPicker
                  size={130}
                  compact={true}
                  currentColor={lightColor}
                  onColorSelect={(r, g, b) => {
                    setLightColor({ r, g, b });
                    onControl(light, { r, g, b });
                  }}
                  favorites={favorites}
                  onFavoritesChange={onFavoritesChange}
                />
              )}
            </div>
          )}

          {hasColor && effectiveMode === "segments" && supportsSegments && (
            <div>
              <div style={{ fontSize: 10, color: "#64748b", marginBottom: 6 }}>
                Tap a segment to edit, then pick a color below
              </div>
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 10 }}>
                {Array.from({ length: segCount }, (_, i) => {
                  const c = segmentColors?.[i];
                  const isSel = i === selectedSegment;
                  return (
                    <button key={i}
                      onClick={() => setSelectedSegment(i)}
                      style={{
                        display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
                        background: "transparent", border: "none", cursor: "pointer", padding: 0,
                      }}
                    >
                      <div style={{
                        width: 26, height: 26, borderRadius: 6,
                        background: c ? `rgb(${c.r},${c.g},${c.b})` : "#1e293b",
                        border: isSel ? "2px solid #a5b4fc" : "1px solid rgba(255,255,255,0.15)",
                        boxShadow: isSel ? "0 0 8px rgba(165,180,252,0.55)" : "none",
                        transition: "all 0.12s",
                      }} />
                      <span style={{
                        fontSize: 9, fontWeight: isSel ? 700 : 500,
                        color: isSel ? "#a5b4fc" : "#64748b",
                      }}>
                        {String.fromCharCode(65 + i)}
                      </span>
                    </button>
                  );
                })}
              </div>
              <ColorPicker
                size={130}
                compact={true}
                currentColor={segmentColors?.[selectedSegment] || lightColor}
                onColorSelect={(r, g, b) => {
                  api("/govee/segment-control", {
                    method: "POST",
                    body: JSON.stringify({
                      ip: light.ip, sku: light.sku, device_mac: light.mac,
                      segment_idx: selectedSegment, r, g, b,
                    }),
                    headers: { "Content-Type": "application/json" },
                  })
                    .then(() => onSegmentStateRefresh && onSegmentStateRefresh())
                    .catch(e => console.warn("[LightCard] segment-control failed:", e));
                }}
                favorites={favorites}
                onFavoritesChange={onFavoritesChange}
              />
            </div>
          )}

      {/* Details disclosure: model/IP/MAC metadata + nickname editing,
          tucked away so the card stays slim by default. */}
      <button
        onClick={() => setShowInfo(!showInfo)}
        style={{
          marginTop: 12, background: "none", border: "none", cursor: "pointer", padding: 0,
          color: "#475569", fontSize: 10, fontWeight: 600,
          display: "flex", alignItems: "center", gap: 4,
        }}
      >
        <span style={{ transform: showInfo ? "rotate(90deg)" : "none", transition: "transform .15s", display: "inline-block" }}>&#x25B8;</span>
        {light.type === "hue" ? "Hue" : "Govee"} details
      </button>
      {showInfo && (
        <div style={{ marginTop: 8, borderTop: "1px solid rgba(51,65,85,0.5)", paddingTop: 8 }}>
          {/* Nickname editor */}
          {editing ? (
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}>
              <input
                type="text" value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") setEditing(false); }}
                placeholder="Enter a nickname..."
                autoFocus
                style={{
                  flex: 1, padding: "4px 8px", borderRadius: 6,
                  border: "1px solid #6366f1", background: "#0f172a",
                  color: "#f1f5f9", fontSize: 13, fontWeight: 600, outline: "none", minWidth: 0,
                }}
              />
              <button onClick={saveEdit} style={{
                padding: "4px 8px", borderRadius: 6, border: "none",
                background: "#6366f1", color: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer",
              }}>Save</button>
              <button onClick={() => setEditing(false)} style={{
                padding: "4px 10px", borderRadius: 6, border: "1px solid #ef4444",
                background: "transparent", color: "#ef4444", fontSize: 16, fontWeight: 700,
                lineHeight: 1, cursor: "pointer",
              }}>&#x2715;</button>
            </div>
          ) : nickname ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 11, color: "#64748b" }}>Nickname:</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: "#f1f5f9" }}>{nickname}</span>
              <button onClick={startEdit} style={{
                background: "none", border: "none", cursor: "pointer",
                color: "#94a3b8", fontSize: 14, lineHeight: 1, padding: "0 2px",
              }} title="Edit nickname">&#x270E;</button>
              <button onClick={clearNickname} style={{
                background: "none", border: "none", cursor: "pointer",
                color: "#64748b", fontSize: 14, fontWeight: 700, lineHeight: 1, padding: "0 2px",
              }} title="Remove nickname">&#x2715;</button>
            </div>
          ) : (
            <button
              onClick={startEdit}
              style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                padding: "3px 10px", borderRadius: 6, marginBottom: 8,
                border: "1px dashed #475569", background: "transparent",
                color: "#64748b", fontSize: 11, cursor: "pointer",
              }}
            >
              <span>&#x270E;</span> Add nickname
            </button>
          )}
          {/* Permanent friendly name + model line */}
          <div style={{ fontSize: 12, fontWeight: 600, color: "#cbd5e1" }}>{friendlyName}</div>
          <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>
            {modelLine}
            {roomName && <span style={{ color: "#6366f1", marginLeft: 6 }}>&middot; {roomName}</span>}
          </div>
          {light.ip && <div style={{ fontSize: 10, color: "#475569", marginTop: 1, fontFamily: "monospace" }}>{light.ip}</div>}
          {light.mac && <div style={{ fontSize: 10, color: "#475569", marginTop: 1, fontFamily: "monospace" }}>{light.mac}</div>}
        </div>
      )}
    </div>
  );
}
