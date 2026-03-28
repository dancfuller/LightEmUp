// ─── Main App ───────────────────────────────────────────────────────────────

function App() {
  const [config, setConfig] = useState(null);
  const [hueLights, setHueLights] = useState([]);
  const [hueGroups, setHueGroups] = useState([]);
  const [goveeDevices, setGoveeDevices] = useState([]);
  const [rooms, setRooms] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState("rooms");
  const [showHueSetup, setShowHueSetup] = useState(false);
  const [favoriteColors, setFavoriteColors] = useState(() => loadFavoriteColors());
  const [nicknames, setNicknames] = useState({});
  const [refreshing, setRefreshing] = useState(false);
  const [lightningActiveRooms, setLightningActiveRooms] = useState([]);
  const [segmentInfo, setSegmentInfo] = useState({ sku_table: {}, configured_counts: {}, segment_mode: {} });
  const [roomLayouts, setRoomLayouts] = useState({});

  const updateFavorites = (newFavs) => {
    setFavoriteColors(newFavs);
    saveFavoriteColors(newFavs);
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

  const loadAll = useCallback(async () => {
    try {
      const cfg = await api("/config");
      setConfig(cfg);
      setRooms(cfg.rooms || {});
      setNicknames(cfg.nicknames || {});
      setRoomLayouts(cfg.room_layouts || {});

      const promises = [
        api("/discover/govee").catch(() => ({ devices: [] })),
        api("/scenes/lightning/status").catch(() => ({ active: [] })),
        api("/govee/segment-info").catch(() => ({ sku_table: {}, configured_counts: {}, segment_mode: {} })),
      ];

      if (cfg.hue_paired) {
        promises.push(
          api("/hue/lights").catch(() => ({ lights: [] })),
          api("/hue/groups").catch(() => ({ groups: [] })),
        );
      }

      const results = await Promise.all(promises);
      setGoveeDevices(results[0].devices || []);
      setLightningActiveRooms(results[1].active || []);
      setSegmentInfo(results[2]);

      if (cfg.hue_paired) {
        setHueLights(results[3]?.lights || []);
        setHueGroups(results[4]?.groups || []);
      }
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

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
        return { ...l, state: { ...l.state, ...(cmd.on !== undefined ? { on: cmd.on } : {}), ...(cmd.brightness !== undefined ? { brightness: cmd.brightness } : {}) } };
      }
      return l;
    }));
  };

  const controlGoveeDevice = async (device, cmd) => {
    api("/govee/control", {
      method: "POST",
      body: JSON.stringify({ ip: device.ip, ...cmd }),
    }).catch(e => console.error("Govee control error:", e));
    setGoveeDevices(prev => prev.map(d => {
      if (d.ip === device.ip) {
        const stateUpdate = {};
        if (cmd.on !== undefined) stateUpdate.on = cmd.on;
        if (cmd.brightness !== undefined) stateUpdate.brightness = cmd.brightness;
        if (cmd.r !== undefined) stateUpdate.color = { r: cmd.r, g: cmd.g, b: cmd.b };
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
    const goveeIps = new Set(room.govee_devices || []);

    if (hueIds.size > 0) {
      setHueLights(prev => prev.map(l => {
        if (!hueIds.has(l.id)) return l;
        const stateUpdate = {};
        if (cmd.on !== undefined) stateUpdate.on = cmd.on;
        if (cmd.brightness !== undefined) stateUpdate.brightness = Math.round(cmd.brightness * 254 / 100);
        return { ...l, state: { ...l.state, ...stateUpdate } };
      }));
    }

    if (goveeIps.size > 0) {
      setGoveeDevices(prev => prev.map(d => {
        if (!goveeIps.has(d.ip)) return d;
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
      govee: goveeDevices.filter(d => (room.govee_devices || []).includes(d.ip)),
    };
  };

  const unassignedHue = hueLights.filter(l => !Object.values(rooms).some(r => (r.hue_light_ids || []).includes(l.id)));
  const unassignedGovee = goveeDevices.filter(d => !Object.values(rooms).some(r => (r.govee_devices || []).includes(d.ip)));

  return (
    <div style={{
      minHeight: "100vh",
      background: "linear-gradient(180deg, #0a0f1e 0%, #0f172a 50%, #0a0f1e 100%)",
      fontFamily: "'Geist', -apple-system, sans-serif", color: "#f8fafc",
    }}>
      <header style={{
        padding: "20px 24px", borderBottom: "1px solid #1e293b",
        display: "flex", justifyContent: "space-between", alignItems: "center",
        position: "sticky", top: 0, background: "rgba(10,15,30,0.95)",
        backdropFilter: "blur(12px)", zIndex: 100,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 28 }}>🔆</span>
          <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0, letterSpacing: -0.5 }}>LightEmUp</h1>
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
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => setShowHueSetup(true)}
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
          <StatusBadge connected={goveeDevices.length > 0} label={`Govee (${goveeDevices.length})`} />
        </div>
      </header>

      <nav style={{ display: "flex", gap: 4, padding: "12px 24px", borderBottom: "1px solid #1e293b" }}>
        {["rooms", "all lights", "assign rooms", "settings"].map(tab => (
          <button
            key={tab} onClick={() => setActiveTab(tab)}
            style={{
              padding: "8px 20px", borderRadius: 8, border: "none",
              background: activeTab === tab ? "#6366f1" : "transparent",
              color: activeTab === tab ? "#fff" : "#64748b",
              fontSize: 13, fontWeight: 600, cursor: "pointer",
              textTransform: "capitalize", transition: "all 0.2s",
            }}
          >{tab}</button>
        ))}
      </nav>

      <main style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
        {error && (
          <div style={{
            padding: 16, borderRadius: 12,
            background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.3)",
            color: "#f87171", marginBottom: 24,
          }}>{error}</div>
        )}

        {activeTab === "rooms" && (
          <>
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
                  roomLayouts={roomLayouts}
                  onLayoutChange={handleLayoutChange}
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
              />
            )}
          </>
        )}

        {activeTab === "all lights" && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 }}>
            {hueLights.map(light => (
              <LightCard key={`hue-${light.id}`} light={light} onControl={controlHueLight}
                favorites={favoriteColors} onFavoritesChange={updateFavorites}
                nicknames={nicknames} onNicknameChange={updateNickname} />
            ))}
            {goveeDevices.map(device => (
              <LightCard key={`govee-${device.ip}`} light={device} onControl={controlGoveeDevice}
                favorites={favoriteColors} onFavoritesChange={updateFavorites}
                nicknames={nicknames} onNicknameChange={updateNickname} />
            ))}
          </div>
        )}

        {activeTab === "assign rooms" && (
          <RoomAssignment
            hueLights={hueLights} goveeDevices={goveeDevices}
            rooms={rooms} onRoomsChange={setRooms}
            nicknames={nicknames}
          />
        )}

        {activeTab === "settings" && (
          <div style={{ maxWidth: 600 }}>
            <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 20 }}>Configuration</h2>
            <div style={{ background: "#1e293b", borderRadius: 16, padding: 20, border: "1px solid #334155", marginBottom: 16 }}>
              <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12, color: "#e2e8f0" }}>Hue Bridge</h3>
              <div style={{ fontSize: 13, color: "#94a3b8" }}>IP: {config?.hue_bridge_ip || "Not found"}</div>
              <div style={{ fontSize: 13, color: "#94a3b8", marginTop: 4 }}>
                Status: {config?.hue_paired ? "✅ Paired" : "❌ Not paired"}
              </div>
            </div>
            <div style={{ background: "#1e293b", borderRadius: 16, padding: 20, border: "1px solid #334155", marginBottom: 16 }}>
              <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12, color: "#e2e8f0" }}>Govee Devices</h3>
              <div style={{ fontSize: 13, color: "#94a3b8" }}>Found: {goveeDevices.length} devices via LAN</div>
              <button
                onClick={async () => { const data = await api("/discover/govee"); setGoveeDevices(data.devices || []); }}
                style={{ marginTop: 12, padding: "8px 16px", borderRadius: 8, border: "none", background: "#334155", color: "#f1f5f9", fontSize: 13, cursor: "pointer" }}
              >Re-scan Govee Devices</button>
            </div>
            <div style={{ background: "#1e293b", borderRadius: 16, padding: 20, border: "1px solid #334155", marginBottom: 16 }}>
              <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12, color: "#e2e8f0" }}>About</h3>
              <div style={{ fontSize: 13, color: "#94a3b8" }}>LightEmUp v0.1.0</div>
              <div style={{ fontSize: 13, color: "#64748b", marginTop: 4 }}>Hue (Zigbee) + Govee (LAN) unified controller</div>
            </div>
            <div style={{ background: "#1e293b", borderRadius: 16, padding: 20, border: "1px solid #334155" }}>
              <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12, color: "#e2e8f0" }}>Server</h3>
              <div style={{ display: "flex", gap: 12 }}>
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
      </main>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(React.createElement(App));
