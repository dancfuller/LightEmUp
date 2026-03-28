// ─── Room Section ──────────────────────────────────────────────────────────

function RoomSection({ name, hueLights, goveeDevices, onControlHue, onControlGovee, onControlRoom, favorites, onFavoritesChange, nicknames, onNicknameChange, lightningActive, onLightningStart, onLightningStop, segmentInfo, roomLayouts, onLayoutChange }) {
  const [collapsed, setCollapsed] = useState(false);
  const [showRoomControls, setShowRoomControls] = useState(false);
  const [showLightning, setShowLightning] = useState(false);
  const [showMap, setShowMap] = useState(false);
  const [roomBrightness, setRoomBrightness] = useState(75);
  const [roomColor, setRoomColor] = useState(null);

  const allLights = [
    ...hueLights.map(l => ({ ...l, _controlFn: onControlHue })),
    ...goveeDevices.map(d => ({ ...d, _controlFn: onControlGovee })),
  ];
  const anyOn = allLights.some(l => l.state?.on);
  const anyColor = allLights.some(l => l.capabilities?.has_color);

  const applyRoomBrightness = (val) => {
    setRoomBrightness(val);
    onControlRoom(name, { on: true, brightness: val });
  };

  const applyRoomColor = (r, g, b) => {
    setRoomColor({ r, g, b });
    onControlRoom(name, { on: true, r, g, b });
  };

  return (
    <div style={{ marginBottom: 32 }}>
      {/* Room header */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        marginBottom: 4, paddingBottom: 12, borderBottom: "1px solid #1e293b",
      }}>
        <div
          onClick={() => setCollapsed(!collapsed)}
          style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", userSelect: "none" }}
        >
          <span style={{ fontSize: 14, color: "#64748b", transition: "transform 0.2s", transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)", display: "inline-block" }}>&#x25BC;</span>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: "#f8fafc", margin: 0 }}>{name}</h2>
          <span style={{ fontSize: 12, color: "#64748b" }}>{allLights.length} lights</span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            onClick={() => { setShowLightning(!showLightning); if (!showLightning) setShowRoomControls(false); }}
            style={{
              padding: "6px 14px", borderRadius: 8, border: "1px solid #334155",
              background: showLightning || lightningActive ? "rgba(251,191,36,0.15)" : "transparent",
              color: showLightning || lightningActive ? "#fbbf24" : "#94a3b8",
              fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "all 0.2s",
            }}
          >
            &#x26A1; {lightningActive ? "Storm" : "Lightning"}
          </button>
          <button
            onClick={() => { setShowMap(!showMap); if (!showMap) { setShowLightning(false); setShowRoomControls(false); } }}
            style={{
              padding: "6px 14px", borderRadius: 8, border: "1px solid #334155",
              background: showMap ? "rgba(52,211,153,0.15)" : "transparent",
              color: showMap ? "#34d399" : "#94a3b8",
              fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "all 0.2s",
            }}
          >
            Map
          </button>
          <button
            onClick={() => { setShowRoomControls(!showRoomControls); if (!showRoomControls) setShowLightning(false); }}
            style={{
              padding: "6px 14px", borderRadius: 8, border: "1px solid #334155",
              background: showRoomControls ? "rgba(99,102,241,0.15)" : "transparent",
              color: showRoomControls ? "#a5b4fc" : "#94a3b8",
              fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "all 0.2s",
            }}
          >
            Room Controls
          </button>
          <button
            onClick={() => onControlRoom(name, { on: !anyOn })}
            style={{
              padding: "6px 16px", borderRadius: 8, border: "none",
              background: anyOn ? "#334155" : "#6366f1",
              color: "#f1f5f9", fontSize: 12, fontWeight: 600,
              cursor: "pointer", transition: "all 0.2s",
            }}
          >
            {anyOn ? "All Off" : "All On"}
          </button>
        </div>
      </div>

      {!collapsed && (<React.Fragment>
        {/* Lightning panel */}
        {showLightning && (
          <LightningPanel
            roomName={name}
            isActive={lightningActive}
            onStart={onLightningStart}
            onStop={onLightningStop}
            goveeDevices={goveeDevices}
            segmentInfo={segmentInfo}
          />
        )}

        {/* Room-level controls panel */}
        {showRoomControls && (
          <div style={{
            background: "linear-gradient(135deg, #1e293b 0%, #172033 100%)",
            borderRadius: 16, padding: 20, marginBottom: 16,
            border: "1px solid #334155",
          }}>
            <div style={{
              fontSize: 12, fontWeight: 600, color: "#a5b4fc", marginBottom: 14,
              textTransform: "uppercase", letterSpacing: 0.8,
            }}>
              Override all lights in {name}
            </div>

            <Slider
              label="Room Brightness" value={roomBrightness} min={0} max={100}
              onChange={applyRoomBrightness}
              color="#fbbf24" unit="%"
            />

            {anyColor && (
              <div style={{ marginTop: 4 }}>
                <ColorPicker
                  size={160}
                  currentColor={roomColor}
                  onColorSelect={applyRoomColor}
                  favorites={favorites}
                  onFavoritesChange={onFavoritesChange}
                />
              </div>
            )}
          </div>
        )}

        {/* Room Map */}
        {showMap && (
          <RoomMap
            roomName={name}
            hueLights={hueLights} goveeDevices={goveeDevices}
            onControlHue={onControlHue} onControlGovee={onControlGovee}
            favorites={favorites} onFavoritesChange={onFavoritesChange}
            nicknames={nicknames} onNicknameChange={onNicknameChange}
            segmentInfo={segmentInfo}
            roomLayouts={roomLayouts} onLayoutChange={onLayoutChange}
          />
        )}

        {/* Individual light cards */}
        {!showMap && (
          <div style={{
            display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12,
          }}>
            {allLights.map((light, i) => (
              <LightCard
                key={`${light.type}-${light.id || light.ip}-${i}`}
                light={light}
                onControl={(l, cmd) => l._controlFn(l, cmd)}
                favorites={favorites}
                onFavoritesChange={onFavoritesChange}
                nicknames={nicknames}
                onNicknameChange={onNicknameChange}
              />
            ))}
          </div>
        )}
      </React.Fragment>)}
    </div>
  );
}
