// CTCalibrationPanel — Settings tool to white-balance Govee LAN devices against
// a Hue reference, in RGB space. Govee's *native* color-temperature white can't
// go warm enough (still reads blue at its warmest), so instead of sending a CT
// command we drive the device with an RGB color (kelvinToRGB of an *effective*
// warm Kelvin). The effective Kelvin can dip well below the device's CT floor,
// so you can match a genuinely warm Hue reference. Saved per-device {in,out}
// points (out = effective Kelvin) are applied server-side as RGB wherever a CT
// command is sent to that device — whole-device and per-segment. See utils.js
// CT_CALIBRATION_TARGETS.

// Effective-Kelvin floor for tuning — warmer (lower) than CT_MIN_K so RGB can
// out-warm the device's native CT, which is the whole point of this approach.
const CT_RGB_MIN_K = 1200;

function CTCalibrationPanel({ hueLights, goveeDevices, nicknames, ctRgb, onControlHue, onControlGovee, onSaved }) {
  const isMobile = useIsMobile();

  const ctHueLights = (hueLights || []).filter(l => l.capabilities?.has_color_temp);
  const ctGoveeDevices = goveeDevices || [];

  const goveeKey = (d) => `govee:${goveeSlug(d)}`;
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

  // results[deviceKey][targetK] = effectiveK (the warm Kelvin we send as RGB).
  // Seed from any previously saved calibration so re-running starts where we left.
  const seedResults = () => {
    const r = {};
    Object.entries(ctRgb || {}).forEach(([key, pts]) => {
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

  const effectiveFor = (key, K) => results[key]?.[K] ?? K;

  // Drive the device with the RGB approximation of the effective Kelvin. This is
  // a raw RGB command (the server applies no further calibration to RGB), so
  // what you see while tuning is exactly what a calibrated scene will send.
  // withOn is only needed once per step (turning the device on each tick just
  // doubles the LAN traffic and slows the response).
  const sendGovee = (device, effK, withOn = false) => {
    const { r, g, b } = kelvinToRGB(effK);
    onControlGovee(device, withOn ? { on: true, r, g, b } : { r, g, b });
  };

  // Govee LAN lights apply commands slowly and animate each change, so sending
  // on every slider tick floods the device and it lags seconds behind. Throttle
  // to the latest value per device (trailing), keeping the UI instant while the
  // light keeps up.
  const sendThrottle = useRef({});
  const throttledSend = (device, effK) => {
    const key = goveeKey(device);
    const slot = sendThrottle.current[key] || (sendThrottle.current[key] = { timer: null, pending: null });
    slot.pending = effK;
    if (slot.timer) return;
    const fire = () => {
      if (slot.pending == null) { slot.timer = null; return; }
      const v = slot.pending; slot.pending = null;
      sendGovee(device, v);
      slot.timer = setTimeout(fire, 200);
    };
    fire();
  };

  // On entering a step (or changing reference/selection while active), drive the
  // reference Hue (native CT — the trustworthy target white) and every selected
  // device to its current recorded effective Kelvin (as RGB).
  useEffect(() => {
    if (!active || targetK == null) return;
    if (refLight) onControlHue(refLight, { on: true, color_temp: kelvinToMired(targetK) });
    activeDevices.forEach(d => sendGovee(d, effectiveFor(goveeKey(d), targetK), true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, stepIndex, referenceId, selectedKeys.join(",")]);

  const setEffective = (key, K, effK) => {
    const clamped = Math.max(CT_RGB_MIN_K, Math.min(CT_MAX_K, Math.round(effK)));
    setResults(prev => ({ ...prev, [key]: { ...(prev[key] || {}), [K]: clamped } }));
    return clamped;
  };

  // Ratings are a quick coarse capture; the fine-tune slider is precise. Both
  // write the same effective Kelvin. "Too blue" → warmer (lower) effective K.
  const RATING_DELTAS = { close: 0, slight: -300, much: -700 };
  const rate = (device, rating) => {
    const key = goveeKey(device);
    const cur = effectiveFor(key, targetK);
    const out = setEffective(key, targetK, cur + RATING_DELTAS[rating]);
    if (sendThrottle.current[key]) sendThrottle.current[key].pending = null;
    sendGovee(device, out);
  };
  const tune = (device, effK) => {
    const key = goveeKey(device);
    const out = setEffective(key, targetK, effK);
    throttledSend(device, out);
  };

  const saveAll = async () => {
    const updated = { ...(ctRgb || {}) };
    for (const d of ctGoveeDevices) {
      const key = goveeKey(d);
      const dev = results[key];
      if (!dev) continue;
      // Only persist a device that has at least one non-identity point.
      const points = targets.map(K => ({ in: K, out: effectiveFor(key, K) }));
      const anyOffset = points.some(p => p.out !== p.in);
      if (anyOffset) {
        await api("/calibration/ct-rgb", { method: "POST", body: JSON.stringify({ device_key: key, points }) });
        updated[key] = points;
      } else {
        await api("/calibration/ct-rgb", { method: "POST", body: JSON.stringify({ device_key: key, points: [] }) });
        delete updated[key];
      }
    }
    onSaved?.(updated);
    setActive(false);
  };

  const clearDevice = async (key) => {
    await api("/calibration/ct-rgb", { method: "POST", body: JSON.stringify({ device_key: key, points: [] }) });
    setResults(prev => { const n = { ...prev }; delete n[key]; return n; });
    const updated = { ...(ctRgb || {}) };
    delete updated[key];
    onSaved?.(updated);
  };

  const card = { background: "#1e293b", borderRadius: 16, padding: isMobile ? 12 : 20, border: "1px solid #334155", marginBottom: 16 };
  const btn = (bg, color) => ({ padding: "6px 12px", borderRadius: 8, border: "1px solid #334155", background: bg, color, fontSize: isMobile ? 11 : 12, fontWeight: 600, cursor: "pointer" });
  const swatch = (k) => { const { r, g, b } = kelvinToRGB(k); return `rgb(${r},${g},${b})`; };

  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
        <h3 style={{ fontSize: isMobile ? 14 : 15, fontWeight: 600, color: "#e2e8f0", margin: 0 }}>White Calibration (RGB)</h3>
        {Object.keys(ctRgb || {}).length > 0 && (
          <span style={{ fontSize: 11, color: "#4ade80" }}>{Object.keys(ctRgb).length} device(s) calibrated</span>
        )}
      </div>
      <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 14, lineHeight: 1.5 }}>
        Match each Govee white to the Hue reference. The device is driven by RGB, so you can
        warm it past its native limit. For each step, rate it or drag <b>warmer</b> until the
        white matches the reference. Saved values are sent as warm RGB in white scenes.
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
                      {govLabel(d)}{ctRgb?.[key] ? " ✓" : ""}
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
                  <div style={{ width: 22, height: 22, borderRadius: "50%", background: swatch(targetK), border: "1px solid #475569" }} />
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
                  const cur = effectiveFor(key, targetK);
                  return (
                    <div key={key} style={{ background: "#0f172a", borderRadius: 12, padding: isMobile ? 10 : 14, border: "1px solid #334155" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 8 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: "#e2e8f0" }}>{govLabel(d)}</span>
                        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ width: 16, height: 16, borderRadius: 4, background: swatch(cur), border: "1px solid #475569" }} />
                          <span style={{ fontSize: 12, color: cur === targetK ? "#64748b" : "#fbbf24" }}>
                            ~{cur}K{cur !== targetK ? ` (${cur - targetK > 0 ? "+" : ""}${cur - targetK})` : ""}
                          </span>
                        </span>
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
                        <button onClick={() => rate(d, "close")} style={btn("transparent", "#86efac")}>Close match</button>
                        <button onClick={() => rate(d, "slight")} style={btn("transparent", "#fdba74")}>Slightly too blue</button>
                        <button onClick={() => rate(d, "much")} style={btn("transparent", "#fb923c")}>Much too blue</button>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ fontSize: 11, color: "#fb923c" }}>warmer</span>
                        <input type="range" min={CT_RGB_MIN_K} max={CT_MAX_K} step={50} value={cur}
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
                {activeDevices.map(d => ctRgb?.[goveeKey(d)] && (
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
