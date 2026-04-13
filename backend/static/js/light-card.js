// ─── Light Card Component ───────────────────────────────────────────────────

function LightCard({ light, onControl, favorites, onFavoritesChange, nicknames, onNicknameChange, roomName, segmentColors, segmentInfo }) {
  const isMobile = useIsMobile();
  const [brightness, setBrightness] = useState(
    light.type === "hue" ? Math.round((light.state?.brightness || 0) / 254 * 100) : (light.state?.brightness ?? 50)
  );
  const [lightColor, setLightColor] = useState(() => getInitialColor(light));
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");

  // Sync state when light prop changes (e.g. after refresh)
  useEffect(() => {
    setBrightness(
      light.type === "hue" ? Math.round((light.state?.brightness || 0) / 254 * 100) : (light.state?.brightness ?? 50)
    );
    const c = getInitialColor(light);
    if (c) setLightColor(c);
  }, [light.state?.on, light.state?.brightness, light.state?.hue, light.state?.saturation, light.state?.xy, light.state?.color?.r, light.state?.color?.g, light.state?.color?.b]);
  const isOn = light.state?.on ?? false;
  const isReachable = light.state?.reachable ?? true;
  const hasColor = light.capabilities?.has_color;

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
      background: "linear-gradient(135deg, #1e293b 0%, #0f172a 100%)",
      borderRadius: 16, padding: isMobile ? 14 : 20, border: "1px solid #334155",
      opacity: isReachable ? 1 : 0.5, transition: "all 0.2s ease",
    }}>
      {/* Header: name + toggle */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
        <div style={{ flex: 1, minWidth: 0, marginRight: 12 }}>
          {/* Nickname row */}
          {editing ? (
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
              <input
                type="text" value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") setEditing(false); }}
                placeholder="Enter a nickname..."
                autoFocus
                style={{
                  flex: 1, padding: "4px 8px", borderRadius: 6,
                  border: "1px solid #6366f1", background: "#0f172a",
                  color: "#f1f5f9", fontSize: 13, fontWeight: 600, outline: "none",
                  minWidth: 0,
                }}
              />
              <button onClick={saveEdit} style={{
                padding: "4px 8px", borderRadius: 6, border: "none",
                background: "#6366f1", color: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer",
              }}>Save</button>
              <button onClick={() => setEditing(false)} style={{
                padding: "4px 8px", borderRadius: 6, border: "1px solid #334155",
                background: "transparent", color: "#94a3b8", fontSize: 11, cursor: "pointer",
              }}>&#x2715;</button>
            </div>
          ) : nickname ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: "#f1f5f9" }}>{nickname}</span>
              <button onClick={startEdit} style={{
                background: "none", border: "none", cursor: "pointer",
                color: "#475569", fontSize: 11, padding: 0,
              }} title="Edit nickname">&#x270E;</button>
              <button onClick={clearNickname} style={{
                background: "none", border: "none", cursor: "pointer",
                color: "#475569", fontSize: 11, padding: 0,
              }} title="Remove nickname">&#x2715;</button>
            </div>
          ) : (
            <button
              onClick={startEdit}
              style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                padding: "3px 10px", borderRadius: 6, marginBottom: 4,
                border: "1px dashed #475569", background: "transparent",
                color: "#64748b", fontSize: 11, cursor: "pointer",
                transition: "all 0.15s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#6366f1"; e.currentTarget.style.color = "#a5b4fc"; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#475569"; e.currentTarget.style.color = "#64748b"; }}
            >
              <span>&#x270E;</span> Add nickname
            </button>
          )}
          {/* Friendly name (permanent, from SKU map) — smaller when nickname is set */}
          <div style={{ fontSize: nickname ? 12 : 14, fontWeight: nickname ? 500 : 600, color: nickname ? "#94a3b8" : "#f1f5f9" }}>{friendlyName}</div>
          {/* Model line (not editable) */}
          <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>
            {modelLine}
            {roomName && (
              <span style={{ color: "#6366f1", marginLeft: 6 }}>&middot; {roomName}</span>
            )}
          </div>
          {/* IP address */}
          {light.ip && (
            <div style={{ fontSize: 10, color: "#475569", marginTop: 1 }}>{light.ip}</div>
          )}
          {/* MAC address */}
          {light.mac && (
            <div style={{ fontSize: 10, color: "#475569", marginTop: 1 }}>{light.mac}</div>
          )}
        </div>
        <button
          onClick={() => onControl(light, { on: !isOn })}
          style={{
            width: 48, height: 28, borderRadius: 14, border: "none",
            background: isOn ? "#6366f1" : "#334155",
            cursor: "pointer", position: "relative", transition: "background 0.2s",
            flexShrink: 0, marginTop: 2,
          }}
        >
          <div style={{
            width: 22, height: 22, borderRadius: "50%", background: "#fff",
            position: "absolute", top: 3,
            left: isOn ? 23 : 3, transition: "left 0.2s ease",
          }} />
        </button>
      </div>
      {isOn && (
        <>
          <Slider
            label="Brightness" value={brightness} min={0} max={100}
            onChange={(v) => {
              setBrightness(v);
              if (light.type === "hue") {
                onControl(light, { brightness: Math.round(v * 254 / 100) });
              } else {
                onControl(light, { brightness: v });
              }
            }}
            color="#fbbf24" unit="%"
          />
          {hasColor && (
            <>
              {hasSegmentColors && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 10, color: "#64748b", marginBottom: 5 }}>Segment colors:</div>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {Array.from({ length: segCount }, (_, i) => {
                      const c = segmentColors[i];
                      return (
                        <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                          <div style={{
                            width: 20, height: 20, borderRadius: 4,
                            background: c ? `rgb(${c.r},${c.g},${c.b})` : "#1e293b",
                            border: "1px solid rgba(255,255,255,0.15)",
                          }} />
                          <span style={{ fontSize: 8, color: "#64748b" }}>
                            {String.fromCharCode(65 + i)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
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
            </>
          )}
        </>
      )}
    </div>
  );
}
