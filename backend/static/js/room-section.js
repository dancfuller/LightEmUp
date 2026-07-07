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

function RoomSection({ name, hueLights, goveeDevices, onControlHue, onControlGovee, onControlRoom, favorites, onFavoritesChange, nicknames, onNicknameChange, lightningActive, onLightningStart, onLightningStop, segmentInfo, segmentState, onSegmentStateRefresh, deviceModes, onDeviceModeChange, onDeviceModesBulkChange, segmentFillModes, onSegmentFillModeChange, roomLayouts, onLayoutChange, fixtures, onFixtureUpsert, onFixtureDelete, minSatEnabled, minSatPct, savedColorState, ctCorrection }) {
  const isMobile = useIsMobile();
  const [collapsed, setCollapsed] = useState(true);
  // Single overlay surface state — replaces the old per-panel show* booleans.
  // null | "lightning" | "scenes" | "controls" | "debug"
  const [surfaceView, setSurfaceView] = useState(null);
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
    const configured = segmentInfo?.configured_counts?.[goveeSlug(d)];
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
  // "Room Map" is a real room (has a layout handler) with at least one device —
  // the pseudo-"Unassigned" group has neither, so it gets no map.
  const canMap = typeof RoomMap === "function" && !!onLayoutChange && allLights.length > 0;
  const views = [
    { key: "lightning", label: lightningActive ? "⚡ Storm" : "⚡ Lightning", accent: "#fbbf24" },
    { key: "scenes", label: "Scenes", accent: "#34d399" },
    { key: "controls", label: "Controls", accent: "#a5b4fc" },
  ];
  if (canMap) views.push({ key: "map", label: "🗺 Room Map", accent: "#22d3ee" });
  if (anySegmented) views.push({ key: "debug", label: "Debug", accent: "#fbbf24" });

  const applyRoomBrightness = (val) => {
    setRoomBrightness(val);
    onControlRoom(name, { on: true, brightness: val });
  };

  const applyRoomColor = (r, g, b) => {
    setRoomColor({ r, g, b });
    onControlRoom(name, { on: true, r, g, b });
  };

  // Per-room white quick-actions. Turn THIS room on at a fixed color temperature.
  // These replace the old global "All On" buttons — you rarely want to light the
  // whole house/outside, but "warm up this room" / "cool white this room" is a
  // genuinely useful one-tap. Fans out client-side per device so each vendor gets
  // its native command (Hue mireds, Govee kelvin → server-side ct_rgb calibration).
  // Cool White is effectively an "emergency / brightest" mode → 6500K daylight.
  // Both shortcuts force full brightness. Brightness scale is vendor-specific:
  // Hue's `bri` is 1–254, Govee's is 0–100, so 100% is 254 vs 100 respectively.
  const SOFT_WHITE_K = 2700, COOL_WHITE_K = 6500;
  const setRoomWhite = (kelvin) => {
    hueLights.forEach(l => onControlHue(l, { on: true, brightness: 254, color_temp: kelvinToMired(kelvin) }));
    goveeDevices.forEach(d => onControlGovee(d, { on: true, brightness: 100, color_temp_kelvin: kelvin }));
  };
  const whiteBtn = (label, kelvin, fg, bg, border) => (
    <button
      onClick={() => setRoomWhite(kelvin)}
      title={`Turn this room on at ${kelvin}K, full brightness`}
      style={{
        padding: isMobile ? "6px 12px" : "6px 16px", borderRadius: 8,
        border: `1px solid ${border}`, background: bg, color: fg,
        fontSize: isMobile ? 11 : 12, fontWeight: 700, cursor: "pointer",
        whiteSpace: "nowrap", transition: "all 0.2s",
      }}
    >{label}</button>
  );

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

  // Room map is now its own first-class surface view ("Room Map" opener), not a
  // buried collapsible inside Controls — the layout was too hidden.
  const roomMapEl = (
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
  );

  // Room-level controls panel (override + brightness + color).
  const controlsPanel = (
    <div>
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
              if (segCount > 1) updates[`govee:${goveeSlug(d)}`] = targetMode;
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
  } else if (surfaceView === "map") {
    panel = roomMapEl;
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
          {/* On/off is a toggle switch, not a "Turn Off" button — the old button
              looked greyed-out (disabled) exactly when the lights were ON. The
              switch's position + color show the current state; tapping flips all. */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: anyOn ? "#e2e8f0" : "#64748b", whiteSpace: "nowrap" }}>
              {anyOn ? "On" : "Off"}
            </span>
            <button
              onClick={() => onControlRoom(name, { on: !anyOn })}
              title={anyOn ? "Turn all lights off" : "Turn all lights on"}
              style={{
                width: 48, height: 28, borderRadius: 14, border: "none",
                background: anyOn ? "#6366f1" : "#334155", cursor: "pointer",
                position: "relative", transition: "background 0.2s", flexShrink: 0,
                boxShadow: anyOn ? "0 0 8px rgba(99,102,241,0.4)" : "none",
              }}
            >
              <div style={{ width: 22, height: 22, borderRadius: "50%", background: "#fff", position: "absolute", top: 3, left: anyOn ? 23 : 3, transition: "left 0.2s ease" }} />
            </button>
          </div>
        </div>

        {/* Surface openers + per-room white quick-actions */}
        <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 6 : 8, flexWrap: "wrap" }}>
          {openerBtn("lightning", lightningActive ? "⚡ Storm" : "⚡ Lightning", lightningActive ? "#fbbf24" : "#94a3b8")}
          {openerBtn("scenes", "Scenes", "#34d399")}
          {openerBtn("controls", "Controls", "#a5b4fc")}
          {canMap && openerBtn("map", "🗺 Room Map", "#22d3ee")}
          {anySegmented && openerBtn("debug", "Debug", "#64748b", true)}
          {allLights.length > 0 && (
            <>
              <span style={{ width: 1, height: 20, background: "#1e293b", margin: isMobile ? "0 2px" : "0 4px" }} />
              {whiteBtn(isMobile ? "☀ Soft" : "☀ Soft White", SOFT_WHITE_K, "#fcd34d", "rgba(251,191,36,0.12)", "rgba(251,191,36,0.4)")}
              {whiteBtn(isMobile ? "❄ Cool" : "❄ Cool White", COOL_WHITE_K, "#93c5fd", "rgba(96,165,250,0.12)", "rgba(96,165,250,0.4)")}
            </>
          )}
        </div>
      </div>

      {/* Light-card grid — renders independently of the control surface. */}
      {!collapsed && (
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fill, minmax(260px, 1fr))", gap: 12, marginTop: 18 }}>
          {allLights.map((light, i) => {
            const devKey = light.type === "hue" ? `hue:${light.id}` : `govee:${goveeSlug(light)}`;
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
                ctCorrection={ctCorrection}
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
