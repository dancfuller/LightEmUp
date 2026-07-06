// ─── Settings device row ─────────────────────────────────────────────────────
// One device line in Settings → Hue Bridge / Govee Devices. Shows status,
// display name, a Flash button to physically locate the device (POST
// /identify), and inline nickname editing (reuses the same nickname API as the
// light cards). `flashBody` is the /identify payload ({light_id} or {ip}); pass
// null to hide Flash (e.g. unreachable/missing devices).
function SettingsDeviceRow({ deviceKey, nickname, friendlyName, meta, statusColor, statusOpacity, statusLabel, flashBody, onNicknameChange, isMobile, dim, italicName, extra }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(nickname || "");
  const [flashing, setFlashing] = useState(false);
  const displayName = nickname || friendlyName;

  const startEdit = () => { setVal(nickname || ""); setEditing(true); };
  const saveEdit = () => { onNicknameChange(deviceKey, val.trim()); setEditing(false); };
  const clearNick = () => { onNicknameChange(deviceKey, ""); setEditing(false); };

  const flash = async () => {
    if (!flashBody || flashing) return;
    setFlashing(true);
    try { await api("/identify", { method: "POST", body: JSON.stringify(flashBody) }); }
    catch (e) { console.error("Flash failed:", e); }
    finally { setFlashing(false); }
  };

  const btn = (label, onClick, opts = {}) => (
    <button onClick={onClick} disabled={opts.disabled} title={opts.title}
      style={{
        padding: "3px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600,
        border: `1px solid ${opts.border || "#334155"}`, background: "transparent",
        color: opts.disabled ? "#475569" : (opts.color || "#a5b4fc"),
        cursor: opts.disabled ? "wait" : "pointer", whiteSpace: "nowrap",
      }}>{label}</button>
  );

  return (
    <div style={{
      padding: "7px 0", borderBottom: "1px solid rgba(51,65,85,0.4)",
      opacity: dim ? 0.6 : 1,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{
          width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
          background: statusColor, opacity: statusOpacity ?? 0.8,
        }} />
        <span style={{ color: italicName ? "#94a3b8" : "#e2e8f0", fontStyle: italicName ? "italic" : "normal", fontWeight: 600, fontSize: 13, flex: "1 1 auto", minWidth: 0 }}>{displayName}</span>
        {statusLabel && (
          <span style={{ color: statusColor, fontSize: 10, flexShrink: 0 }}>{statusLabel}</span>
        )}
        {flashBody && btn(flashing ? "Flashing…" : "⚡ Flash", flash, { disabled: flashing, title: "Flash this light to locate it" })}
        {btn(nickname ? "✎ Rename" : "✎ Name", startEdit, { title: "Set a nickname" })}
        {extra}
      </div>
      {editing && (
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
          <input type="text" value={val} autoFocus
            onChange={(e) => setVal(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") setEditing(false); }}
            placeholder="Enter a nickname…"
            style={{
              flex: "1 1 160px", padding: "5px 9px", borderRadius: 6, minWidth: 0,
              border: "1px solid #6366f1", background: "#0f172a",
              color: "#f1f5f9", fontSize: 13, fontWeight: 600, outline: "none",
            }} />
          <button onClick={saveEdit} style={{ padding: "5px 10px", borderRadius: 6, border: "none", background: "#6366f1", color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Save</button>
          {nickname && <button onClick={clearNick} title="Remove nickname" style={{ padding: "5px 10px", borderRadius: 6, border: "1px solid #475569", background: "transparent", color: "#94a3b8", fontSize: 12, cursor: "pointer" }}>Clear</button>}
          <button onClick={() => setEditing(false)} style={{ padding: "5px 10px", borderRadius: 6, border: "1px solid #475569", background: "transparent", color: "#94a3b8", fontSize: 12, cursor: "pointer" }}>Cancel</button>
        </div>
      )}
      {meta && (
        <div style={{ color: "#475569", fontSize: 11, fontFamily: "monospace", marginTop: 3, marginLeft: 14 }}>{meta}</div>
      )}
    </div>
  );
}

// ─── Main App ───────────────────────────────────────────────────────────────

function App() {
  const isMobile = useIsMobile();
  const [config, setConfig] = useState(null);
  const [hueLights, setHueLights] = useState([]);
  const [hueGroups, setHueGroups] = useState([]);
  const [goveeDevices, setGoveeDevices] = useState([]);
  // missingGovee: devices we've seen before that are not in the latest scan.
  // Surfaced in Settings → Govee Devices as greyed-out rows with an X
  // (forget) button. Re-scan is the section's main Re-scan button.
  const [missingGovee, setMissingGovee] = useState([]);
  const [rescanning, setRescanning] = useState(false);
  const [rooms, setRooms] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState("rooms");
  const [newRoomName, setNewRoomName] = useState("");
  const [showHueSetup, setShowHueSetup] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [versionInfo, setVersionInfo] = useState(null);
  // Favorites live in backend config (loaded in loadAll); [] until then.
  const [favoriteColors, setFavoriteColors] = useState([]);
  const [nicknames, setNicknames] = useState({});
  const [refreshing, setRefreshing] = useState(false);
  const [lightningActiveRooms, setLightningActiveRooms] = useState([]);
  const [segmentInfo, setSegmentInfo] = useState({ sku_table: {}, configured_counts: {}, segment_mode: {} });
  // segmentState: server-side last-known per-segment colors for any Govee
  // device currently in segment mode. Shape: { ip: { segIdx: {r,g,b} } }.
  // Used by LightCard and RoomMap so the UI reflects segments instead of
  // showing a stale whole-device color.
  const [segmentState, setSegmentState] = useState({});
  const [roomLayouts, setRoomLayouts] = useState({});
  const [fixtures, setFixtures] = useState({});
  const [roomColorState, setRoomColorState] = useState({});
  const [ctCorrection, setCtCorrection] = useState({});
  // ctRgb: RGB-space white calibration (takes precedence over ctCorrection).
  const [ctRgb, setCtRgb] = useState({});
  // Union of both calibration types — drives the "calibrated" badge anywhere a
  // device name is shown (the kind of calibration doesn't matter for the badge).
  const ctCalibrated = { ...ctCorrection, ...ctRgb };
  // deviceModes: persisted LightCard preference per device_key.
  // "whole" or "segments". Loaded from config, updated on toggle.
  const [deviceModes, setDeviceModes] = useState({});
  // segmentFillModes: how each segment-mode device is filled by room
  // scenes — "follow" (default), "solid" (all segments one color), or
  // "shades" (tonal shades of one color). Persisted per device_key.
  const [segmentFillModes, setSegmentFillModes] = useState({});
  // pickerStyle: "huebar" (default) or "wheel". Provided via context to
  // every ColorPicker so the user's choice applies everywhere.
  const [pickerStyle, setPickerStyle] = useState("huebar");
  // Saturation floor for the generated-shade modes only (gradient, tonal), so
  // shades derived from one base color don't drift near-white. Explicit-color
  // modes (palette, custom, beacon, presets) apply verbatim. Default on at 35%.
  const [minSatEnabled, setMinSatEnabled] = useState(true);
  const [minSatPct, setMinSatPct] = useState(35);

  const updateFavorites = (newFavs) => {
    setFavoriteColors(newFavs);  // optimistic; backend is the source of truth
    api("/favorites", { method: "POST", body: JSON.stringify({ favorites: newFavs }) })
      .catch(e => console.warn("Failed to save favorites:", e));
  };

  const updateNickname = async (deviceKey, nickname) => {
    setNicknames(prev => ({ ...prev, [deviceKey]: nickname }));
    try {
      await api("/nicknames", {
        method: "POST",
        body: JSON.stringify({ device_key: deviceKey, nickname }),
      });
    } catch (e) {
      console.error("Failed to save nickname:", e);
    }
  };

  // Create an empty room from the Rooms tab. Persists immediately (the Rooms
  // tab has no separate Save step, unlike Assign Rooms). Returns true on
  // success so the caller can clear its input. Rejects blank/duplicate names.
  const addRoom = async (rawName) => {
    const name = (rawName || "").trim();
    if (!name || rooms[name]) return false;
    setRooms(prev => ({ ...prev, [name]: { hue_light_ids: [], govee_devices: [] } }));
    try {
      await api("/rooms", {
        method: "POST",
        body: JSON.stringify({ name, hue_light_ids: [], govee_devices: [] }),
      });
    } catch (e) {
      console.error("Failed to create room:", e);
    }
    return true;
  };

  const loadAll = useCallback(async () => {
    try {
      const cfg = await api("/config");
      setConfig(cfg);
      setRooms(cfg.rooms || {});
      setNicknames(cfg.nicknames || {});
      setRoomLayouts(cfg.room_layouts || {});
      setFixtures(cfg.fixtures || {});
      setRoomColorState(cfg.room_color_state || {});
      setCtCorrection(cfg.ct_correction || {});
      setCtRgb(cfg.ct_rgb || {});
      setDeviceModes(cfg.device_modes || {});
      setSegmentFillModes(cfg.segment_fill_modes || {});
      if (Array.isArray(cfg.favorites)) setFavoriteColors(cfg.favorites);
      setPickerStyle(cfg.ui_prefs?.color_picker_style === "wheel" ? "wheel" : "huebar");
      if (cfg.ui_prefs?.min_saturation_enabled !== undefined) {
        setMinSatEnabled(!!cfg.ui_prefs.min_saturation_enabled);
      }
      if (typeof cfg.ui_prefs?.min_saturation_pct === "number") {
        setMinSatPct(cfg.ui_prefs.min_saturation_pct);
      }

      const promises = [
        api("/discover/govee").catch(() => ({ devices: [] })),
        api("/scenes/lightning/status").catch(() => ({ active: [] })),
        api("/govee/segment-info").catch(() => ({ sku_table: {}, configured_counts: {}, segment_mode: {} })),
        api("/govee/segment-state").catch(() => ({ state: {} })),
      ];

      if (cfg.hue_paired) {
        promises.push(
          api("/hue/lights").catch(() => ({ lights: [] })),
          api("/hue/groups").catch(() => ({ groups: [] })),
        );
      }

      const results = await Promise.all(promises);
      // Devices arrive render-ready: the backend overlays the last color/temp it
      // set onto each Govee device (LAN devStatus doesn't report color reliably)
      // and returns segment state already in the UI's shape. The frontend just
      // paints what it's given — no client-side merging or reshaping.
      setGoveeDevices(results[0].devices || []);
      setMissingGovee(results[0].missing || []);
      setLightningActiveRooms(results[1].active || []);
      setSegmentInfo(results[2]);
      setSegmentState(results[3]?.state || {});

      if (cfg.hue_paired) {
        setHueLights(results[4]?.lights || []);
        setHueGroups(results[5]?.groups || []);
      }
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Live sync across open sessions. The server broadcasts lightweight
  // "what changed" signals over SSE; we don't trust the payload to carry
  // full state, we just refetch. Events tagged with our own CLIENT_ID are
  // ignored (we already applied them optimistically). A burst of events is
  // coalesced into one debounced loadAll() so rapid room/segment edits
  // elsewhere don't trigger a refetch storm here.
  const syncTimer = useRef(null);
  useEffect(() => {
    let es;
    try {
      es = new EventSource(`${API}/events`);
    } catch (e) {
      console.warn("SSE unavailable:", e);
      return;
    }
    es.onmessage = (e) => {
      let evt;
      try { evt = JSON.parse(e.data); } catch { return; }
      if (!evt) return;
      // Backend-driven scene apply: re-broadcast progress so the color panel
      // (any open session) can show it. Not a data change → no refetch here.
      if (evt.type === "scene_apply") {
        window.dispatchEvent(new CustomEvent("lightemup-scene-apply", { detail: evt }));
        return;
      }
      if (evt.source === CLIENT_ID) return;
      if (syncTimer.current) clearTimeout(syncTimer.current);
      syncTimer.current = setTimeout(() => { loadAll(); }, 400);
    };
    es.onerror = () => { /* EventSource auto-reconnects */ };
    return () => {
      if (syncTimer.current) clearTimeout(syncTimer.current);
      es.close();
    };
  }, [loadAll]);

  // Fetch version once on boot — cheap, doesn't change without a restart.
  useEffect(() => {
    api("/version").then(setVersionInfo).catch(() => {});
  }, []);

  const updatePickerStyle = useCallback(async (style) => {
    setPickerStyle(style);
    try {
      await api("/ui-prefs", {
        method: "POST",
        body: JSON.stringify({ color_picker_style: style }),
      });
    } catch (e) {
      console.warn("Failed to save picker style:", e);
    }
  }, []);

  const updateMinSat = useCallback(async (enabled, pct) => {
    setMinSatEnabled(enabled);
    setMinSatPct(pct);
    try {
      await api("/ui-prefs", {
        method: "POST",
        body: JSON.stringify({ min_saturation_enabled: enabled, min_saturation_pct: pct }),
      });
    } catch (e) {
      console.warn("Failed to save min saturation:", e);
    }
  }, []);

  const updateSegmentFillMode = useCallback(async (deviceKey, mode) => {
    setSegmentFillModes(prev => ({ ...prev, [deviceKey]: mode }));
    try {
      await api("/segment-fill-modes", {
        method: "POST",
        body: JSON.stringify({ device_key: deviceKey, mode }),
      });
    } catch (e) {
      console.warn("Failed to save segment fill mode:", e);
    }
  }, []);

  const updateDeviceMode = useCallback(async (deviceKey, mode) => {
    setDeviceModes(prev => ({ ...prev, [deviceKey]: mode }));
    try {
      await api("/device-modes", {
        method: "POST",
        body: JSON.stringify({ device_key: deviceKey, mode }),
      });
    } catch (e) {
      console.warn("Failed to save device mode:", e);
    }
  }, []);

  const updateDeviceModesBulk = useCallback(async (modes) => {
    if (!modes || Object.keys(modes).length === 0) return;
    setDeviceModes(prev => ({ ...prev, ...modes }));
    try {
      await api("/device-modes/bulk", {
        method: "POST",
        body: JSON.stringify({ modes }),
      });
    } catch (e) {
      console.warn("Failed to save device modes bulk:", e);
    }
  }, []);

  const rescanGovee = useCallback(async () => {
    setRescanning(true);
    try {
      const data = await api("/discover/govee");
      setGoveeDevices(data.devices || []);
      setMissingGovee(data.missing || []);
    } catch (e) {
      console.warn("Govee rescan failed:", e);
    } finally {
      setRescanning(false);
    }
  }, []);

  const forgetGoveeDevice = useCallback(async (mac) => {
    try {
      await api(`/govee/known/${encodeURIComponent(mac)}`, { method: "DELETE" });
      setMissingGovee(prev => prev.filter(d => d.mac !== mac));
    } catch (e) {
      console.warn("Failed to forget device:", e);
    }
  }, []);

  const refreshSegmentState = useCallback(async () => {
    try {
      const data = await api("/govee/segment-state");
      setSegmentState(data?.state || {});
    } catch (e) {
      console.warn("Failed to refresh segment state:", e);
    }
  }, []);

  // Reload segment info when toggled from LightningPanel
  useEffect(() => {
    const handler = () => {
      api("/govee/segment-info")
        .then(data => setSegmentInfo(data))
        .catch(() => {});
    };
    window.addEventListener("lightemup-reload-segments", handler);
    return () => window.removeEventListener("lightemup-reload-segments", handler);
  }, []);

  const startLightning = async (roomName) => {
    try {
      await api("/scenes/lightning/start", {
        method: "POST",
        body: JSON.stringify({ room_name: roomName }),
      });
      setLightningActiveRooms(prev => [...prev, roomName]);
    } catch (e) {
      console.error("Failed to start lightning:", e);
    }
  };

  const stopLightning = async (roomName) => {
    try {
      await api("/scenes/lightning/stop", {
        method: "POST",
        body: JSON.stringify({ room_name: roomName }),
      });
      setLightningActiveRooms(prev => prev.filter(r => r !== roomName));
    } catch (e) {
      console.error("Failed to stop lightning:", e);
    }
  };

  const refreshState = async () => {
    setRefreshing(true);
    try {
      await loadAll();
    } finally {
      setRefreshing(false);
    }
  };

  const controlHueLight = async (light, cmd) => {
    api("/hue/light", {
      method: "POST",
      body: JSON.stringify({ light_id: light.id, ...cmd }),
    }).catch(e => console.error("Hue control error:", e));
    setHueLights(prev => prev.map(l => {
      if (l.id === light.id) {
        const stateUpdate = {};
        if (cmd.on !== undefined) stateUpdate.on = cmd.on;
        if (cmd.brightness !== undefined) stateUpdate.brightness = cmd.brightness;
        if (cmd.r !== undefined) stateUpdate.color = { r: cmd.r, g: cmd.g, b: cmd.b };
        if (cmd.color_temp !== undefined) { stateUpdate.color_temp = cmd.color_temp; stateUpdate.color = null; }
        return { ...l, state: { ...l.state, ...stateUpdate } };
      }
      return l;
    }));
  };

  const controlGoveeDevice = async (device, cmd) => {
    api("/govee/control", {
      method: "POST",
      body: JSON.stringify({ ip: device.ip, mac: device.mac, ...cmd }),
    }).catch(e => console.error("Govee control error:", e));
    setGoveeDevices(prev => prev.map(d => {
      if (d.ip === device.ip) {
        const stateUpdate = {};
        if (cmd.on !== undefined) stateUpdate.on = cmd.on;
        if (cmd.brightness !== undefined) stateUpdate.brightness = cmd.brightness;
        if (cmd.r !== undefined) stateUpdate.color = { r: cmd.r, g: cmd.g, b: cmd.b };
        if (cmd.color_temp_kelvin !== undefined) { stateUpdate.color_temp = cmd.color_temp_kelvin; stateUpdate.color = null; }
        return { ...d, state: { ...d.state, ...stateUpdate } };
      }
      return d;
    }));
  };

  const controlRoom = async (roomName, cmd) => {
    // cmd can be { on: bool } or { on, brightness, r, g, b }
    api("/rooms/control", {
      method: "POST",
      body: JSON.stringify({ room_name: roomName, ...cmd }),
    }).catch(e => console.error("Room control error:", e));

    // Optimistic update for all devices in this room
    const room = rooms[roomName] || {};
    const hueIds = new Set(room.hue_light_ids || []);
    const goveeSlugs = new Set(room.govee_devices || []);

    if (hueIds.size > 0) {
      setHueLights(prev => prev.map(l => {
        if (!hueIds.has(l.id)) return l;
        const stateUpdate = {};
        if (cmd.on !== undefined) stateUpdate.on = cmd.on;
        if (cmd.brightness !== undefined) stateUpdate.brightness = Math.round(cmd.brightness * 254 / 100);
        return { ...l, state: { ...l.state, ...stateUpdate } };
      }));
    }

    if (goveeSlugs.size > 0) {
      setGoveeDevices(prev => prev.map(d => {
        if (!goveeSlugs.has(goveeSlug(d))) return d;
        const stateUpdate = {};
        if (cmd.on !== undefined) stateUpdate.on = cmd.on;
        if (cmd.brightness !== undefined) stateUpdate.brightness = cmd.brightness;
        if (cmd.r !== undefined) stateUpdate.color = { r: cmd.r, g: cmd.g, b: cmd.b };
        return { ...d, state: { ...d.state, ...stateUpdate } };
      }));
    }
  };

  const handleLayoutChange = (roomName, layout) => {
    setRoomLayouts(prev => ({ ...prev, [roomName]: layout }));
  };

  // Fixtures: each device_key belongs to at most one fixture. Optimistic
  // local update mirrors the backend's strip-from-other-fixtures behavior.
  // On failure we roll back so the UI matches disk and surface a banner —
  // a silent failure here is how fixtures vanished after a refresh before.
  const upsertFixture = async (fixtureId, name, members) => {
    let snapshot;
    setFixtures(prev => {
      snapshot = prev;
      const next = {};
      const incoming = new Set(members);
      Object.entries(prev).forEach(([fid, fix]) => {
        if (fid === fixtureId) return;
        const kept = (fix.members || []).filter(m => !incoming.has(m));
        if (kept.length > 0) next[fid] = { ...fix, members: kept };
      });
      next[fixtureId] = { name, members };
      return next;
    });
    try {
      await api("/fixtures", {
        method: "POST",
        body: JSON.stringify({ fixture_id: fixtureId, name, members }),
      });
    } catch (e) {
      console.error("Failed to save fixture:", e);
      setFixtures(snapshot);
      setError(`Failed to save fixture "${name}" — change rolled back. (${e.message})`);
    }
  };

  const deleteFixture = async (fixtureId) => {
    let snapshot;
    setFixtures(prev => {
      snapshot = prev;
      const next = { ...prev };
      delete next[fixtureId];
      return next;
    });
    try {
      await api(`/fixtures/${encodeURIComponent(fixtureId)}`, { method: "DELETE" });
    } catch (e) {
      console.error("Failed to delete fixture:", e);
      setFixtures(snapshot);
      const fixName = snapshot?.[fixtureId]?.name || fixtureId;
      setError(`Failed to delete fixture "${fixName}" — change rolled back. (${e.message})`);
    }
  };

  if (loading) {
    return (
      <div style={{
        minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
        background: "#0a0f1e", color: "#94a3b8", fontFamily: "'Geist', -apple-system, sans-serif",
      }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🔆</div>
          <div>Loading LightEmUp...</div>
        </div>
      </div>
    );
  }

  const getRoomLights = (roomName) => {
    const room = rooms[roomName] || {};
    return {
      hue: hueLights.filter(l => (room.hue_light_ids || []).includes(l.id)),
      govee: goveeDevices.filter(d => (room.govee_devices || []).includes(goveeSlug(d))),
    };
  };

  const unassignedHue = hueLights.filter(l => !Object.values(rooms).some(r => (r.hue_light_ids || []).includes(l.id)));
  const unassignedGovee = goveeDevices.filter(d => !Object.values(rooms).some(r => (r.govee_devices || []).includes(goveeSlug(d))));

  return (
    <PickerStyleContext.Provider value={pickerStyle}>
    <div style={{
      minHeight: "100vh",
      background: "linear-gradient(180deg, #0a0f1e 0%, #0f172a 50%, #0a0f1e 100%)",
      fontFamily: "'Geist', -apple-system, sans-serif", color: "#f8fafc",
    }}>
      <header style={{
        padding: isMobile ? "12px 14px" : "20px 24px", borderBottom: "1px solid #1e293b",
        display: "flex", justifyContent: "space-between", alignItems: "center",
        flexWrap: "wrap", gap: 8,
        position: "sticky", top: 0, background: "rgba(10,15,30,0.95)",
        backdropFilter: "blur(12px)", zIndex: 100,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 8 : 12 }}>
          <span style={{ fontSize: isMobile ? 22 : 28 }}>🔆</span>
          <h1 style={{ fontSize: isMobile ? 18 : 22, fontWeight: 800, margin: 0, letterSpacing: -0.5 }}>LightEmUp</h1>
          <button
            onClick={refreshState}
            disabled={refreshing}
            title="Refresh all device states"
            style={{
              width: 32, height: 32, borderRadius: "50%", border: "1px solid #334155",
              background: refreshing ? "rgba(99,102,241,0.15)" : "transparent",
              color: refreshing ? "#a5b4fc" : "#64748b",
              cursor: refreshing ? "default" : "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 16, transition: "all 0.2s",
              animation: refreshing ? "spin 1s linear infinite" : "none",
            }}
          >
            ↻
          </button>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button
            onClick={() => config?.hue_paired ? setActiveTab("settings") : setShowHueSetup(true)}
            style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              padding: "4px 12px", borderRadius: 20, border: "none", cursor: "pointer",
              background: config?.hue_paired ? "rgba(74,222,128,0.15)" : "rgba(248,113,113,0.15)",
              color: config?.hue_paired ? "#4ade80" : "#f87171",
              fontSize: 12, fontWeight: 600, letterSpacing: 0.5,
            }}
            title={config?.hue_paired ? "Hue Bridge connected" : "Click to set up Hue Bridge"}
          >
            <span style={{
              width: 7, height: 7, borderRadius: "50%",
              background: config?.hue_paired ? "#4ade80" : "#f87171",
              boxShadow: config?.hue_paired ? "0 0 6px #4ade80" : "none",
            }} />
            Hue {config?.hue_paired ? "" : "(Setup)"}
          </button>
          {(() => {
            // Three states for the Govee badge:
            //   missing > 0  → amber: some known devices didn't answer
            //   found > 0    → green: all known devices online
            //   none         → red:   nothing on the network
            const found = goveeDevices.length;
            const missing = missingGovee.length;
            const known = found + missing;
            const state = missing > 0 ? "missing" : (found > 0 ? "ok" : "none");
            const palette = {
              ok:      { bg: "rgba(74,222,128,0.15)",  fg: "#4ade80", dot: "#4ade80", glow: "0 0 6px #4ade80" },
              missing: { bg: "rgba(251,191,36,0.18)",  fg: "#fbbf24", dot: "#fbbf24", glow: "0 0 6px #fbbf24" },
              none:    { bg: "rgba(248,113,113,0.15)", fg: "#f87171", dot: "#f87171", glow: "none" },
            }[state];
            const label = state === "missing" ? `Govee (${found}/${known})` : `Govee (${found})`;
            const titleText = state === "missing"
              ? `${found} of ${known} known Govee devices online — ${missing} missing`
              : (state === "ok" ? `${found} Govee devices found` : "Click to open Govee settings");
            return (
              <button
                onClick={() => setActiveTab("settings")}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  padding: "4px 12px", borderRadius: 20, border: "none", cursor: "pointer",
                  background: palette.bg, color: palette.fg,
                  fontSize: 12, fontWeight: 600, letterSpacing: 0.5,
                }}
                title={titleText}
              >
                <span style={{
                  width: 7, height: 7, borderRadius: "50%",
                  background: palette.dot, boxShadow: palette.glow,
                  animation: state === "missing" ? "pulse 1.8s ease-in-out infinite" : "none",
                }} />
                {label}
                {state === "missing" && (
                  <span style={{
                    marginLeft: 2, padding: "0 6px", borderRadius: 8,
                    background: "rgba(251,191,36,0.25)", color: "#fbbf24",
                    fontSize: 10, fontWeight: 700,
                  }}>!{missing}</span>
                )}
              </button>
            );
          })()}
        </div>
      </header>

      <nav style={{ display: "flex", gap: 4, padding: isMobile ? "8px 10px" : "12px 24px", borderBottom: "1px solid #1e293b", flexWrap: "wrap", overflowX: "auto" }}>
        {["rooms", "all lights", "assign rooms", "settings"].map(tab => (
          <button
            key={tab} onClick={() => setActiveTab(tab)}
            style={{
              padding: isMobile ? "7px 12px" : "8px 20px", borderRadius: 8, border: "none",
              background: activeTab === tab ? "#6366f1" : "transparent",
              color: activeTab === tab ? "#fff" : "#64748b",
              fontSize: isMobile ? 12 : 13, fontWeight: 600, cursor: "pointer",
              textTransform: "capitalize", transition: "all 0.2s",
              whiteSpace: "nowrap",
            }}
          >{tab}</button>
        ))}
      </nav>

      <main style={{ padding: isMobile ? 12 : 24, maxWidth: 1200, margin: "0 auto" }}>
        {error && (
          <div style={{
            padding: 16, borderRadius: 12,
            background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.3)",
            color: "#f87171", marginBottom: 24,
          }}>{error}</div>
        )}

        {activeTab === "rooms" && (
          <>
            {/* Add-room control — top of the Rooms tab so a new room can be
                created without detouring through Assign Rooms. */}
            <div style={{
              display: "flex", gap: 8, marginBottom: isMobile ? 14 : 20,
              flexWrap: "wrap", alignItems: "center",
            }}>
              <input
                type="text" value={newRoomName}
                onChange={(e) => setNewRoomName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addRoom(newRoomName).then(ok => { if (ok) setNewRoomName(""); });
                }}
                placeholder="New room name…"
                style={{
                  flex: "1 1 200px", minWidth: 0,
                  padding: isMobile ? "9px 12px" : "10px 14px", borderRadius: 10,
                  border: "1px solid #334155", background: "#0f172a",
                  color: "#f1f5f9", fontSize: isMobile ? 14 : 14, outline: "none",
                }}
              />
              <button
                onClick={() => addRoom(newRoomName).then(ok => { if (ok) setNewRoomName(""); })}
                disabled={!newRoomName.trim() || !!rooms[newRoomName.trim()]}
                style={{
                  padding: isMobile ? "9px 16px" : "10px 20px", borderRadius: 10, border: "none",
                  background: (!newRoomName.trim() || !!rooms[newRoomName.trim()]) ? "#334155" : "#6366f1",
                  color: (!newRoomName.trim() || !!rooms[newRoomName.trim()]) ? "#64748b" : "#fff",
                  fontSize: isMobile ? 13 : 14, fontWeight: 600,
                  cursor: (!newRoomName.trim() || !!rooms[newRoomName.trim()]) ? "default" : "pointer",
                  whiteSpace: "nowrap",
                }}
              >+ Add Room</button>
              {!!newRoomName.trim() && !!rooms[newRoomName.trim()] && (
                <span style={{ fontSize: 12, color: "#f87171", flex: "1 1 100%" }}>
                  A room named "{newRoomName.trim()}" already exists.
                </span>
              )}
            </div>
            {Object.keys(rooms).map(roomName => {
              const { hue, govee } = getRoomLights(roomName);
              return (
                <RoomSection key={roomName} name={roomName}
                  hueLights={hue} goveeDevices={govee}
                  onControlHue={controlHueLight} onControlGovee={controlGoveeDevice}
                  onControlRoom={controlRoom}
                  favorites={favoriteColors} onFavoritesChange={updateFavorites}
                  nicknames={nicknames} onNicknameChange={updateNickname}
                  lightningActive={lightningActiveRooms.includes(roomName)}
                  onLightningStart={() => startLightning(roomName)}
                  onLightningStop={() => stopLightning(roomName)}
                  segmentInfo={segmentInfo}
                  segmentState={segmentState}
                  onSegmentStateRefresh={refreshSegmentState}
                  deviceModes={deviceModes}
                  onDeviceModeChange={updateDeviceMode}
                  onDeviceModesBulkChange={updateDeviceModesBulk}
                  segmentFillModes={segmentFillModes}
                  onSegmentFillModeChange={updateSegmentFillMode}
                  roomLayouts={roomLayouts}
                  onLayoutChange={handleLayoutChange}
                  fixtures={fixtures}
                  onFixtureUpsert={upsertFixture}
                  onFixtureDelete={deleteFixture}
                  minSatEnabled={minSatEnabled}
                  minSatPct={minSatPct}
                  savedColorState={roomColorState[roomName]}
                  ctCorrection={ctCalibrated}
                />
              );
            })}
            {(unassignedHue.length > 0 || unassignedGovee.length > 0) && (
              <RoomSection name="Unassigned"
                hueLights={unassignedHue} goveeDevices={unassignedGovee}
                onControlHue={controlHueLight} onControlGovee={controlGoveeDevice}
                onControlRoom={() => {}}
                favorites={favoriteColors} onFavoritesChange={updateFavorites}
                nicknames={nicknames} onNicknameChange={updateNickname}
                ctCorrection={ctCalibrated}
              />
            )}
          </>
        )}

        {activeTab === "all lights" && (() => {
          const deviceRoomMap = {};
          Object.entries(rooms).forEach(([rn, room]) => {
            (room.hue_light_ids || []).forEach(id => { deviceRoomMap[`hue:${id}`] = rn; });
            (room.govee_devices || []).forEach(slug => { deviceRoomMap[`govee:${slug}`] = rn; });
          });
          return (
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 }}>
              {hueLights.map(light => (
                <LightCard key={`hue-${light.id}`} light={light} onControl={controlHueLight}
                  favorites={favoriteColors} onFavoritesChange={updateFavorites}
                  nicknames={nicknames} onNicknameChange={updateNickname}
                  roomName={deviceRoomMap[`hue:${light.id}`]} />
              ))}
              {goveeDevices.map(device => {
                // Pass the same segment context the room view uses, so segmented
                // (hexa) lights stay in segment mode here. Without it the card
                // falls back to whole-light brightness, which can't take on a
                // device showing segments (needs a power-cycle) and wipes the
                // applied palette. With it, brightness scales segments in place.
                const devKey = `govee:${goveeSlug(device)}`;
                const persistedEntry = device.ip && segmentState ? segmentState[device.ip] : null;
                const segColors = {};
                if (persistedEntry?.colors) {
                  Object.entries(persistedEntry.colors).forEach(([k, v]) => { segColors[parseInt(k)] = v; });
                }
                return (
                  <LightCard key={`govee-${device.ip}`} light={device}
                    onControl={(l, cmd) => {
                      controlGoveeDevice(l, cmd);
                      if (refreshSegmentState && (cmd.r !== undefined || cmd.on === false)) {
                        setTimeout(refreshSegmentState, 200);
                      }
                    }}
                    favorites={favoriteColors} onFavoritesChange={updateFavorites}
                    nicknames={nicknames} onNicknameChange={updateNickname}
                    roomName={deviceRoomMap[devKey]}
                    segmentInfo={segmentInfo}
                    segmentColors={Object.keys(segColors).length > 0 ? segColors : null}
                    segmentBrightness={persistedEntry?.brightness}
                    onSegmentStateRefresh={refreshSegmentState}
                    controlMode={deviceModes?.[devKey]}
                    onControlModeChange={(m) => updateDeviceMode && updateDeviceMode(devKey, m)}
                    segmentFillMode={segmentFillModes?.[devKey]}
                    onSegmentFillModeChange={(m) => updateSegmentFillMode && updateSegmentFillMode(devKey, m)}
                    ctCorrection={ctCalibrated} />
                );
              })}
            </div>
          );
        })()}

        {activeTab === "assign rooms" && (
          <RoomAssignment
            hueLights={hueLights} goveeDevices={goveeDevices}
            rooms={rooms} onRoomsChange={setRooms}
            nicknames={nicknames} onNicknameChange={updateNickname}
            onControlHue={controlHueLight} onControlGovee={controlGoveeDevice}
            favorites={favoriteColors} onFavoritesChange={updateFavorites}
            segmentInfo={segmentInfo} segmentState={segmentState}
            roomLayouts={roomLayouts} onLayoutChange={handleLayoutChange}
            fixtures={fixtures} onFixtureUpsert={upsertFixture} onFixtureDelete={deleteFixture}
          />
        )}

        {activeTab === "settings" && (
          <div style={{ maxWidth: 700 }}>
            <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 20 }}>Configuration</h2>

            {/* Hue Bridge */}
            <div style={{ background: "#1e293b", borderRadius: 16, padding: 20, border: "1px solid #334155", marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <h3 style={{ fontSize: 15, fontWeight: 600, color: "#e2e8f0", margin: 0 }}>Hue Bridge</h3>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span style={{
                    display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, color: "#94a3b8",
                  }}>
                    <span style={{
                      width: 6, height: 6, borderRadius: "50%",
                      background: config?.hue_paired ? "#4ade80" : "#f87171",
                      boxShadow: config?.hue_paired ? "0 0 4px #4ade80" : "none",
                    }} />
                    {config?.hue_paired ? "Paired" : "Not paired"}
                  </span>
                  <button onClick={() => setShowHueSetup(true)}
                    style={{ padding: "4px 12px", borderRadius: 6, border: "1px solid #334155", background: "transparent", color: "#a5b4fc", fontSize: 11, fontWeight: 600, cursor: "pointer" }}
                  >{config?.hue_paired ? "Re-pair" : "Set up"}</button>
                </div>
              </div>
              <div style={{ fontSize: 12, color: "#64748b", marginBottom: 10 }}>
                IP: {config?.hue_bridge_ip || "Not found"}
                {config?.hue_username && <span style={{ marginLeft: 12 }}>User: {config.hue_username.slice(0, 12)}...</span>}
              </div>
              {hueLights.length > 0 ? (
                <div style={{ borderTop: "1px solid #334155", paddingTop: 10 }}>
                  <div style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
                    {hueLights.length} lights
                  </div>
                  {hueLights.map(light => {
                    const dk = `hue:${light.id}`;
                    const friendlyName = light.product_name || light.name || light.model || `Light ${light.id}`;
                    const model = light.product_name || light.model || "Unknown";
                    const reachable = light.state?.reachable !== false;
                    return (
                      <SettingsDeviceRow key={light.id}
                        deviceKey={dk} nickname={nicknames?.[dk]} friendlyName={friendlyName}
                        meta={`${model} · ID ${light.id}`}
                        statusColor={reachable ? "#4ade80" : "#f87171"}
                        statusOpacity={reachable ? 0.8 : 0.5}
                        statusLabel={reachable ? null : "unreachable"}
                        flashBody={reachable ? { light_id: String(light.id) } : null}
                        onNicknameChange={updateNickname} isMobile={isMobile}
                      />
                    );
                  })}
                </div>
              ) : config?.hue_paired ? (
                <div style={{ fontSize: 12, color: "#64748b", fontStyle: "italic" }}>No lights found — try refreshing</div>
              ) : null}
            </div>

            {/* Govee Devices */}
            <div style={{ background: "#1e293b", borderRadius: 16, padding: 20, border: "1px solid #334155", marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <h3 style={{ fontSize: 15, fontWeight: 600, color: "#e2e8f0", margin: 0 }}>Govee Devices</h3>
                <button
                  onClick={rescanGovee} disabled={rescanning}
                  style={{ padding: "4px 12px", borderRadius: 6, border: "1px solid #334155", background: "transparent", color: rescanning ? "#475569" : "#a5b4fc", fontSize: 11, fontWeight: 600, cursor: rescanning ? "wait" : "pointer" }}
                >{rescanning ? "Scanning…" : "Re-scan"}</button>
              </div>
              {(goveeDevices.length > 0 || missingGovee.length > 0) ? (
                <div>
                  <div style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
                    {goveeDevices.filter(d => d.responding !== false).length} responding via LAN
                    {missingGovee.length > 0 && (
                      <span style={{ color: "#f87171", marginLeft: 8 }}>· {missingGovee.length} not responding</span>
                    )}
                  </div>
                  {goveeDevices.filter(d => d.responding !== false).map(device => {
                    const dk = `govee:${goveeSlug(device)}`;
                    const friendlyName = GOVEE_SKU_NAMES[device.sku] || device.name || device.sku || "Unknown";
                    const meta = [device.sku, device.ip, device.mac].filter(Boolean).join(" · ");
                    return (
                      <SettingsDeviceRow key={device.ip}
                        deviceKey={dk} nickname={nicknames?.[dk]} friendlyName={friendlyName}
                        meta={meta}
                        statusColor="#4ade80" statusOpacity={0.8}
                        statusLabel={ctCalibrated?.[dk] ? "◐ calibrated" : null}
                        flashBody={{ ip: device.ip, mac: device.mac }}
                        onNicknameChange={updateNickname} isMobile={isMobile}
                      />
                    );
                  })}
                  {/* Missing devices — greyed out, red status dot, with
                      "X" (forget) and a re-scan affordance. */}
                  {missingGovee.map(device => {
                    const dk = `govee:${goveeSlug(device)}`;
                    const friendlyName = GOVEE_SKU_NAMES[device.sku] || device.name || device.sku || "Unknown";
                    const name = nicknames?.[dk] || friendlyName;
                    const meta = [device.sku, device.ip, (device.mac && device.mac !== device.ip) ? device.mac : null].filter(Boolean).join(" · ");
                    return (
                      <SettingsDeviceRow key={device.mac}
                        deviceKey={dk} nickname={nicknames?.[dk]} friendlyName={friendlyName}
                        meta={meta} italicName dim
                        statusColor="#f87171" statusOpacity={1} statusLabel="not responding"
                        flashBody={null}
                        onNicknameChange={updateNickname} isMobile={isMobile}
                        extra={
                          <>
                            <button onClick={rescanGovee} disabled={rescanning}
                              style={{ padding: "3px 9px", borderRadius: 6, border: "1px solid #334155", background: "transparent", color: rescanning ? "#475569" : "#a5b4fc", fontSize: 11, fontWeight: 600, cursor: rescanning ? "wait" : "pointer", whiteSpace: "nowrap" }}
                              title="Re-scan for this device">Re-scan</button>
                            <button onClick={() => { if (confirm(`Remove "${name}" from known devices? Re-scanning will bring it back if it comes online.`)) forgetGoveeDevice(device.mac); }}
                              style={{ padding: "3px 8px", borderRadius: 6, border: "1px solid #7f1d1d", background: "transparent", color: "#f87171", fontSize: 12, fontWeight: 700, cursor: "pointer", lineHeight: 1 }}
                              title="Forget this device">×</button>
                          </>
                        }
                      />
                    );
                  })}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: "#64748b", fontStyle: "italic" }}>No devices found — enable LAN Control in Govee Home app and re-scan</div>
              )}
            </div>

            <CTCalibrationPanel
              hueLights={hueLights} goveeDevices={goveeDevices}
              nicknames={nicknames} ctRgb={ctRgb}
              onControlHue={controlHueLight} onControlGovee={controlGoveeDevice}
              onSaved={setCtRgb}
            />

            {/* UI preferences */}
            <div style={{ background: "#1e293b", borderRadius: 16, padding: 20, border: "1px solid #334155", marginBottom: 16 }}>
              <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12, color: "#e2e8f0" }}>Interface</h3>
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <span style={{ fontSize: 12, color: "#94a3b8", fontWeight: 600 }}>Color selection:</span>
                <div style={{ display: "flex", gap: 4, background: "#0f172a", borderRadius: 8, padding: 3, border: "1px solid #1e293b" }}>
                  {[
                    { key: "huebar", label: "Hue Bar" },
                    { key: "wheel", label: "Color Wheel" },
                  ].map(opt => (
                    <button key={opt.key}
                      onClick={() => updatePickerStyle(opt.key)}
                      style={{
                        padding: "6px 12px", borderRadius: 6, border: "none",
                        background: pickerStyle === opt.key ? "#6366f1" : "transparent",
                        color: pickerStyle === opt.key ? "#fff" : "#94a3b8",
                        fontSize: 12, fontWeight: 600, cursor: "pointer",
                      }}
                    >{opt.label}</button>
                  ))}
                </div>
              </div>
              <div style={{ fontSize: 11, color: "#64748b", marginTop: 8 }}>
                Hue Bar is compact and skips low-saturation greys. Color Wheel covers the full HSL space if you need pastel/desaturated colors.
              </div>

              {/* Minimum saturation floor for generated colors */}
              <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid #1e293b" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12, color: "#94a3b8", fontWeight: 600 }}>Minimum saturation:</span>
                  <button
                    onClick={() => updateMinSat(!minSatEnabled, minSatPct)}
                    style={{
                      width: 40, height: 22, borderRadius: 11, border: "none",
                      background: minSatEnabled ? "#6366f1" : "#334155",
                      cursor: "pointer", position: "relative", transition: "background 0.2s",
                    }}
                    title={minSatEnabled ? "Disable saturation floor" : "Enable saturation floor"}
                  >
                    <div style={{
                      width: 16, height: 16, borderRadius: 8, background: "#fff",
                      position: "absolute", top: 3,
                      left: minSatEnabled ? 21 : 3, transition: "left 0.2s",
                    }} />
                  </button>
                  <span style={{ fontSize: 12, color: "#e2e8f0", fontWeight: 700, minWidth: 36, textAlign: "right" }}>
                    {minSatPct}%
                  </span>
                </div>
                {minSatEnabled && (
                  <div style={{ marginTop: 10 }}>
                    <input
                      type="range" min={0} max={100} value={minSatPct}
                      onChange={(e) => updateMinSat(true, parseInt(e.target.value))}
                      style={{ width: "100%", cursor: "pointer" }}
                    />
                  </div>
                )}
                <div style={{ fontSize: 11, color: "#64748b", marginTop: 8 }}>
                  When enabled, the generated-shade modes (Gradient and Tonal) push their colors toward this minimum perceptual saturation (S × (1 − 2·|L − ½|), the HSV-style measure), keeping washed-out near-white shades out. Palette, Custom, Beacon, and the Teams/NCAA/Flags modes apply the colors you pick verbatim.
                </div>
              </div>
            </div>

            <div style={{ background: "#1e293b", borderRadius: 16, padding: 20, border: "1px solid #334155", marginBottom: 16 }}>
              <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12, color: "#e2e8f0" }}>About</h3>
              <div style={{ fontSize: 13, color: "#94a3b8" }}>
                LightEmUp {versionInfo?.display || "(loading...)"}
              </div>
              <div style={{ fontSize: 13, color: "#64748b", marginTop: 4 }}>Hue (Zigbee) + Govee (LAN) unified controller</div>
            </div>
            <div style={{ background: "#1e293b", borderRadius: 16, padding: 20, border: "1px solid #334155" }}>
              <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12, color: "#e2e8f0" }}>Server</h3>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <button
                  onClick={() => setShowLogs(true)}
                  style={{
                    padding: "10px 20px", borderRadius: 10, border: "1px solid #334155",
                    background: "transparent", color: "#a5b4fc", fontSize: 13,
                    fontWeight: 600, cursor: "pointer",
                  }}
                >View Logs</button>
                <button
                  onClick={async () => {
                    if (!confirm("Restart the LightEmUp server? The page will reconnect automatically.")) return;
                    try { await api("/server/restart", { method: "POST" }); } catch {}
                    // Poll until server is back up, then reload
                    const poll = setInterval(async () => {
                      try {
                        const r = await fetch(API + "/config");
                        if (r.ok) { clearInterval(poll); window.location.reload(); }
                      } catch {}
                    }, 1000);
                  }}
                  style={{
                    padding: "10px 20px", borderRadius: 10, border: "none",
                    background: "#334155", color: "#f1f5f9", fontSize: 13,
                    fontWeight: 600, cursor: "pointer",
                  }}
                >Restart Server</button>
                <button
                  onClick={async () => {
                    if (!confirm("Shut down the LightEmUp server? You will need to relaunch it manually.")) return;
                    try { await api("/server/shutdown", { method: "POST" }); } catch {}
                  }}
                  style={{
                    padding: "10px 20px", borderRadius: 10, border: "1px solid #dc2626",
                    background: "transparent", color: "#f87171", fontSize: 13,
                    fontWeight: 600, cursor: "pointer",
                  }}
                >Stop Server</button>
              </div>
            </div>
          </div>
        )}
      {/* Server Logs Modal */}
      {showLogs && (
        <ServerLogs onClose={() => setShowLogs(false)} />
      )}

      {/* Hue Setup Modal */}
      {showHueSetup && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 1000,
          background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)",
          display: "flex", alignItems: "center", justifyContent: "center",
          padding: 16,
        }} onClick={() => setShowHueSetup(false)}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 480 }}>
            <SetupWizard onComplete={() => { setShowHueSetup(false); loadAll(); }} />
            <div style={{ textAlign: "center", marginTop: 12 }}>
              <button
                onClick={() => setShowHueSetup(false)}
                style={{
                  padding: "8px 24px", borderRadius: 10, border: "1px solid #334155",
                  background: "transparent", color: "#94a3b8", fontSize: 13,
                  fontWeight: 600, cursor: "pointer",
                }}
              >Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Global footer — version + commit date on every tab, not just Settings. */}
      <footer style={{
        marginTop: isMobile ? 24 : 36, paddingTop: 14, paddingBottom: 6,
        borderTop: "1px solid #1e293b", textAlign: "center",
        fontSize: 11, color: "#475569",
      }}>
        LightEmUp {versionInfo?.display || "(loading…)"}
      </footer>
      </main>
    </div>
    </PickerStyleContext.Provider>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(React.createElement(App));
