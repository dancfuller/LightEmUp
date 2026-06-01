// ─── Room Section ──────────────────────────────────────────────────────────

// Overlay control surface: a right-side drawer on desktop, a bottom sheet on
// mobile. Holds the per-room Lightning / Scenes / Controls / Debug panels so
// opening one no longer reflows the light-card grid below.
function ControlSurface({ view, views, onView, onClose, roomName, isMobile, children }) {
  if (!view) return null;

  const tabs = (
    <div style={{
      display: "flex", gap: 4, background: "#0a0f1e", borderRadius: 10,
      padding: 4, border: "1px solid #1e293b", marginBottom: 18, flexWrap: "wrap",
    }}>
      {views.map(t => (
        <button key={t.key} onClick={() => onView(t.key)} style={{
          flex: "1 1 auto", padding: "8px 6px", borderRadius: 7, border: "none", cursor: "pointer",
          background: view === t.key ? "rgba(99,102,241,0.18)" : "transparent",
          color: view === t.key ? t.accent : "#94a3b8", fontSize: 12, fontWeight: 700,
          whiteSpace: "nowrap",
        }}>{t.label}</button>
      ))}
    </div>
  );

  const header = (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
      <div style={{ fontSize: 12, color: "#64748b", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.6 }}>{roomName}</div>
      <button onClick={onClose} style={{
        background: "none", border: "none", color: "#64748b",
        fontSize: 24, cursor: "pointer", lineHeight: 1, padding: "0 4px",
      }} title="Close">&#x00D7;</button>
    </div>
  );

  // MOBILE: bottom sheet sliding up.
  if (isMobile) {
    return (
      <div onClick={onClose} style={{
        position: "fixed", inset: 0, zIndex: 200, background: "rgba(2,6,15,0.6)",
        display: "flex", alignItems: "flex-end",
      }}>
        <div onClick={(e) => e.stopPropagation()} style={{
          width: "100%", maxHeight: "88%", overflowY: "auto",
          background: "linear-gradient(180deg, #0f172a 0%, #0a0f1e 100%)",
          borderTop: "1px solid #334155", borderRadius: "20px 20px 0 0", padding: 18,
          boxShadow: "0 -20px 60px rgba(0,0,0,0.6)", animation: "sheetUp 0.25s ease",
        }}>
          <div style={{ width: 40, height: 4, borderRadius: 2, background: "#334155", margin: "0 auto 14px" }} />
          {header}
          {tabs}
          {children}
        </div>
      </div>
    );
  }

  // DESKTOP: right drawer.
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 200, background: "rgba(2,6,15,0.55)",
      display: "flex", justifyContent: "flex-end",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: 460, maxWidth: "100%", height: "100%", overflowY: "auto",
        background: "linear-gradient(180deg, #0f172a 0%, #0a0f1e 100%)",
        borderLeft: "1px solid #334155", padding: 22,
        boxShadow: "-20px 0 60px rgba(0,0,0,0.5)", animation: "drawerIn 0.25s ease",
      }}>
        {header}
        {tabs}
        {children}
      </div>
    </div>
  );
}

function RoomSection({ name, hueLights, goveeDevices, onControlHue, onControlGovee, onControlRoom, favorites, onFavoritesChange, nicknames, onNicknameChange, lightningActive, onLightningStart, onLightningStop, segmentInfo, segmentState, onSegmentStateRefresh, deviceModes, onDeviceModeChange, onDeviceModesBulkChange, segmentFillModes, onSegmentFillModeChange, roomLayouts, onLayoutChange, fixtures, onFixtureUpsert, onFixtureDelete, minSatEnabled, minSatPct, savedColorState }) {
  const isMobile = useIsMobile();
  const [collapsed, setCollapsed] = useState(true);
  // Single overlay surface state — replaces the old per-panel show* booleans.
  // null | "lightning" | "scenes" | "controls" | "debug"
  const [surfaceView, setSurfaceView] = useState(null);
  // Map lives inside the Controls panel as a collapsible subsection.
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

  // Tabs available in the control surface. Debug only appears when there is a
  // segment-capable device to debug.
  const views = [
    { key: "lightning", label: lightningActive ? "⚡ Storm" : "⚡ Lightning", accent: "#fbbf24" },
    { key: "scenes", label: "Scenes", accent: "#34d399" },
    { key: "controls", label: "Controls", accent: "#a5b4fc" },
  ];
  if (anySegmented) views.push({ key: "debug", label: "Debug", accent: "#fbbf24" });

  const applyRoomBrightness = (val) => {
    setRoomBrightness(val);
    onControlRoom(name, { on: true, brightness: val });
  };

  const applyRoomColor = (r, g, b) => {
    setRoomColor({ r, g, b });
    onControlRoom(name, { on: true, r, g, b });
  };

  // Opener button in the room header (sets the surface view).
  const openerBtn = (key, label, accent, dashed) => (
    <button
      onClick={() => setSurfaceView(key)}
      style={{
        padding: isMobile ? "6px 12px" : "6px 16px", borderRadius: 8,
        border: dashed ? "1px dashed #475569" : "1px solid #334155",
        background: "transparent", color: accent,
        fontSize: isMobile ? 11 : 12, fontWeight: 700, cursor: "pointer",
        whiteSpace: "nowrap", transition: "all 0.2s",
      }}
    >{label}</button>
  );

  // Room-level controls panel (override + brightness + color + map).
  const controlsPanel = (
    <div>
      {/* Collapsible Map subsection */}
      <div style={{ marginBottom: 16, border: "1px solid #1e293b", borderRadius: 12, overflow: "hidden" }}>
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
          <span style={{ fontSize: 11, transform: mapExpanded ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 0.15s" }}>&#x25BC;</span>
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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 8, flexWrap: "wrap" }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#a5b4fc", textTransform: "uppercase", letterSpacing: 0.8 }}>
          Override all lights in {name}
        </div>
        <button
          onClick={() => onControlRoom(name, { on: !anyOn })}
          style={{
            width: 48, height: 28, borderRadius: 14, border: "none",
            background: anyOn ? "#6366f1" : "#334155",
            cursor: "pointer", position: "relative", transition: "background 0.2s", flexShrink: 0,
          }}
          title={anyOn ? "Turn all off" : "Turn all on"}
        >
          <div style={{ width: 22, height: 22, borderRadius: "50%", background: "#fff", position: "absolute", top: 3, left: anyOn ? 23 : 3, transition: "left 0.2s ease" }} />
        </button>
      </div>

      <Slider
        label="Room Brightness" value={roomBrightness} min={0} max={100}
        onChange={applyRoomBrightness} color="#fbbf24" unit="%"
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
  );

  // Resolve the active panel for the surface.
  let panel = null;
  if (surfaceView === "lightning") {
    panel = (
      <LightningPanel
        roomName={name}
        isActive={lightningActive}
        onStart={onLightningStart}
        onStop={onLightningStop}
        goveeDevices={goveeDevices}
        segmentInfo={segmentInfo}
      />
    );
  } else if (surfaceView === "scenes") {
    panel = (
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
        segmentFillModes={segmentFillModes}
        savedColorState={savedColorState}
        onApply={(applied, addressMode, colorStateSnapshot) => {
          setColorModeApplied(applied);
          if (colorStateSnapshot) {
            api("/room-color-state", {
              method: "POST",
              body: JSON.stringify({ room_name: name, ...colorStateSnapshot }),
            }).catch(e => console.warn("[RoomSection] color-state save failed:", e));
          }
          if (onSegmentStateRefresh) {
            setTimeout(onSegmentStateRefresh, 5000);
          }
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
    );
  } else if (surfaceView === "controls") {
    panel = controlsPanel;
  } else if (surfaceView === "debug") {
    panel = (
      <SegmentResetDebug
        roomName={name}
        goveeDevices={goveeDevices}
        segmentInfo={segmentInfo}
      />
    );
  }

  return (
    <div style={{ marginBottom: 32 }}>
      {/* Room header — name row, then a row of surface-opener buttons. */}
      <div style={{ display: "flex", flexDirection: "column", marginBottom: 4, paddingBottom: 12, borderBottom: "1px solid #1e293b", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div
            onClick={() => setCollapsed(!collapsed)}
            style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", userSelect: "none", flex: 1, minWidth: 0 }}
          >
            <span style={{ fontSize: 14, color: "#64748b", transition: "transform 0.2s", transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)", display: "inline-block" }}>&#x25BC;</span>
            <h2 style={{ fontSize: isMobile ? 17 : 20, fontWeight: 700, color: "#f8fafc", margin: 0 }}>{name}</h2>
            <span style={{ fontSize: 12, color: "#64748b" }}>
              {allLights.length} {allLights.length === 1 ? "light" : "lights"}
              {totalSegments > 0 && <> &middot; {totalSegments} segments</>}
            </span>
          </div>
          <button
            onClick={() => onControlRoom(name, { on: !anyOn })}
            style={{
              padding: isMobile ? "8px 16px" : "9px 20px", borderRadius: 10, border: "none",
              background: anyOn ? "#334155" : "#6366f1",
              color: anyOn ? "#94a3b8" : "#fff", fontSize: 13, fontWeight: 700,
              boxShadow: anyOn ? "none" : "0 2px 10px rgba(99,102,241,0.35)",
              cursor: "pointer", transition: "all 0.2s", whiteSpace: "nowrap",
            }}
          >
            {anyOn ? "Turn Off" : "Turn On"}
          </button>
        </div>

        {/* Surface openers */}
        <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 6 : 8, flexWrap: "wrap" }}>
          {openerBtn("lightning", lightningActive ? "⚡ Storm" : "⚡ Lightning", lightningActive ? "#fbbf24" : "#94a3b8")}
          {openerBtn("scenes", "Scenes", "#34d399")}
          {openerBtn("controls", "Controls", "#a5b4fc")}
          {anySegmented && openerBtn("debug", "Debug", "#64748b", true)}
        </div>
      </div>

      {/* Light-card grid — renders independently of the control surface. */}
      {!collapsed && (
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fill, minmax(260px, 1fr))", gap: 12, marginTop: 18 }}>
          {allLights.map((light, i) => {
            const devKey = light.type === "hue" ? `hue:${light.id}` : `govee:${light.ip}`;
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
                segmentFillMode={segmentFillModes?.[devKey]}
                onSegmentFillModeChange={(m) => onSegmentFillModeChange && onSegmentFillModeChange(devKey, m)}
              />
            );
          })}
        </div>
      )}

      <ControlSurface
        view={surfaceView} views={views}
        onView={setSurfaceView} onClose={() => setSurfaceView(null)}
        roomName={name} isMobile={isMobile}
      >
        {panel}
      </ControlSurface>
    </div>
  );
}
