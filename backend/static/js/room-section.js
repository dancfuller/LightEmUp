// ─── Room Section ──────────────────────────────────────────────────────────

function RoomSection({ name, hueLights, goveeDevices, onControlHue, onControlGovee, onControlRoom, favorites, onFavoritesChange, nicknames, onNicknameChange, lightningActive, onLightningStart, onLightningStop, segmentInfo, segmentState, onSegmentStateRefresh, deviceModes, onDeviceModeChange, onDeviceModesBulkChange, roomLayouts, onLayoutChange, fixtures, onFixtureUpsert, onFixtureDelete, minSatEnabled, minSatPct }) {
  const isMobile = useIsMobile();
  const [collapsed, setCollapsed] = useState(true);
  const [showRoomControls, setShowRoomControls] = useState(false);
  const [showLightning, setShowLightning] = useState(false);
  const [showColor, setShowColor] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  // Map moved inside Room Controls as a collapsible subsection, default
  // closed. The Map tab in the header was removed for de-cluttering.
  const [mapExpanded, setMapExpanded] = useState(false);
  const [roomBrightness, setRoomBrightness] = useState(75);
  const [roomColor, setRoomColor] = useState(null);
  const [colorModeApplied, setColorModeApplied] = useState(null);

  const allLights = [
    ...hueLights.map(l => ({ ...l, _controlFn: onControlHue })),
    ...goveeDevices.map(d => ({ ...d, _controlFn: onControlGovee })),
  ];
  const anyOn = allLights.some(l => l.state?.on);
  const anyColor = allLights.some(l => l.capabilities?.has_color);
  const segmentCountFor = (d) => {
    const configured = segmentInfo?.configured_counts?.[d.ip];
    const skuCount = segmentInfo?.sku_table?.[d.sku]?.count;
    return configured || skuCount || 1;
  };
  const anySegmented = goveeDevices.some(d => segmentCountFor(d) > 1);
  const totalSegments = goveeDevices.reduce((s, d) => {
    const c = segmentCountFor(d);
    return c > 1 ? s + c : s;
  }, 0);

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
        flexWrap: "wrap", gap: 8,
      }}>
        <div
          onClick={() => setCollapsed(!collapsed)}
          style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", userSelect: "none" }}
        >
          <span style={{ fontSize: 14, color: "#64748b", transition: "transform 0.2s", transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)", display: "inline-block" }}>&#x25BC;</span>
          <h2 style={{ fontSize: isMobile ? 17 : 20, fontWeight: 700, color: "#f8fafc", margin: 0 }}>{name}</h2>
          <span style={{ fontSize: 12, color: "#64748b" }}>
            {allLights.length} {allLights.length === 1 ? "light" : "lights"}
            {totalSegments > 0 && <> &middot; {totalSegments} segments</>}
          </span>
        </div>
        <div style={{ display: "flex", gap: isMobile ? 6 : 8, alignItems: "center", flexWrap: "wrap" }}>
          <button
            onClick={() => { const opening = !showLightning; setShowLightning(opening); if (opening) { setCollapsed(false); setShowRoomControls(false); } }}
            style={{
              padding: isMobile ? "6px 10px" : "6px 14px", borderRadius: 8, border: "1px solid #334155",
              background: showLightning || lightningActive ? "rgba(251,191,36,0.15)" : "transparent",
              color: showLightning || lightningActive ? "#fbbf24" : "#94a3b8",
              fontSize: isMobile ? 11 : 12, fontWeight: 600, cursor: "pointer", transition: "all 0.2s",
              whiteSpace: "nowrap",
            }}
          >
            &#x26A1; {lightningActive ? "Storm" : (isMobile ? "" : "Lightning")}
          </button>
          <button
            onClick={() => { const opening = !showColor; setShowColor(opening); if (opening) { setCollapsed(false); setShowLightning(false); setShowRoomControls(false); } }}
            style={{
              padding: isMobile ? "6px 10px" : "6px 14px", borderRadius: 8, border: "1px solid #334155",
              background: showColor ? "rgba(52,211,153,0.15)" : "transparent",
              color: showColor ? "#34d399" : "#94a3b8",
              fontSize: isMobile ? 11 : 12, fontWeight: 600, cursor: "pointer", transition: "all 0.2s",
              whiteSpace: "nowrap",
            }}
          >
            Color
          </button>
          <button
            onClick={() => { const opening = !showRoomControls; setShowRoomControls(opening); if (opening) { setCollapsed(false); setShowLightning(false); } }}
            style={{
              padding: isMobile ? "6px 10px" : "6px 14px", borderRadius: 8, border: "1px solid #334155",
              background: showRoomControls ? "rgba(99,102,241,0.15)" : "transparent",
              color: showRoomControls ? "#a5b4fc" : "#94a3b8",
              fontSize: isMobile ? 11 : 12, fontWeight: 600, cursor: "pointer", transition: "all 0.2s",
              whiteSpace: "nowrap",
            }}
          >
            {isMobile ? "Controls" : "Room Controls"}
          </button>
          {anySegmented && (
            <button
              onClick={() => { const opening = !showDebug; setShowDebug(opening); if (opening) { setCollapsed(false); setShowLightning(false); setShowRoomControls(false); setShowColor(false); } }}
              title="Segment reset debug — compare V1 LAN vs V2 reset strategies"
              style={{
                padding: isMobile ? "6px 10px" : "6px 14px", borderRadius: 8, border: "1px dashed #475569",
                background: showDebug ? "rgba(251,191,36,0.15)" : "transparent",
                color: showDebug ? "#fbbf24" : "#64748b",
                fontSize: isMobile ? 11 : 12, fontWeight: 600, cursor: "pointer", transition: "all 0.2s",
                whiteSpace: "nowrap",
              }}
            >
              Debug
            </button>
          )}
          <button
            onClick={() => onControlRoom(name, { on: !anyOn })}
            style={{
              padding: isMobile ? "6px 12px" : "6px 16px", borderRadius: 8, border: "none",
              background: anyOn ? "#334155" : "#6366f1",
              color: "#f1f5f9", fontSize: isMobile ? 11 : 12, fontWeight: 600,
              cursor: "pointer", transition: "all 0.2s",
              whiteSpace: "nowrap",
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
            {/* Collapsible Map subsection — first item, collapsed by default. */}
            <div style={{
              marginBottom: mapExpanded ? 16 : 12,
              border: "1px solid #1e293b", borderRadius: 12, overflow: "hidden",
            }}>
              <button
                onClick={() => setMapExpanded(!mapExpanded)}
                style={{
                  width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "10px 14px", background: mapExpanded ? "rgba(52,211,153,0.10)" : "transparent",
                  border: "none", cursor: "pointer", color: mapExpanded ? "#34d399" : "#94a3b8",
                  fontSize: 12, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase",
                }}
              >
                <span>Map</span>
                <span style={{
                  fontSize: 11, transform: mapExpanded ? "rotate(0deg)" : "rotate(-90deg)",
                  transition: "transform 0.15s",
                }}>&#x25BC;</span>
              </button>
              {mapExpanded && (
                <div style={{ padding: 12, borderTop: "1px solid #1e293b" }}>
                  <RoomMap
                    roomName={name}
                    segmentState={segmentState}
                    hueLights={hueLights} goveeDevices={goveeDevices}
                    onControlHue={onControlHue} onControlGovee={onControlGovee}
                    favorites={favorites} onFavoritesChange={onFavoritesChange}
                    nicknames={nicknames} onNicknameChange={onNicknameChange}
                    segmentInfo={segmentInfo}
                    roomLayouts={roomLayouts} onLayoutChange={onLayoutChange}
                    appliedColors={colorModeApplied}
                    fixtures={fixtures}
                    onFixtureUpsert={onFixtureUpsert}
                    onFixtureDelete={onFixtureDelete}
                  />
                </div>
              )}
            </div>

            {/* Override header + on/off toggle */}
            <div style={{
              display: "flex", justifyContent: "space-between", alignItems: "center",
              marginBottom: 14, gap: 8, flexWrap: "wrap",
            }}>
              <div style={{
                fontSize: 12, fontWeight: 600, color: "#a5b4fc",
                textTransform: "uppercase", letterSpacing: 0.8,
              }}>
                Override all lights in {name}
              </div>
              <button
                onClick={() => onControlRoom(name, { on: !anyOn })}
                style={{
                  width: 48, height: 28, borderRadius: 14, border: "none",
                  background: anyOn ? "#6366f1" : "#334155",
                  cursor: "pointer", position: "relative", transition: "background 0.2s",
                  flexShrink: 0,
                }}
                title={anyOn ? "Turn all off" : "Turn all on"}
              >
                <div style={{
                  width: 22, height: 22, borderRadius: "50%", background: "#fff",
                  position: "absolute", top: 3,
                  left: anyOn ? 23 : 3, transition: "left 0.2s ease",
                }} />
              </button>
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

        {/* Segment reset debug */}
        {showDebug && (
          <SegmentResetDebug
            roomName={name}
            goveeDevices={goveeDevices}
            segmentInfo={segmentInfo}
          />
        )}

        {/* Color Mode */}
        {showColor && (
          <ColorMode
            roomName={name}
            hueLights={hueLights} goveeDevices={goveeDevices}
            onControlHue={onControlHue} onControlGovee={onControlGovee}
            favorites={favorites} onFavoritesChange={onFavoritesChange}
            nicknames={nicknames}
            segmentInfo={segmentInfo}
            roomLayouts={roomLayouts}
            fixtures={fixtures}
            minSatEnabled={minSatEnabled}
            minSatPct={minSatPct}
            onApply={(applied, addressMode) => {
              setColorModeApplied(applied);
              // After the apply pipeline finishes (~4-15s depending on
              // device mix), pull fresh segment state so other views
              // (room map, page reload) reflect what the server stored.
              if (onSegmentStateRefresh) {
                setTimeout(onSegmentStateRefresh, 5000);
              }
              // Sync each segmented device's per-light mode to match the
              // scene's addressSegments choice. Without this, the user
              // would have to manually flip every LightCard toggle to
              // match what they just applied at the room level.
              if (addressMode && onDeviceModesBulkChange) {
                const targetMode = addressMode === "individual" ? "segments" : "whole";
                const updates = {};
                goveeDevices.forEach(d => {
                  const segCount = segmentInfo?.sku_table?.[d.sku]?.count || 0;
                  if (segCount > 1) updates[`govee:${d.ip}`] = targetMode;
                });
                if (Object.keys(updates).length > 0) {
                  onDeviceModesBulkChange(updates);
                }
              }
            }}
          />
        )}

        {/* Individual light cards — always visible when the room is open;
            Map now lives inside Room Controls. */}
        <div style={{
          display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fill, minmax(260px, 1fr))", gap: 12,
        }}>
            {allLights.map((light, i) => {
              const devKey = light.type === "hue" ? `hue:${light.id}` : `govee:${light.ip}`;
              // Merge: this-session apply (colorModeApplied) takes precedence
              // over the server's persistent state, since the user just
              // pressed Apply and may not have re-fetched state yet.
              const segColors = {};
              const persistedEntry = light.ip && segmentState ? segmentState[light.ip] : null;
              if (persistedEntry?.colors) {
                Object.entries(persistedEntry.colors).forEach(([k, v]) => {
                  segColors[parseInt(k)] = v;
                });
              }
              if (colorModeApplied) {
                Object.entries(colorModeApplied).forEach(([k, v]) => {
                  const m = k.match(/^(.+):seg(\d+)$/);
                  if (m && m[1] === devKey) segColors[parseInt(m[2])] = v;
                });
              }
              return (
                <LightCard
                  key={`${light.type}-${light.id || light.ip}-${i}`}
                  light={light}
                  onControl={(l, cmd) => {
                    l._controlFn(l, cmd);
                    // A whole-device color/on-off command clears server
                    // segment state; refresh so the strip disappears.
                    if (l.type === "govee" && onSegmentStateRefresh &&
                        (cmd.r !== undefined || cmd.on === false)) {
                      setTimeout(onSegmentStateRefresh, 200);
                    }
                  }}
                  favorites={favorites}
                  onFavoritesChange={onFavoritesChange}
                  nicknames={nicknames}
                  onNicknameChange={onNicknameChange}
                  segmentInfo={segmentInfo}
                  segmentColors={Object.keys(segColors).length > 0 ? segColors : null}
                  segmentBrightness={persistedEntry?.brightness}
                  onSegmentStateRefresh={onSegmentStateRefresh}
                  controlMode={deviceModes?.[devKey]}
                  onControlModeChange={(m) => onDeviceModeChange && onDeviceModeChange(devKey, m)}
                />
              );
            })}
        </div>
      </React.Fragment>)}
    </div>
  );
}
