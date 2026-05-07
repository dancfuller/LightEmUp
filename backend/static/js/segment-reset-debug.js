// ─── Segment Reset Debug Panel ──────────────────────────────────────────────
// Lets you compare reset-to-white strategies on Govee segmented devices and
// time them. The hypothesis under test is: a V1 LAN whole-device white is
// faster and avoids the V2 burst-bucket pressure that the per-segment V2
// reset incurs. We don't yet know whether a V1 LAN command cleanly resets a
// device that's in segment-render mode, hence this manual test panel.

function SegmentResetDebug({ roomName, goveeDevices, segmentInfo }) {
  const isMobile = useIsMobile();
  const [log, setLog] = useState([]);
  const [busy, setBusy] = useState(false);

  // Resolve a device's segment count: manual override (configured_counts by ip)
  // wins over the SKU table default. Mirrors how light-card.js derives it.
  const getSegCount = (d) => {
    const configured = segmentInfo?.configured_counts?.[d.ip];
    if (configured) return configured;
    return segmentInfo?.sku_table?.[d.sku]?.count || 0;
  };

  const segDevices = goveeDevices.filter(d => getSegCount(d) > 1);

  const addLog = (msg) => {
    const stamp = new Date().toLocaleTimeString();
    setLog(prev => [...prev.slice(-200), `${stamp}  ${msg}`]);
  };

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const callV1White = async (device) => {
    const t0 = performance.now();
    await api("/govee/control", {
      method: "POST",
      body: JSON.stringify({ ip: device.ip, r: 255, g: 255, b: 255 }),
      headers: { "Content-Type": "application/json" },
    });
    return Math.round(performance.now() - t0);
  };

  const callV2SegWhite = async (device, idx) => {
    const t0 = performance.now();
    await api("/govee/segment-control", {
      method: "POST",
      body: JSON.stringify({
        ip: device.ip, sku: device.sku, device_mac: device.mac,
        segment_idx: idx, r: 255, g: 255, b: 255,
      }),
      headers: { "Content-Type": "application/json" },
    });
    return Math.round(performance.now() - t0);
  };

  const callV2SegColor = async (device, idx, r, g, b, brightness = 100) => {
    const t0 = performance.now();
    await api("/govee/segment-control", {
      method: "POST",
      body: JSON.stringify({
        ip: device.ip, sku: device.sku, device_mac: device.mac,
        segment_idx: idx, r, g, b, brightness,
      }),
      headers: { "Content-Type": "application/json" },
    });
    return Math.round(performance.now() - t0);
  };

  // 6-color rainbow cycled through the segment count
  const rainbow = [
    { r: 255, g: 30, b: 30 },
    { r: 255, g: 160, b: 0 },
    { r: 255, g: 230, b: 0 },
    { r: 30, g: 220, b: 60 },
    { r: 30, g: 130, b: 255 },
    { r: 180, g: 60, b: 255 },
  ];

  const runV1Reset = async (device) => {
    if (busy) return;
    setBusy(true);
    addLog(`▶ V1 LAN white → ${device.sku} @ ${device.ip}`);
    try {
      const ms = await callV1White(device);
      addLog(`  V1 white done in ${ms}ms`);
    } catch (e) {
      addLog(`  V1 white FAILED: ${e.message}`);
    }
    setBusy(false);
  };

  const runV2ResetAll = async (device) => {
    if (busy) return;
    setBusy(true);
    const segCount = getSegCount(device);
    addLog(`▶ V2 per-seg white reset → ${device.sku} (${segCount} segments, 1500ms stagger)`);
    const t0 = performance.now();
    for (let i = 0; i < segCount; i++) {
      try {
        const ms = await callV2SegWhite(device, i);
        addLog(`  seg ${i} white in ${ms}ms`);
      } catch (e) {
        addLog(`  seg ${i} FAILED: ${e.message}`);
      }
      if (i < segCount - 1) await sleep(1500);
    }
    addLog(`  V2 reset all total ${Math.round(performance.now() - t0)}ms`);
    setBusy(false);
  };

  const runV2Rainbow = async (device, stagger) => {
    if (busy) return;
    setBusy(true);
    const segCount = getSegCount(device);
    addLog(`▶ V2 rainbow apply → ${device.sku} (${segCount} segments, ${stagger}ms stagger)`);
    const t0 = performance.now();
    for (let i = 0; i < segCount; i++) {
      const c = rainbow[i % rainbow.length];
      try {
        const ms = await callV2SegColor(device, i, c.r, c.g, c.b);
        addLog(`  seg ${i} → rgb(${c.r},${c.g},${c.b}) in ${ms}ms`);
      } catch (e) {
        addLog(`  seg ${i} FAILED: ${e.message}`);
      }
      if (i < segCount - 1) await sleep(stagger);
    }
    addLog(`  V2 rainbow total ${Math.round(performance.now() - t0)}ms`);
    setBusy(false);
  };

  // Hybrid: V1 LAN white (fast) → 2s hold → V2 per-segment rainbow.
  // This is the candidate optimization. If segments end up rainbow-correctly
  // colored, the V1 reset cleanly substituted for the V2-per-segment reset
  // pass and we can adopt this in the main Apply path.
  const runHybrid = async (device, stagger) => {
    if (busy) return;
    setBusy(true);
    const segCount = getSegCount(device);
    addLog(`▶ HYBRID: V1 LAN white → 2s hold → V2 rainbow (${segCount} seg, ${stagger}ms)`);
    const tStart = performance.now();
    try {
      const v1ms = await callV1White(device);
      addLog(`  V1 white in ${v1ms}ms — holding 2000ms`);
    } catch (e) {
      addLog(`  V1 white FAILED: ${e.message}`);
      setBusy(false);
      return;
    }
    await sleep(2000);
    for (let i = 0; i < segCount; i++) {
      const c = rainbow[i % rainbow.length];
      try {
        const ms = await callV2SegColor(device, i, c.r, c.g, c.b);
        addLog(`  seg ${i} → rgb(${c.r},${c.g},${c.b}) in ${ms}ms`);
      } catch (e) {
        addLog(`  seg ${i} FAILED: ${e.message}`);
      }
      if (i < segCount - 1) await sleep(stagger);
    }
    addLog(`  HYBRID total ${Math.round(performance.now() - tStart)}ms`);
    setBusy(false);
  };

  // Baseline: V2 reset all → 2s hold → V2 rainbow (mirrors current Apply path)
  const runBaseline = async (device, stagger) => {
    if (busy) return;
    setBusy(true);
    const segCount = getSegCount(device);
    addLog(`▶ BASELINE: V2 reset all → 2s hold → V2 rainbow (${segCount} seg)`);
    const tStart = performance.now();
    for (let i = 0; i < segCount; i++) {
      try {
        await callV2SegWhite(device, i);
      } catch (e) {
        addLog(`  reset seg ${i} FAILED: ${e.message}`);
      }
      if (i < segCount - 1) await sleep(1500);
    }
    addLog(`  reset pass done in ${Math.round(performance.now() - tStart)}ms — holding 2000ms`);
    await sleep(2000);
    const tApply = performance.now();
    for (let i = 0; i < segCount; i++) {
      const c = rainbow[i % rainbow.length];
      try {
        await callV2SegColor(device, i, c.r, c.g, c.b);
      } catch (e) {
        addLog(`  apply seg ${i} FAILED: ${e.message}`);
      }
      if (i < segCount - 1) await sleep(stagger);
    }
    addLog(`  apply pass in ${Math.round(performance.now() - tApply)}ms`);
    addLog(`  BASELINE total ${Math.round(performance.now() - tStart)}ms`);
    setBusy(false);
  };

  const btn = (label, onClick, color = "#94a3b8", bg = "transparent") => (
    <button
      onClick={onClick}
      disabled={busy}
      style={{
        padding: "5px 10px", borderRadius: 6, border: "1px solid #334155",
        background: busy ? "transparent" : bg, color: busy ? "#475569" : color,
        fontSize: 11, fontWeight: 600,
        cursor: busy ? "not-allowed" : "pointer",
        whiteSpace: "nowrap",
      }}
    >{label}</button>
  );

  return (
    <div style={{
      background: "linear-gradient(135deg, #1e293b 0%, #172033 100%)",
      borderRadius: 16, padding: isMobile ? 14 : 20, marginBottom: 16,
      border: "1px solid #475569",
    }}>
      <div style={{
        fontSize: 12, fontWeight: 600, color: "#fbbf24",
        textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 6,
      }}>
        Segment Reset Debug — {roomName}
      </div>
      <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 12, lineHeight: 1.5 }}>
        Compare reset strategies on Govee segmented devices. Watch the lights, then
        copy the log below and report findings. The <b>HYBRID</b> button is the
        candidate optimization: V1 LAN white → hold → V2 per-segment apply.
      </div>

      {segDevices.length === 0 ? (
        <div style={{ fontSize: 12, color: "#64748b", padding: "8px 0" }}>
          No multi-segment Govee devices in this room.
        </div>
      ) : segDevices.map(d => {
        const segCount = getSegCount(d);
        const label = `${d.sku} @ ${d.ip} · ${segCount} seg${d.mac ? "" : " (no mac)"}`;
        return (
          <div key={d.ip} style={{
            background: "#0f172a", borderRadius: 8, border: "1px solid #1e293b",
            padding: 10, marginBottom: 10,
          }}>
            <div style={{ fontSize: 11, color: "#cbd5e1", marginBottom: 8, fontFamily: "monospace" }}>
              {label}
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {btn("V1 LAN white", () => runV1Reset(d), "#34d399")}
              {btn("V2 per-seg white", () => runV2ResetAll(d))}
              {btn("V2 rainbow (1800ms)", () => runV2Rainbow(d, 1800))}
              {btn("BASELINE (V2+V2)", () => runBaseline(d, 1800), "#a5b4fc", "rgba(99,102,241,0.10)")}
              {btn("HYBRID (V1+V2)", () => runHybrid(d, 1800), "#fbbf24", "rgba(251,191,36,0.12)")}
            </div>
          </div>
        );
      })}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8, marginBottom: 4 }}>
        <div style={{ fontSize: 11, color: "#64748b" }}>Log:</div>
        <button
          onClick={() => setLog([])}
          style={{
            padding: "3px 8px", borderRadius: 6, border: "1px solid #334155",
            background: "transparent", color: "#64748b", fontSize: 10, cursor: "pointer",
          }}
        >Clear</button>
      </div>
      <pre style={{
        background: "#0f172a", border: "1px solid #1e293b", borderRadius: 8,
        padding: 10, margin: 0, fontSize: 11, color: "#cbd5e1",
        maxHeight: 280, overflow: "auto", whiteSpace: "pre-wrap", lineHeight: 1.4,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      }}>
        {log.length === 0 ? "(no events yet)" : log.join("\n")}
      </pre>
    </div>
  );
}
