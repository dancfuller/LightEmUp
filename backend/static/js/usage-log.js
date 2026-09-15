// UsageLogCard — Settings → Usage log (v3.49.0).
//
// The app is going to be reorganized around how the household actually uses it,
// and four people use it very differently. This card is where each phone or
// computer gets a name ("Marie's iPhone") and where the owner can see, per
// device, how often it's used and what for. The recording itself is `trackUse`
// in utils.js; storage and the summary are backend/usage_log.py.
//
// A device is a browser, not a person or a login. Before anyone names one, its
// browser and screen width tell the phones apart: an iPhone 17 Pro is 402px
// wide, a 16 Pro Max 440px, an iPhone 14 390px.

function UsageLogCard({ isMobile }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [drafts, setDrafts] = useState({});

  const load = useCallback(() => {
    api("/usage/summary?days=42").then(d => { setData(d); setErr(null); })
      .catch(e => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  const saveName = (id) => {
    const name = (drafts[id] ?? "").trim();
    api("/usage/device", { method: "POST", body: JSON.stringify({ device_id: id, name }) })
      .then(() => {
        setDrafts(d => { const next = { ...d }; delete next[id]; return next; });
        load();
      })
      .catch(e => setErr(e.message));
  };

  const pad = isMobile ? 14 : 20;
  const card = {
    background: "#0f172a", border: "1px solid #1e293b", borderRadius: 12,
    padding: pad, marginBottom: 20,
  };

  // This browser is listed first even before it has sent anything, so the one
  // thing the card asks for — "name this device" — is always possible.
  const rows = [...(data?.devices || [])];
  if (!rows.some(r => r.id === USAGE_DEVICE_ID)) {
    rows.unshift({ id: USAGE_DEVICE_ID, name: null, visits: 0, events: 0, acts: [], rooms: [] });
  }
  rows.sort((a, b) => (b.id === USAGE_DEVICE_ID) - (a.id === USAGE_DEVICE_ID));

  // "scenes · apply" / "room · off" read fine; only the surface prefix needs a word.
  const pretty = (label) => label.replace(/^room:/, "").replace(/^tab:/, "");

  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
        <h3 style={{ fontSize: isMobile ? 15 : 16, fontWeight: 700, color: "#f8fafc", margin: 0 }}>
          Usage log
        </h3>
        <button onClick={load} style={{
          marginLeft: "auto", background: "none", border: "1px solid #334155",
          borderRadius: 8, padding: "4px 10px", color: "#94a3b8", fontSize: 11,
          fontWeight: 600, cursor: "pointer",
        }}>Refresh</button>
      </div>
      <div style={{ fontSize: 12, color: "#64748b", lineHeight: 1.5, marginBottom: 14 }}>
        Records which screens and buttons each phone or computer uses, so the app can
        be arranged around how people really use it. It never records colors, names or
        anything typed, and it stays on the hub (it isn't part of backups). Name each
        device once so the numbers mean something.
      </div>

      {err && <div style={{ fontSize: 12, color: "#f87171", marginBottom: 10 }}>Couldn't load: {err}</div>}

      <div style={{ display: "grid", gap: 8 }}>
        {rows.map(r => {
          const mine = r.id === USAGE_DEVICE_ID;
          const draft = drafts[r.id];
          const shown = draft ?? (r.name || "");
          const dirty = draft !== undefined && draft.trim() !== (r.name || "");
          const meta = [r.browser, r.width ? `${r.width}px wide` : null,
                        r.last_seen ? `last used ${relativeTime(r.last_seen)}` : null]
            .filter(Boolean).join(" · ");
          const top = (r.acts || []).slice(0, 3).map(([k, n]) => `${pretty(k)} (${n})`).join(", ");
          return (
            <div key={r.id} style={{
              padding: "10px 12px", borderRadius: 10, background: "#0a0f1e",
              border: `1px solid ${mine ? "#4338ca" : "#1e293b"}`,
            }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <input
                  type="text" value={shown} maxLength={40}
                  placeholder={mine ? "Name this device" : "Unnamed device"}
                  onChange={(e) => setDrafts(d => ({ ...d, [r.id]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === "Enter" && dirty) saveName(r.id); }}
                  style={{
                    flex: "1 1 160px", minWidth: 0, padding: "6px 9px", borderRadius: 7,
                    border: "1px solid #334155", background: "#0f172a", color: "#e2e8f0",
                    fontSize: 13, fontWeight: 600,
                  }}
                />
                {mine && (
                  <span style={{
                    fontSize: 10, fontWeight: 700, color: "#a5b4fc",
                    border: "1px solid #4338ca", borderRadius: 6, padding: "2px 6px",
                  }}>THIS DEVICE</span>
                )}
                {dirty && (
                  <button onClick={() => saveName(r.id)} style={{
                    padding: "6px 12px", borderRadius: 7, border: "none",
                    background: "#6366f1", color: "#fff", fontSize: 12, fontWeight: 700,
                    cursor: "pointer",
                  }}>Save</button>
                )}
              </div>
              {meta && <div style={{ fontSize: 11, color: "#64748b", marginTop: 6 }}>{meta}</div>}
              <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 4, lineHeight: 1.5 }}>
                {r.events
                  ? `${r.visits} visit${r.visits === 1 ? "" : "s"} over ${r.active_days} day${r.active_days === 1 ? "" : "s"}`
                    + (top ? ` · mostly ${top}` : "")
                  : "Nothing recorded yet."}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
