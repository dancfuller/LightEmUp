// ─── Setup Wizard ───────────────────────────────────────────────────────────

function SetupWizard({ onComplete }) {
  const isMobile = useIsMobile();
  const [bridges, setBridges] = useState([]);
  const [selectedBridge, setSelectedBridge] = useState(null);
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState(null);
  const [loading, setLoading] = useState(false);

  const discoverBridges = async () => {
    setLoading(true);
    try {
      const data = await api("/discover/hue");
      setBridges(data.bridges || []);
      if (data.bridges?.length) setSelectedBridge(data.bridges[0]);
    } catch {}
    setLoading(false);
  };

  const pairBridge = async () => {
    if (!selectedBridge) return;
    setPairing(true);
    setPairError(null);
    try {
      await api("/hue/pair", {
        method: "POST",
        body: JSON.stringify({ ip: selectedBridge.ip }),
      });
      onComplete();
    } catch (e) {
      setPairError(e.message);
    }
    setPairing(false);
  };

  useEffect(() => { discoverBridges(); }, []);

  return (
    <div style={{
      maxWidth: 480, margin: isMobile ? "20px auto" : "80px auto", padding: isMobile ? 20 : 32,
      background: "linear-gradient(135deg, #1e293b 0%, #0f172a 100%)",
      borderRadius: 24, border: "1px solid #334155",
    }}>
      <div style={{ textAlign: "center", marginBottom: isMobile ? 20 : 32 }}>
        <div style={{ fontSize: isMobile ? 36 : 48, marginBottom: 12 }}>🔆</div>
        <h1 style={{ fontSize: isMobile ? 22 : 28, fontWeight: 800, color: "#f8fafc", margin: 0 }}>LightEmUp</h1>
        <p style={{ color: "#94a3b8", marginTop: 8 }}>Let's set up your Hue Bridge</p>
      </div>

      {loading ? (
        <div style={{ textAlign: "center", color: "#94a3b8", padding: 24 }}>Scanning network for Hue Bridges...</div>
      ) : bridges.length === 0 ? (
        <div style={{ textAlign: "center" }}>
          <p style={{ color: "#f87171" }}>No Hue Bridge found on the network.</p>
          <button onClick={discoverBridges} style={{
            padding: "10px 24px", borderRadius: 10, border: "none",
            background: "#6366f1", color: "#fff", fontSize: 14, cursor: "pointer",
          }}>Retry</button>
        </div>
      ) : (
        <div>
          <div style={{
            padding: 16, borderRadius: 12, background: "#0f172a",
            border: "1px solid #334155", marginBottom: 20,
          }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#f1f5f9" }}>Found: {selectedBridge?.ip}</div>
            <div style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>ID: {selectedBridge?.id}</div>
          </div>
          <div style={{
            padding: 16, borderRadius: 12, background: "rgba(99,102,241,0.1)",
            border: "1px solid rgba(99,102,241,0.3)", marginBottom: 20, textAlign: "center",
          }}>
            <p style={{ color: "#a5b4fc", fontSize: 14, margin: 0 }}>
              Press the <strong>button on your Hue Bridge</strong>, then click Pair below.
            </p>
          </div>
          {pairError && (
            <div style={{
              padding: 12, borderRadius: 10, background: "rgba(248,113,113,0.1)",
              border: "1px solid rgba(248,113,113,0.3)", marginBottom: 16,
              color: "#f87171", fontSize: 13, textAlign: "center",
            }}>{pairError}</div>
          )}
          <button onClick={pairBridge} disabled={pairing} style={{
            width: "100%", padding: "12px 24px", borderRadius: 12, border: "none",
            background: pairing ? "#475569" : "#6366f1",
            color: "#fff", fontSize: 15, fontWeight: 600, cursor: pairing ? "wait" : "pointer",
          }}>{pairing ? "Pairing..." : "Pair with Bridge"}</button>
        </div>
      )}
    </div>
  );
}
