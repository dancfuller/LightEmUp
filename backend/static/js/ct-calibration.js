// CTCalibrationPanel — Settings tool to white-balance Govee LAN devices against
// a Hue reference. Govee renders the same Kelvin bluer than Hue, so for each
// swept target we set the reference Hue + each selected Govee device and let the
// user record a warmer corrected Kelvin (via quick ratings or a fine-tune
// slider). Saved per-device {in,out} points are applied server-side wherever a
// CT command is sent to that device. See utils.js CT_CALIBRATION_TARGETS.

function CTCalibrationPanel({ hueLights, goveeDevices, nicknames, ctCorrection, onControlHue, onControlGovee, onSaved }) {
  const isMobile = useIsMobile();

  const ctHueLights = (hueLights || []).filter(l => l.capabilities?.has_color_temp);
  const ctGoveeDevices = goveeDevices || [];

  const goveeKey = (d) => `govee:${d.ip}`;
  const govLabel = (d) => {
    const { nickname, friendlyName } = getDeviceDisplayName({ ...d, type: "govee" }, nicknames);
    return nickname || friendlyName;
  };
  const hueLabel = (l) => (nicknames?.[`hue:${l.id}`] || l.name || `Light ${l.id}`);

  // Default reference: a Hue light named "Mumford", else the first CT-capable one.
  const defaultRef = (() => {
    const byName = ctHueLights.find(l => hueLabel(l).toLowerCase().includes("mumford"));
    return (byName || ctHueLights[0])?.id ?? null;
  })();

  const [referenceId, setReferenceId] = useState(defaultRef);
  const [selectedKeys, setSelectedKeys] = useState(ctGoveeDevices.map(goveeKey));
  const [active, setActive] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);

  // results[deviceKey][targetK] = correctedK (the warmer Kelvin we actually send).
  // Seed from any previously saved calibration so re-running starts where we left.
  const seedResults = () => {
    const r = {};
    Object.entries(ctCorrection || {}).forEach(([key, pts]) => {
      r[key] = {};
      (pts || []).forEach(p => { if (p.in && p.out) r[key][p.in] = p.out; });
    });
    return r;
  };
  const [results, setResults] = useState(seedResults);

  const targets = CT_CALIBRATION_TARGETS;
  const targetK = targets[stepIndex];

  const refLight = ctHueLights.find(l => l.id === referenceId);
  const activeDevices = ctGoveeDevices.filter(d => selectedKeys.includes(goveeKey(d)));

  const correctedFor = (key, K) => results[key]?.[K] ?? K;

  const sendGovee = (device, outK) => {
    onControlGovee(device, { on: true, color_temp_kelvin: outK, raw_ct: true });
  };

  // On entering a step (or changing reference/selection while active), drive the
  // reference Hue and every selected device to this target. Devices go to their
  // current recorded value so re-visiting a step shows the prior tuning live.
  useEffect(() => {
    if (!active || targetK == null) return;
    if (refLight) onControlHue(refLight, { on: true, color_temp: kelvinToMired(targetK) });
    activeDevices.forEach(d => sendGovee(d, correctedFor(goveeKey(d), targetK)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, stepIndex, referenceId, selectedKeys.join(",")]);

  const setCorrected = (key, K, outK) => {
    const clamped = Math.max(CT_MIN_K, Math.min(CT_MAX_K, Math.round(outK)));
    setResults(prev => ({ ...prev, [key]: { ...(prev[key] || {}), [K]: clamped } }));
    return clamped;
  };

  // Ratings are a quick coarse capture; the fine-tune slider is precise. Both
  // write the same corrected value. "Too blue" → send a warmer (lower) Kelvin.
  const RATING_DELTAS = { close: 0, slight: -300, much: -700 };
  const rate = (device, rating) => {
    const key = goveeKey(device);
    const out = setCorrected(key, targetK, targetK + RATING_DELTAS[rating]);
    sendGovee(device, out);
  };
  const tune = (device, outK) => {
    const key = goveeKey(device);
    const out = setCorrected(key, targetK, outK);
    sendGovee(device, out);
  };

  const saveAll = async () => {
    const updated = { ...(ctCorrection || {}) };
    for (const d of ctGoveeDevices) {
      const key = goveeKey(d);
      const dev = results[key];
      if (!dev) continue;
      // Only persist a device that has at least one non-identity correction.
      const points = targets.map(K => ({ in: K, out: correctedFor(key, K) }));
      const anyOffset = points.some(p => p.out !== p.in);
      if (anyOffset) {
        await api("/calibration/ct", { method: "POST", body: JSON.stringify({ device_key: key, points }) });
        updated[key] = points;
      } else {
        await api("/calibration/ct", { method: "POST", body: JSON.stringify({ device_key: key, points: [] }) });
        delete updated[key];
      }
    }
    onSaved?.(updated);
    setActive(false);
  };

  const clearDevice = async (key) => {
    await api("/calibration/ct", { method: "POST", body: JSON.stringify({ device_key: key, points: [] }) });
    setResults(prev => { const n = { ...prev }; delete n[key]; return n; });
    const updated = { ...(ctCorrection || {}) };
    delete updated[key];
    onSaved?.(updated);
  };

  const card = { background: "#1e293b", borderRadius: 16, padding: isMobile ? 12 : 20, border: "1px solid #334155", marginBottom: 16 };
  const btn = (bg, color) => ({ padding: "6px 12px", borderRadius: 8, border: "1px solid #334155", background: bg, color, fontSize: isMobile ? 11 : 12, fontWeight: 600, cursor: "pointer" });

  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
        <h3 style={{ fontSize: isMobile ? 14 : 15, fontWeight: 600, color: "#e2e8f0", margin: 0 }}>White Calibration</h3>
        {Object.keys(ctCorrection || {}).length > 0 && (
          <span style={{ fontSize: 11, color: "#4ade80" }}>{Object.keys(ctCorrection).length} device(s) calibrated</span>
        )}
      </div>
      <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 14, lineHeight: 1.5 }}>
        Match Govee white temperatures to a Hue reference. For each step, compare each Govee
        device to the reference and either rate it or fine-tune until the white matches.
      </div>

      {ctHueLights.length === 0 ? (
        <div style={{ fontSize: 12, color: "#f87171" }}>No color-temperature-capable Hue lights found to use as a reference.</div>
      ) : (
        <>
          {/* Reference + device selection */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 14 }}>
            <label style={{ fontSize: 12, color: "#cbd5e1" }}>
              Reference (target white)
              <select value={referenceId ?? ""} onChange={e => setReferenceId(Number(e.target.value))}
                style={{ marginLeft: 8, padding: "4px 8px", borderRadius: 6, background: "#0f172a", color: "#e2e8f0", border: "1px solid #334155", fontSize: 12 }}>
                {ctHueLights.map(l => <option key={l.id} value={l.id}>{hueLabel(l)}</option>)}
              </select>
            </label>
            <div style={{ fontSize: 12, color: "#cbd5e1" }}>
              <div style={{ marginBottom: 6 }}>Devices to calibrate</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {ctGoveeDevices.map(d => {
                  const key = goveeKey(d);
                  const on = selectedKeys.includes(key);
                  return (
                    <button key={key} onClick={() => setSelectedKeys(prev => on ? prev.filter(k => k !== key) : [...prev, key])}
                      style={btn(on ? "#3730a3" : "transparent", on ? "#e0e7ff" : "#94a3b8")}>
                      {govLabel(d)}{ctCorrection?.[key] ? " ✓" : ""}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {!active ? (
            <button onClick={() => { setStepIndex(0); setActive(true); }}
              disabled={!refLight || activeDevices.length === 0}
              style={{ ...btn("#4f46e5", "#fff"), opacity: (!refLight || activeDevices.length === 0) ? 0.5 : 1 }}>
              Start calibration
            </button>
          ) : (
            <div>
              {/* Stepper header */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 12, paddingBottom: 10, borderBottom: "1px solid #334155" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ width: 22, height: 22, borderRadius: "50%", background: `rgb(${kelvinToRGB(targetK).r},${kelvinToRGB(targetK).g},${kelvinToRGB(targetK).b})`, border: "1px solid #475569" }} />
                  <span style={{ fontSize: isMobile ? 14 : 16, fontWeight: 700, color: "#f1f5f9" }}>{targetK}K</span>
                  <span style={{ fontSize: 11, color: "#64748b" }}>Step {stepIndex + 1} of {targets.length}</span>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => setStepIndex(i => Math.max(0, i - 1))} disabled={stepIndex === 0} style={{ ...btn("transparent", "#cbd5e1"), opacity: stepIndex === 0 ? 0.4 : 1 }}>Back</button>
                  {stepIndex < targets.length - 1
                    ? <button onClick={() => setStepIndex(i => i + 1)} style={btn("#334155", "#e2e8f0")}>Next</button>
                    : <button onClick={saveAll} style={btn("#16a34a", "#fff")}>Save & finish</button>}
                </div>
              </div>

              {/* Per-device tuning */}
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {activeDevices.map(d => {
                  const key = goveeKey(d);
                  const cur = correctedFor(key, targetK);
                  return (
                    <div key={key} style={{ background: "#0f172a", borderRadius: 12, padding: isMobile ? 10 : 14, border: "1px solid #334155" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: "#e2e8f0" }}>{govLabel(d)}</span>
                        <span style={{ fontSize: 12, color: cur === targetK ? "#64748b" : "#fbbf24" }}>
                          sends {cur}K{cur !== targetK ? ` (${cur - targetK > 0 ? "+" : ""}${cur - targetK})` : ""}
                        </span>
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
                        <button onClick={() => rate(d, "close")} style={btn("transparent", "#86efac")}>Close match</button>
                        <button onClick={() => rate(d, "slight")} style={btn("transparent", "#93c5fd")}>Slightly too blue</button>
                        <button onClick={() => rate(d, "much")} style={btn("transparent", "#60a5fa")}>Much too blue</button>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ fontSize: 11, color: "#fbbf24" }}>warmer</span>
                        <input type="range" min={CT_MIN_K} max={CT_MAX_K} step={50} value={cur}
                          onChange={e => tune(d, Number(e.target.value))}
                          style={{ flex: 1, accentColor: "#6366f1" }} />
                        <span style={{ fontSize: 11, color: "#93c5fd" }}>cooler</span>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div style={{ marginTop: 14, display: "flex", flexWrap: "wrap", gap: 8 }}>
                <button onClick={() => setActive(false)} style={btn("transparent", "#94a3b8")}>Cancel</button>
                {activeDevices.map(d => ctCorrection?.[goveeKey(d)] && (
                  <button key={goveeKey(d)} onClick={() => clearDevice(goveeKey(d))} style={btn("transparent", "#f87171")}>Clear {govLabel(d)}</button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
