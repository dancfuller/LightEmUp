// DeliveryHealthCard — how often commands have had to be re-sent (v3.46.0).
//
// The failure this app fights hardest is invisible by nature: the Hue bridge
// returns 200 for a command the mesh then loses, so the light stays wrong and
// nothing in the app disagrees. The verify passes catch those now, but they only
// said so in the log — which meant noticing a TREND required someone to go and
// read journalctl on the Pi. This puts the same information where it can be
// glanced at.
//
// It is framed as a RATE, not a list of incidents, because that's the question
// worth asking: one dropped command is normal radio behavior, a dozen a day means
// something changed. The Zigbee channel sits next to the number for exactly the
// same reason — the usual cause of a rising count is a WiFi access point
// wandering onto it, and those two facts are only useful together.

function DeliveryHealthCard({ isMobile }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(() => {
    api("/health/delivery").then(setData).catch(e => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  const pad = isMobile ? 14 : 20;
  if (err) {
    return (
      <div style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 12,
                    padding: pad, marginBottom: 20 }}>
        <div style={{ fontSize: 12, color: "#f87171" }}>Delivery health unavailable: {err}</div>
      </div>
    );
  }
  if (!data) return null;

  const d24 = data.last_24h || 0;
  const d7 = data.last_7d || 0;
  // Thresholds are deliberately loose. A few re-sends a week is ordinary radio;
  // the point of the card is the shape of the trend, not a precise verdict.
  const tone = d24 >= 10 ? "#f87171" : d24 >= 3 ? "#fbbf24" : "#34d399";
  const verdict = d24 >= 10 ? "Something is interfering"
    : d24 >= 3 ? "A few commands are being lost"
    : d7 === 0 ? "Every command has landed first time"
    : "Normal — the occasional re-send";

  const peak = Math.max(1, ...(data.by_day || []).map(x => x.count));
  // A Hue light that wouldn't switch ("on") and a Govee one that wouldn't
  // ("power") are the same fact to whoever is reading this, so they share a
  // phrase — which means the tally has to be summed by the PHRASE, or the card
  // prints "wouldn't switch" twice with two different numbers.
  const KIND_WORDS = {
    on: "wouldn't switch", power: "wouldn't switch",
    brightness: "wrong level", color: "wrong color",
    unreachable: "off the network",
  };
  const kindWords = Object.entries(
    Object.entries(data.by_kind || {}).reduce((acc, [k, n]) => {
      const w = KIND_WORDS[k] || k;
      acc[w] = (acc[w] || 0) + n;
      return acc;
    }, {})
  ).sort((a, b) => b[1] - a[1]);

  return (
    <div style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 12,
                  padding: pad, marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap",
                    marginBottom: 4 }}>
        <h3 style={{ fontSize: isMobile ? 15 : 16, fontWeight: 700, color: "#f8fafc", margin: 0 }}>
          Delivery health
        </h3>
        <button onClick={load} style={{
          marginLeft: "auto", background: "none", border: "1px solid #334155",
          borderRadius: 8, padding: "4px 10px", color: "#94a3b8", fontSize: 11,
          fontWeight: 600, cursor: "pointer",
        }}>Refresh</button>
      </div>
      <div style={{ fontSize: 12, color: "#64748b", lineHeight: 1.5, marginBottom: 14 }}>
        A light can accept a command and never act on it — the bridge answers
        “OK” either way. These are the ones caught and re-sent.
      </div>

      <div style={{ display: "flex", gap: isMobile ? 12 : 24, flexWrap: "wrap",
                    alignItems: "flex-end", marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: isMobile ? 30 : 36, fontWeight: 800, color: tone, lineHeight: 1 }}>
            {d24}
          </div>
          <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>re-sent in 24h</div>
        </div>
        <div>
          <div style={{ fontSize: isMobile ? 22 : 26, fontWeight: 700, color: "#94a3b8", lineHeight: 1 }}>
            {d7}
          </div>
          <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>in 7 days</div>
        </div>
        <div style={{ flex: "1 1 160px", minWidth: 0 }}>
          <div style={{ fontSize: 12, color: tone, fontWeight: 700 }}>{verdict}</div>
          {data.zigbee_channel != null && (
            <div style={{ fontSize: 11, color: "#64748b", marginTop: 3, lineHeight: 1.5 }}>
              Zigbee channel <b style={{ color: "#94a3b8" }}>{data.zigbee_channel}</b>
              {" — if this count climbs, check no WiFi network has moved onto it."}
            </div>
          )}
        </div>
      </div>

      {/* The trend is the feature. Fourteen dense days, zeros included: a gap in a
          sparse chart reads as "no data" when it means "nothing went wrong". */}
      <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 46,
                    marginBottom: 6 }}>
        {(data.by_day || []).map(x => (
          <div key={x.date} title={`${x.date}: ${x.count}`} style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              height: Math.max(2, Math.round((x.count / peak) * 44)),
              background: x.count === 0 ? "#1e293b" : x.count >= 10 ? "#f87171"
                        : x.count >= 3 ? "#fbbf24" : "#334155",
              borderRadius: 2,
            }} />
          </div>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10,
                    color: "#475569", marginBottom: 14 }}>
        <span>{data.window_days} days ago</span><span>today</span>
      </div>

      {(data.by_device || []).length > 0 ? (
        <>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
                        textTransform: "uppercase", color: "#64748b", marginBottom: 8 }}>
            Worst offenders · 7 days
          </div>
          <div style={{ display: "grid", gap: 4 }}>
            {(showAll ? data.by_device : data.by_device.slice(0, 5)).map(dev => (
              <div key={dev.key} style={{
                display: "flex", alignItems: "center", gap: 8, padding: "6px 9px",
                background: "#0a0f1e", border: "1px solid #1e293b", borderRadius: 8,
              }}>
                <span style={{ flex: 1, fontSize: 12, color: "#e2e8f0", minWidth: 0,
                               overflow: "hidden", textOverflow: "ellipsis",
                               whiteSpace: "nowrap" }}>
                  {dev.label || dev.key}
                </span>
                <span style={{ fontSize: 11, color: "#64748b" }}>{relativeTime(dev.last_at)}</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: "#fbbf24",
                               minWidth: 22, textAlign: "right" }}>{dev.count}</span>
              </div>
            ))}
          </div>
          {data.by_device.length > 5 && (
            <button onClick={() => setShowAll(v => !v)} style={{
              background: "none", border: "none", padding: "8px 0 0", cursor: "pointer",
              color: "#64748b", fontSize: 11, textDecoration: "underline",
            }}>{showAll ? "Show fewer" : `Show all ${data.by_device.length}`}</button>
          )}
          {kindWords.length > 0 && (
            <div style={{ fontSize: 11, color: "#64748b", marginTop: 12, lineHeight: 1.6 }}>
              {kindWords.map(([word, n]) => (
                <span key={word} style={{ marginRight: 12 }}>
                  <b style={{ color: "#94a3b8" }}>{n}</b> {word}
                </span>
              ))}
            </div>
          )}
        </>
      ) : (
        <div style={{ fontSize: 12, color: "#64748b", lineHeight: 1.5 }}>
          Nothing recorded in the last {data.window_days} days. Every command has
          landed on the first try.
        </div>
      )}
    </div>
  );
}
