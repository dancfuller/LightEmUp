// ─── Lightning Scene Panel ────────────────────────────────────────────────────

const LIGHTNING_PRESETS = {
  realistic:{ label: "Realistic",min_gap_ms: 15000, max_gap_ms: 60000, flash_duration_min_ms: 50, flash_duration_max_ms: 200, burst_count_min: 1, burst_count_max: 2, inter_burst_gap_ms: 80 },
  slow:     { label: "Slow",     min_gap_ms: 5000,  max_gap_ms: 20000, flash_duration_min_ms: 50, flash_duration_max_ms: 200, burst_count_min: 1, burst_count_max: 2, inter_burst_gap_ms: 60 },
  medium:   { label: "Medium",   min_gap_ms: 1500,  max_gap_ms: 6000,  flash_duration_min_ms: 50, flash_duration_max_ms: 150, burst_count_min: 1, burst_count_max: 3, inter_burst_gap_ms: 50 },
  fast:     { label: "Fast",     min_gap_ms: 500,   max_gap_ms: 2000,  flash_duration_min_ms: 40, flash_duration_max_ms: 120, burst_count_min: 2, burst_count_max: 5, inter_burst_gap_ms: 40 },
  epilepsy: { label: "Epilepsy", min_gap_ms: 80,    max_gap_ms: 400,   flash_duration_min_ms: 20, flash_duration_max_ms: 60,  burst_count_min: 4, burst_count_max: 8, inter_burst_gap_ms: 20 },
};

function getActivePreset(settings) {
  if (!settings) return null;
  for (const [key, preset] of Object.entries(LIGHTNING_PRESETS)) {
    const { label, ...timing } = preset;
    if (Object.entries(timing).every(([k, v]) => settings[k] === v)) return key;
  }
  return null;
}

function LightningPanel({ roomName, isActive, onStart, onStop, goveeDevices, segmentInfo }) {
  const isMobile = useIsMobile();
  const [showSettings, setShowSettings] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api(`/scenes/lightning/settings/${encodeURIComponent(roomName)}`)
      .then(data => { setSettings(data); setLoading(false); })
      .catch(() => {
        setSettings({
          color_temp_kelvin: 6500, use_color_temp: true,
          color_r: 220, color_g: 240, color_b: 255,
          background_brightness: 10, background_color_temp_k: 2700,
          govee_flash: false, thunder_enabled: false, thunder_immediate: false, thunder_funny: false,
          min_gap_ms: 15000, max_gap_ms: 60000,
          flash_duration_min_ms: 50, flash_duration_max_ms: 200,
          burst_count_min: 1, burst_count_max: 2, inter_burst_gap_ms: 80,
        });
        setLoading(false);
      });
  }, [roomName]);

  // SSE connection for thunder sound sync.
  useEffect(() => {
    if (!isActive || !settings?.thunder_enabled) return;
    const immediate = settings.thunder_immediate;
    const funny = settings.thunder_funny;
    const soundFn = funny ? playFart : playThunder;
    const es = new EventSource(`/api/scenes/lightning/events/${encodeURIComponent(roomName)}`);
    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === "flash") {
        if (immediate) {
          soundFn();
        } else {
          const delay = 500 + Math.random() * 5500;
          setTimeout(() => soundFn(), delay);
        }
      }
    };
    return () => es.close();
  }, [isActive, settings?.thunder_enabled, settings?.thunder_immediate, settings?.thunder_funny, roomName]);

  const updateSetting = (key, value) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const saveSettings = async () => {
    setSaving(true);
    try {
      await api("/scenes/lightning/settings", {
        method: "POST",
        body: JSON.stringify({ room_name: roomName, ...settings }),
      });
    } catch (e) {
      console.error("Failed to save lightning settings:", e);
    }
    setSaving(false);
  };

  const segmentCapableDevices = (goveeDevices || []).filter(d => {
    const info = segmentInfo?.sku_table?.[d.sku];
    return info && info.protocol === "razer" && info.count > 0;
  });

  if (loading || !settings) return null;

  return (
    <div style={{
      background: "linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)",
      borderRadius: 16, padding: isMobile ? 14 : 20, marginBottom: 16,
      border: "1px solid #334155",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 18 }}>&#x26A1;</span>
          <span style={{ fontSize: 14, fontWeight: 700, color: "#e2e8f0" }}>Lightning Storm</span>
          {isActive && (
            <span style={{
              padding: "2px 8px", borderRadius: 10, fontSize: 10, fontWeight: 700,
              background: "rgba(251,191,36,0.2)", color: "#fbbf24",
              animation: "pulse 1.5s ease-in-out infinite",
            }}>ACTIVE</span>
          )}
        </div>
        <button
          onClick={() => isActive ? onStop() : onStart()}
          style={{
            padding: "8px 20px", borderRadius: 10, border: "none",
            background: isActive ? "#dc2626" : "#6366f1",
            color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer",
          }}
        >{isActive ? "Stop" : "Start"}</button>
      </div>

      <button
        onClick={() => setShowSettings(!showSettings)}
        style={{
          padding: "4px 10px", borderRadius: 6, border: "1px solid #334155",
          background: showSettings ? "rgba(99,102,241,0.15)" : "transparent",
          color: showSettings ? "#a5b4fc" : "#64748b",
          fontSize: 11, fontWeight: 600, cursor: "pointer",
          marginBottom: showSettings ? 12 : 0,
        }}
      >{showSettings ? "Hide Settings" : "Settings"}</button>

      {showSettings && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Flash Color */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#a5b4fc", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 8 }}>
              Flash Color
            </div>
            <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
              <button
                onClick={() => updateSetting("use_color_temp", true)}
                style={{
                  padding: "4px 10px", borderRadius: 6, border: "none",
                  background: settings.use_color_temp ? "#334155" : "transparent",
                  color: settings.use_color_temp ? "#e2e8f0" : "#64748b",
                  fontSize: 11, fontWeight: 600, cursor: "pointer",
                }}
              >Color Temp</button>
              <button
                onClick={() => updateSetting("use_color_temp", false)}
                style={{
                  padding: "4px 10px", borderRadius: 6, border: "none",
                  background: !settings.use_color_temp ? "#334155" : "transparent",
                  color: !settings.use_color_temp ? "#e2e8f0" : "#64748b",
                  fontSize: 11, fontWeight: 600, cursor: "pointer",
                }}
              >RGB</button>
            </div>
            {settings.use_color_temp ? (
              <Slider
                label="Flash Color Temp" value={settings.color_temp_kelvin}
                min={2700} max={6500} onChange={(v) => updateSetting("color_temp_kelvin", v)}
                color="#60a5fa" unit="K"
              />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <RgbSliderInput label="R" value={settings.color_r} onChange={(v) => updateSetting("color_r", v)} color="#f87171" />
                <RgbSliderInput label="G" value={settings.color_g} onChange={(v) => updateSetting("color_g", v)} color="#4ade80" />
                <RgbSliderInput label="B" value={settings.color_b} onChange={(v) => updateSetting("color_b", v)} color="#60a5fa" />
              </div>
            )}
          </div>

          {/* Govee Flash Toggle */}
          {goveeDevices && goveeDevices.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#a5b4fc", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 8 }}>
                Govee Lights
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <button
                  onClick={() => updateSetting("govee_flash", !settings.govee_flash)}
                  style={{
                    width: 40, height: 22, borderRadius: 11, border: "none", cursor: "pointer",
                    background: settings.govee_flash ? "#6366f1" : "#334155",
                    position: "relative", transition: "background 0.2s",
                  }}
                >
                  <div style={{
                    width: 16, height: 16, borderRadius: 8,
                    background: "#fff", position: "absolute", top: 3,
                    left: settings.govee_flash ? 21 : 3,
                    transition: "left 0.2s",
                  }} />
                </button>
                <span style={{ fontSize: 12, color: "#94a3b8" }}>
                  {settings.govee_flash ? "Flash with Hue lights" : "Background glow only"}
                </span>
              </div>
            </div>
          )}

          {/* Background */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#a5b4fc", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 8 }}>
              Background (between flashes)
            </div>
            <Slider
              label="Brightness" value={settings.background_brightness}
              min={0} max={30} onChange={(v) => updateSetting("background_brightness", v)}
              color="#fbbf24" unit="%"
            />
            <Slider
              label="Color Temp" value={settings.background_color_temp_k}
              min={2000} max={4000} onChange={(v) => updateSetting("background_color_temp_k", v)}
              color="#fb923c" unit="K"
            />
          </div>

          {/* Lightning Frequency */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#a5b4fc", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 8 }}>
              Lightning Frequency
            </div>
            <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
              {Object.entries(LIGHTNING_PRESETS).map(([key, preset]) => {
                const active = getActivePreset(settings) === key;
                const isEpilepsy = key === "epilepsy";
                return (
                  <button
                    key={key}
                    onClick={() => { const { label, ...timing } = preset; setSettings(prev => ({ ...prev, ...timing })); }}
                    style={{
                      padding: "6px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer",
                      border: active ? "none" : "1px solid #334155",
                      background: active ? (isEpilepsy ? "#dc2626" : "#6366f1") : "#1e293b",
                      color: active ? "#fff" : "#94a3b8",
                    }}
                  >{preset.label}</button>
                );
              })}
            </div>
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              style={{
                padding: "3px 9px", borderRadius: 5, fontSize: 10, fontWeight: 600, cursor: "pointer",
                border: "1px solid #334155",
                background: showAdvanced ? "rgba(99,102,241,0.15)" : "transparent",
                color: showAdvanced ? "#a5b4fc" : "#475569",
                marginBottom: showAdvanced ? 10 : 0,
              }}
            >{showAdvanced ? "Hide Advanced" : "Advanced"}</button>
            {showAdvanced && (
              <div style={{ marginTop: 8, padding: "10px 12px", background: "rgba(15,23,42,0.6)", borderRadius: 8, border: "1px solid #1e293b" }}>
                <div style={{ fontSize: 10, color: "#64748b", marginBottom: 8 }}>Fine-tune timing — changing these clears the preset selection.</div>
                <Slider label="Min Gap" value={settings.min_gap_ms} min={80} max={30000} onChange={(v) => updateSetting("min_gap_ms", v)} color="#818cf8" unit="ms" />
                <Slider label="Max Gap" value={settings.max_gap_ms} min={200} max={60000} onChange={(v) => updateSetting("max_gap_ms", v)} color="#818cf8" unit="ms" />
                <Slider label="Flash Duration (min)" value={settings.flash_duration_min_ms} min={10} max={300} onChange={(v) => updateSetting("flash_duration_min_ms", v)} color="#c084fc" unit="ms" />
                <Slider label="Flash Duration (max)" value={settings.flash_duration_max_ms} min={20} max={500} onChange={(v) => updateSetting("flash_duration_max_ms", v)} color="#c084fc" unit="ms" />
                <Slider label="Burst Count (min)" value={settings.burst_count_min} min={1} max={6} onChange={(v) => updateSetting("burst_count_min", v)} color="#67e8f9" />
                <Slider label="Burst Count (max)" value={settings.burst_count_max} min={1} max={10} onChange={(v) => updateSetting("burst_count_max", v)} color="#67e8f9" />
                <Slider label="Inter-burst Gap" value={settings.inter_burst_gap_ms} min={10} max={200} onChange={(v) => updateSetting("inter_burst_gap_ms", v)} color="#818cf8" unit="ms" />
              </div>
            )}
          </div>

          {/* Thunder Sound */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#a5b4fc", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 8 }}>
              Thunder Sound
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: settings.thunder_enabled ? 8 : 0 }}>
              <button
                onClick={() => updateSetting("thunder_enabled", !settings.thunder_enabled)}
                style={{
                  width: 40, height: 22, borderRadius: 11, border: "none", cursor: "pointer",
                  background: settings.thunder_enabled ? "#6366f1" : "#334155",
                  position: "relative", transition: "background 0.2s",
                }}
              >
                <div style={{
                  width: 16, height: 16, borderRadius: 8,
                  background: "#fff", position: "absolute", top: 3,
                  left: settings.thunder_enabled ? 21 : 3,
                  transition: "left 0.2s",
                }} />
              </button>
              <span style={{ fontSize: 12, color: "#94a3b8" }}>
                {settings.thunder_enabled ? "Thunder enabled" : "Off"}
              </span>
            </div>
            {settings.thunder_enabled && (<React.Fragment>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  onClick={() => updateSetting("thunder_immediate", false)}
                  style={{
                    padding: "5px 12px", borderRadius: 7, fontSize: 11, fontWeight: 600, cursor: "pointer",
                    border: !settings.thunder_immediate ? "none" : "1px solid #334155",
                    background: !settings.thunder_immediate ? "#6366f1" : "#1e293b",
                    color: !settings.thunder_immediate ? "#fff" : "#94a3b8",
                  }}
                >Delayed (realistic)</button>
                <button
                  onClick={() => updateSetting("thunder_immediate", true)}
                  style={{
                    padding: "5px 12px", borderRadius: 7, fontSize: 11, fontWeight: 600, cursor: "pointer",
                    border: settings.thunder_immediate ? "none" : "1px solid #334155",
                    background: settings.thunder_immediate ? "#6366f1" : "#1e293b",
                    color: settings.thunder_immediate ? "#fff" : "#94a3b8",
                  }}
                >Immediate</button>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
                <button
                  onClick={() => updateSetting("thunder_funny", !settings.thunder_funny)}
                  style={{
                    width: 40, height: 22, borderRadius: 11, border: "none", cursor: "pointer",
                    background: settings.thunder_funny ? "#dc2626" : "#334155",
                    position: "relative", transition: "background 0.2s",
                  }}
                >
                  <div style={{
                    width: 16, height: 16, borderRadius: 8,
                    background: "#fff", position: "absolute", top: 3,
                    left: settings.thunder_funny ? 21 : 3,
                    transition: "left 0.2s",
                  }} />
                </button>
                <span style={{ fontSize: 12, color: settings.thunder_funny ? "#fca5a5" : "#94a3b8" }}>
                  {settings.thunder_funny ? "Funny thunder (farts)" : "Funny thunder"}
                </span>
              </div>
            </React.Fragment>)}
          </div>

          {/* Govee Segment Mode */}
          {segmentCapableDevices.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#a5b4fc", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 8 }}>
                Govee Segment Control
              </div>
              {segmentCapableDevices.map(d => {
                const info = segmentInfo?.sku_table?.[d.sku];
                const isSegmentMode = segmentInfo?.segment_mode?.[d.ip] || false;
                const displayName = GOVEE_SKU_NAMES[d.sku] || d.name || d.sku;
                return (
                  <div key={d.ip} style={{
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    padding: "8px 12px", borderRadius: 8, background: "#0f172a",
                    border: "1px solid #1e293b", marginBottom: 6,
                  }}>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "#e2e8f0" }}>
                        {displayName} ({info?.count} segments)
                      </div>
                      <div style={{ fontSize: 10, color: "#64748b" }}>{d.ip}</div>
                    </div>
                    <button
                      onClick={async () => {
                        const newMode = !isSegmentMode;
                        try {
                          await api("/govee/segment-mode", {
                            method: "POST",
                            body: JSON.stringify({ room_name: roomName, ip: d.ip, enabled: newMode }),
                          });
                          if (newMode && info?.count) {
                            await api("/govee/segment-count", {
                              method: "POST",
                              body: JSON.stringify({ ip: d.ip, count: info.count }),
                            });
                          }
                          // Reload segment info in parent via event
                          window.dispatchEvent(new Event("lightemup-reload-segments"));
                        } catch (e) {
                          console.error("Failed to toggle segment mode:", e);
                        }
                      }}
                      style={{
                        width: 48, height: 28, borderRadius: 14, border: "none",
                        background: isSegmentMode ? "#6366f1" : "#334155",
                        cursor: "pointer", position: "relative", transition: "background 0.2s",
                      }}
                    >
                      <div style={{
                        width: 22, height: 22, borderRadius: "50%", background: "#fff",
                        position: "absolute", top: 3,
                        left: isSegmentMode ? 23 : 3, transition: "left 0.2s ease",
                      }} />
                    </button>
                  </div>
                );
              })}
              <div style={{ fontSize: 10, color: "#475569", marginTop: 4 }}>
                When enabled, each panel/segment flashes independently.
              </div>
            </div>
          )}

          {/* Save */}
          <button
            onClick={saveSettings} disabled={saving}
            style={{
              padding: "10px 24px", borderRadius: 10, border: "none",
              background: saving ? "#475569" : "#334155",
              color: "#f1f5f9", fontSize: 13, fontWeight: 600,
              cursor: saving ? "wait" : "pointer", alignSelf: "flex-start",
            }}
          >{saving ? "Saving..." : "Save Settings"}</button>
        </div>
      )}
    </div>
  );
}
