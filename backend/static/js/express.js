// ExpressCard — Settings → LightEmUp Express (v3.63.0).
//
// Edits the buttons on /express, the plain-HTML page meant to be pinned to a phone's
// home screen (backend/static/express.html). Config key `express_buttons`, saved as a
// whole list (POST /api/express) and the backend's answer taken as the truth, like
// schedules: a button that silently failed to save would be found missing at bedtime.

const EXPRESS_WHITES = [
  { k: 2200, name: "Candlelight" },
  { k: 2700, name: "Incandescent" },
  { k: 3000, name: "Warm white" },
  { k: 4000, name: "Neutral white" },
  { k: 5000, name: "Daylight" },
  { k: 6500, name: "Cool white" },
];
const EXPRESS_LEVELS = [10, 25, 50, 75, 100];

function expressAutoLabel(b) {
  const who = b.target === "all" ? "All lights" : (b.name || "?");
  const a = b.action || {};
  if (a.type === "white") {
    const w = EXPRESS_WHITES.find(x => x.k === a.kelvin);
    return `${who} · ${w ? w.name : `${a.kelvin}K`} ${a.brightness}%`;
  }
  return `${who} ${a.on ? "on" : "off"}`;
}

function copyExpressLink(text, inputEl) {
  // The Pi is plain http, not a secure context, so navigator.clipboard is
  // usually missing; the select-and-copy fallback is the path that runs.
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).then(() => true, () => false);
  }
  try { inputEl.focus(); inputEl.select(); return Promise.resolve(document.execCommand("copy")); }
  catch (e) { return Promise.resolve(false); }
}

function ExpressCard({ rooms, zones, isMobile }) {
  const [buttons, setButtons] = useState(null);   // null = loading
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(null);
  const [drafts, setDrafts] = useState({});        // id → label being typed
  const linkRef = useRef(null);
  const roomNames = Object.keys(rooms || {}).sort((a, b) => a.localeCompare(b));
  const zoneNames = Object.keys(zones || {}).sort((a, b) => a.localeCompare(b));
  const url = `${window.location.origin}/express`;

  useEffect(() => {
    api("/express").then(r => setButtons(r.buttons || []),
                          () => setError("Couldn't load the Express buttons."));
  }, []);

  const save = (next) => {
    const before = buttons;
    setButtons(next); setSaving(true); setError(null);
    api("/express", { method: "POST", body: JSON.stringify({ buttons: next }) })
      .then(r => { setButtons(r.buttons || []); trackUse("act", { s: "settings", a: "express-edit" }); },
            e => { setButtons(before); setError(`Not saved: ${e.message || e}`); })
      .finally(() => setSaving(false));
  };

  // Change one button. A label the user never edited follows the button.
  const patch = (i, change) => {
    const old = buttons[i];
    const nb = { ...old, ...change, action: { ...old.action, ...(change.action || {}) } };
    if (change.action?.type === "power") { delete nb.action.kelvin; delete nb.action.brightness; }
    if (change.action?.type === "white") {
      nb.action = { type: "white", kelvin: old.action.kelvin || 2700, brightness: old.action.brightness || 100, ...change.action };
      delete nb.action.on;
    }
    if (nb.target === "all" && nb.action.type === "white") nb.action = { type: "power", on: true };
    if (!old.label || old.label === expressAutoLabel(old)) nb.label = expressAutoLabel(nb);
    save(buttons.map((b, j) => (j === i ? nb : b)));
  };
  const move = (i, d) => {
    const next = [...buttons];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    save(next);
  };
  const add = () => {
    const nb = roomNames.length
      ? { target: "room", name: roomNames[0], action: { type: "power", on: false } }
      : { target: "all", name: null, action: { type: "power", on: false } };
    save([...buttons, { ...nb, label: expressAutoLabel(nb) }]);
  };
  const commitLabel = (i, b) => {
    const v = drafts[b.id];
    setDrafts(d => { const n = { ...d }; delete n[b.id]; return n; });
    if (v === undefined || v.trim() === b.label) return;
    save(buttons.map((x, j) => (j === i ? { ...x, label: v.trim() || expressAutoLabel(x) } : x)));
  };

  const fieldLabel = { fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 };
  const chip = (active) => ({
    padding: "6px 10px", borderRadius: 8, cursor: "pointer", fontSize: 12, fontWeight: 700,
    border: `1px solid ${active ? "#6366f1" : "#334155"}`,
    background: active ? "rgba(99,102,241,0.15)" : "transparent",
    color: active ? "#c7d2fe" : "#94a3b8",
  });
  const iconBtn = (disabled) => ({
    width: 32, height: 32, borderRadius: 8, border: "1px solid #334155", background: "transparent",
    color: disabled ? "#334155" : "#94a3b8", cursor: disabled ? "default" : "pointer", fontSize: 14,
  });
  const select = {
    width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid #334155",
    background: "#0f172a", color: "#e2e8f0", fontSize: 13, fontWeight: 600, outline: "none",
  };

  return (
    <div style={{ background: "#1e293b", borderRadius: 16, padding: isMobile ? 16 : 20, border: "1px solid #334155", marginBottom: 16 }}>
      <h3 style={{ fontSize: 15, fontWeight: 600, color: "#e2e8f0", margin: 0, marginBottom: 6 }}>LightEmUp Express</h3>
      <div style={{ fontSize: 12, color: "#64748b", marginBottom: 12, lineHeight: 1.5 }}>
        A page of big buttons that opens almost instantly. Pin it to your phone's home screen
        for the things you do every night. Opening it changes nothing; each button acts when pressed.
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 6 }}>
        <input ref={linkRef} readOnly value={url} onFocus={(e) => e.target.select()}
          style={{ ...select, flex: "1 1 200px", width: "auto", fontFamily: "monospace", fontSize: 12, color: "#cbd5e1", fontWeight: 400 }} />
        <a href="/express" target="_blank" rel="noopener"
          style={{ padding: "8px 14px", borderRadius: 8, background: "#6366f1", color: "#fff", fontSize: 13, fontWeight: 700, textDecoration: "none" }}>
          Open Express
        </a>
        <button onClick={() => copyExpressLink(url, linkRef.current).then(ok => {
            setCopied(ok ? "Copied" : "Couldn't copy — select the link and copy it");
            setTimeout(() => setCopied(null), 2500);
          })}
          style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #334155", background: "transparent", color: "#e2e8f0", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
          Copy link
        </button>
        {copied && <span style={{ fontSize: 12, color: "#94a3b8" }}>{copied}</span>}
      </div>
      <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 16, lineHeight: 1.5 }}>
        On your phone: open it, then in Chrome tap <strong style={{ color: "#e2e8f0" }}>⋮ → Add to home screen</strong>.
      </div>

      <div style={fieldLabel}>Buttons {saving && <span style={{ textTransform: "none", color: "#818cf8" }}>· saving…</span>}</div>
      {buttons === null && !error && <div style={{ fontSize: 13, color: "#64748b" }}>Loading…</div>}
      {buttons && buttons.length === 0 && (
        <div style={{ fontSize: 13, color: "#64748b", marginBottom: 10 }}>No buttons yet.</div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {(buttons || []).map((b, i) => {
          const a = b.action || {};
          const kind = a.type === "white" ? "white" : a.on ? "on" : "off";
          const targetValue = b.target === "all" ? "all:" : `${b.target}:${b.name}`;
          const missing = b.target !== "all" && !(b.target === "room" ? roomNames : zoneNames).includes(b.name);
          return (
            <div key={b.id || i} data-express-row={i} style={{ border: "1px solid #334155", borderRadius: 12, padding: isMobile ? 10 : 12, background: "#0f172a" }}>
              <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 10 }}>
                <input value={drafts[b.id] ?? b.label} aria-label="Button label"
                  onChange={(e) => setDrafts(d => ({ ...d, [b.id]: e.target.value }))}
                  onBlur={() => commitLabel(i, b)}
                  onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }}
                  style={{ ...select, flex: 1, minWidth: 0, fontSize: 14, fontWeight: 700, borderRadius: 999, padding: "8px 14px" }} />
                <button title="Move up" disabled={i === 0} onClick={() => move(i, -1)} style={iconBtn(i === 0)}>↑</button>
                <button title="Move down" disabled={i === buttons.length - 1} onClick={() => move(i, 1)} style={iconBtn(i === buttons.length - 1)}>↓</button>
                <button title="Remove this button" onClick={() => save(buttons.filter((_, j) => j !== i))} style={iconBtn(false)}>✕</button>
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <div style={{ flex: "1 1 180px" }}>
                  <select value={targetValue} aria-label="Lights" style={select}
                    onChange={(e) => {
                      const [t, ...rest] = e.target.value.split(":");
                      patch(i, { target: t, name: t === "all" ? null : rest.join(":") });
                    }}>
                    <option value="all:">All lights</option>
                    {zoneNames.length > 0 && (
                      <optgroup label="Zones">{zoneNames.map(n => <option key={n} value={`zone:${n}`}>{n}</option>)}</optgroup>
                    )}
                    <optgroup label="Rooms">{roomNames.map(n => <option key={n} value={`room:${n}`}>{n}</option>)}</optgroup>
                    {missing && <option value={targetValue}>{b.name} (missing)</option>}
                  </select>
                </div>
                <div style={{ display: "flex", gap: 6, flex: "1 1 180px" }}>
                  <button style={{ ...chip(kind === "off"), flex: 1 }} onClick={() => patch(i, { action: { type: "power", on: false } })}>Off</button>
                  <button style={{ ...chip(kind === "on"), flex: 1 }} onClick={() => patch(i, { action: { type: "power", on: true } })}
                    title="Turn on to the last lighting">On</button>
                  {b.target !== "all" && (
                    <button style={{ ...chip(kind === "white"), flex: 1 }} onClick={() => patch(i, { action: { type: "white" } })}>White</button>
                  )}
                </div>
              </div>
              {kind === "white" && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                    {EXPRESS_WHITES.map(w => {
                      const rgb = kelvinToRGB(w.k);
                      return (
                        <button key={w.k} onClick={() => patch(i, { action: { type: "white", kelvin: w.k } })} style={chip(a.kelvin === w.k)}>
                          <span style={{ display: "inline-block", width: 9, height: 9, borderRadius: "50%", marginRight: 6, background: `rgb(${rgb.r},${rgb.g},${rgb.b})` }} />
                          {w.name}
                        </button>
                      );
                    })}
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {EXPRESS_LEVELS.map(l => (
                      <button key={l} onClick={() => patch(i, { action: { type: "white", brightness: l } })} style={chip(a.brightness === l)}>{l}%</button>
                    ))}
                  </div>
                </div>
              )}
              {missing && <div style={{ fontSize: 12, color: "#fbbf24", marginTop: 8 }}>"{b.name}" no longer exists. Pick other lights or remove this button.</div>}
            </div>
          );
        })}
      </div>
      {buttons && (
        <button onClick={add} disabled={buttons.length >= 24}
          style={{ marginTop: 12, padding: "8px 14px", borderRadius: 999, border: "1px dashed #475569", background: "transparent", color: "#cbd5e1", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
          + Add a button
        </button>
      )}
      {error && <div style={{ fontSize: 12, color: "#fca5a5", marginTop: 10 }}>{error}</div>}
    </div>
  );
}
