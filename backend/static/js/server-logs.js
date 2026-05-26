// ─── Server Logs Modal ────────────────────────────────────────────────────
// Reads the last N lines from /api/logs (48h hourly-rotating file set on
// the server). Supports level filtering, search, copy, and an optional
// auto-refresh tail every 3 seconds.

function ServerLogs({ onClose }) {
  const isMobile = useIsMobile();
  const [lines, setLines] = useState([]);
  const [available, setAvailable] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tail, setTail] = useState(true);
  const [level, setLevel] = useState("");
  const [search, setSearch] = useState("");
  const [lineCount, setLineCount] = useState(500);
  const scrollRef = useRef(null);

  const fetchLogs = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      params.set("lines", String(lineCount));
      if (level) params.set("level", level);
      const data = await api(`/logs?${params.toString()}`);
      setLines(data.lines || []);
      setAvailable(data.available || 0);
      setError(null);
    } catch (e) {
      setError(e?.message || "Failed to fetch logs");
    } finally {
      setLoading(false);
    }
  }, [lineCount, level]);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);

  // Auto-refresh every 3s while tail is on
  useEffect(() => {
    if (!tail) return;
    const id = setInterval(fetchLogs, 3000);
    return () => clearInterval(id);
  }, [tail, fetchLogs]);

  // Auto-scroll to bottom when new lines arrive and tail is on
  useEffect(() => {
    if (tail && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines, tail]);

  const filtered = search
    ? lines.filter(l => l.toLowerCase().includes(search.toLowerCase()))
    : lines;

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(filtered.join("\n"));
    } catch (e) {
      console.warn("clipboard write failed:", e);
    }
  };

  const colorFor = (line) => {
    if (/\bERROR\b/.test(line)) return "#fca5a5";
    if (/\bWARN/.test(line)) return "#fbbf24";
    if (/\bDEBUG\b/.test(line)) return "#64748b";
    return "#cbd5e1";
  };

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1000,
      background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: isMobile ? 8 : 24,
    }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: "100%", maxWidth: 1100, maxHeight: "92vh",
        background: "#0f172a", borderRadius: 16, border: "1px solid #334155",
        display: "flex", flexDirection: "column",
      }}>
        {/* Header */}
        <div style={{
          padding: isMobile ? 12 : 16, borderBottom: "1px solid #1e293b",
          display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8,
        }}>
          <div>
            <div style={{ fontSize: isMobile ? 15 : 17, fontWeight: 700, color: "#e2e8f0" }}>Server Logs</div>
            <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>
              48h retention &middot; {available.toLocaleString()} lines available
            </div>
          </div>
          <button onClick={onClose} style={{
            padding: "6px 14px", borderRadius: 8, border: "1px solid #334155",
            background: "transparent", color: "#94a3b8", fontSize: 13,
            fontWeight: 600, cursor: "pointer",
          }}>Close</button>
        </div>

        {/* Controls */}
        <div style={{
          padding: isMobile ? "10px 12px" : "12px 16px",
          borderBottom: "1px solid #1e293b",
          display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center",
        }}>
          <select value={level} onChange={e => setLevel(e.target.value)} style={{
            padding: "6px 8px", borderRadius: 6, border: "1px solid #334155",
            background: "#1e293b", color: "#e2e8f0", fontSize: 12,
          }}>
            <option value="">All levels</option>
            <option value="ERROR">ERROR</option>
            <option value="WARNING">WARNING</option>
            <option value="INFO">INFO</option>
            <option value="DEBUG">DEBUG</option>
          </select>
          <select value={lineCount} onChange={e => setLineCount(parseInt(e.target.value))} style={{
            padding: "6px 8px", borderRadius: 6, border: "1px solid #334155",
            background: "#1e293b", color: "#e2e8f0", fontSize: 12,
          }}>
            <option value={200}>Last 200</option>
            <option value={500}>Last 500</option>
            <option value={2000}>Last 2,000</option>
            <option value={10000}>Last 10,000</option>
          </select>
          <input
            type="text" placeholder="Search..." value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              flex: "1 1 160px", padding: "6px 10px", borderRadius: 6,
              border: "1px solid #334155", background: "#1e293b",
              color: "#e2e8f0", fontSize: 12,
            }}
          />
          <label style={{
            display: "flex", alignItems: "center", gap: 6,
            fontSize: 12, color: "#94a3b8", cursor: "pointer",
          }}>
            <input type="checkbox" checked={tail} onChange={e => setTail(e.target.checked)} />
            Auto-refresh
          </label>
          <button onClick={fetchLogs} style={{
            padding: "6px 12px", borderRadius: 6, border: "1px solid #334155",
            background: "transparent", color: "#a5b4fc", fontSize: 12,
            fontWeight: 600, cursor: "pointer",
          }}>Refresh</button>
          <button onClick={copyAll} style={{
            padding: "6px 12px", borderRadius: 6, border: "1px solid #334155",
            background: "transparent", color: "#a5b4fc", fontSize: 12,
            fontWeight: 600, cursor: "pointer",
          }}>Copy</button>
        </div>

        {/* Log viewport */}
        <div ref={scrollRef} style={{
          flex: 1, overflow: "auto", padding: "10px 14px",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          fontSize: isMobile ? 11 : 12, lineHeight: 1.45,
          background: "#020617",
        }}>
          {loading && <div style={{ color: "#64748b" }}>Loading…</div>}
          {error && <div style={{ color: "#fca5a5" }}>Error: {error}</div>}
          {!loading && !error && filtered.length === 0 && (
            <div style={{ color: "#64748b", fontStyle: "italic" }}>
              {lines.length === 0 ? "No log lines yet." : "No matches for current filter."}
            </div>
          )}
          {filtered.map((ln, i) => (
            <div key={i} style={{ color: colorFor(ln), whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
              {ln}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
