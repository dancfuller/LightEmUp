// Ask — say or type what the lights should do (v3.60.0).
//
// AskBar is app chrome, directly under the Live bar on every tab: one text box.
// There is no microphone button on purpose — the phone keyboard's own dictation
// mic works in any text box, needs no permission prompt, and works over the Pi's
// plain http:// (an in-page mic would need HTTPS). The Pi does the rest: Claude
// Haiku 4.5 picks from a fixed list of LightEmUp actions, the Pi runs them on the
// same paths the buttons use, and one sentence comes back. See backend/ask.py.
//
// AskCard is the Settings card: the Anthropic API key, and what Ask has cost.

function AskBar({ enabled, onDone, isMobile }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState(null);   // {text, tone, awaiting}
  const inputRef = useRef(null);

  if (!enabled) return null;

  const send = async (words) => {
    const said = (words ?? text).trim();
    if (!said || busy) return;
    setBusy(true);
    setReply(null);
    trackUse("act", { s: "ask", a: words ? "answer" : "ask" });   // never the words
    try {
      const res = await api("/ask", { method: "POST", body: JSON.stringify({ text: said }) });
      setReply({
        text: res.reply,
        tone: res.error ? "error" : res.awaiting ? "ask" : (res.actions || []).length ? "done" : "info",
        awaiting: !!res.awaiting,
      });
      setText("");
      if ((res.actions || []).length) {
        // The Pi's own config event carries this page's id and is ignored as an
        // echo, so refresh here; a scene keeps landing for a few seconds after.
        onDone();
        setTimeout(onDone, 4000);
      }
    } catch (e) {
      setReply({ text: `Couldn't reach the hub: ${e.message}`, tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const toneColor = { done: "#86efac", ask: "#fcd34d", error: "#fca5a5", info: "#cbd5e1" };

  return (
    <div data-usage-surface="ask" style={{
      padding: isMobile ? "8px 10px" : "8px 24px",
      background: "rgba(2,6,23,0.55)", borderBottom: "1px solid #1e293b",
    }}>
      <form onSubmit={(e) => { e.preventDefault(); send(); }}
        style={{ display: "flex", gap: 8, alignItems: "center", maxWidth: 1200, margin: "0 auto" }}>
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={isMobile ? "Ask… (tap the keyboard mic to speak)" : "Ask LightEmUp… e.g. \"living room spooky but leave the hexa alone\""}
          enterKeyHint="send"
          autoComplete="off"
          autoCapitalize="sentences"
          disabled={busy}
          aria-label="Ask LightEmUp"
          style={{
            flex: "1 1 auto", minWidth: 0, padding: isMobile ? "9px 12px" : "8px 12px",
            borderRadius: 10, border: "1px solid #334155", background: "#0f172a",
            color: "#f1f5f9",
            fontSize: 16,   // under 16px, iOS zooms the page on focus
            outline: "none",
          }}
        />
        <button type="submit" disabled={busy || !text.trim()} style={{
          flex: "0 0 auto", padding: isMobile ? "9px 14px" : "8px 16px", borderRadius: 10,
          border: "1px solid #4f46e5", background: busy || !text.trim() ? "transparent" : "#4f46e5",
          color: busy || !text.trim() ? "#64748b" : "#fff", fontWeight: 700,
          fontSize: isMobile ? 13 : 14, cursor: busy || !text.trim() ? "default" : "pointer",
          whiteSpace: "nowrap",
        }}>{busy ? "…" : "Ask"}</button>
      </form>
      {(busy || reply) && (
        <div style={{
          maxWidth: 1200, margin: "6px auto 0", display: "flex", gap: 8,
          alignItems: "center", flexWrap: "wrap",
        }}>
          <span style={{ fontSize: isMobile ? 13 : 14, color: busy ? "#94a3b8" : toneColor[reply.tone], lineHeight: 1.4 }}>
            {busy ? "Thinking…" : reply.text}
          </span>
          {!busy && reply?.awaiting && (
            <span style={{ display: "inline-flex", gap: 6 }}>
              {["Yes", "No"].map(w => (
                <button key={w} onClick={() => send(w.toLowerCase())} style={{
                  padding: "5px 14px", borderRadius: 8, fontSize: 13, fontWeight: 700,
                  border: "1px solid #475569", cursor: "pointer",
                  background: w === "Yes" ? "#4f46e5" : "transparent",
                  color: w === "Yes" ? "#fff" : "#cbd5e1",
                }}>{w}</button>
              ))}
            </span>
          )}
          {!busy && !reply?.awaiting && (
            <button onClick={() => setReply(null)} aria-label="Dismiss" style={{
              background: "none", border: "none", color: "#64748b", cursor: "pointer",
              fontSize: 14, padding: "0 4px",
            }}>×</button>
          )}
        </div>
      )}
    </div>
  );
}


function AskCard({ isMobile, onKeyChanged }) {
  const [status, setStatus] = useState(null);
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    api("/ask/status").then(s => { setStatus(s); setErr(null); }).catch(e => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  const saveKey = (key) => {
    setSaving(true);
    api("/ask/key", { method: "POST", body: JSON.stringify({ key }) })
      .then(s => { setStatus(s); setDraft(""); setErr(null); onKeyChanged(); })
      .catch(e => setErr(e.message))
      .finally(() => setSaving(false));
  };

  const pad = isMobile ? 14 : 20;
  const stat = (label, value) => (
    <div style={{ flex: "1 1 110px", background: "#0b1222", border: "1px solid #1e293b", borderRadius: 10, padding: "8px 12px" }}>
      <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: isMobile ? 16 : 18, color: "#f1f5f9", fontWeight: 700 }}>{value}</div>
    </div>
  );

  return (
    <div style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 12, padding: pad, marginBottom: 20 }}>
      <h3 style={{ fontSize: isMobile ? 15 : 16, fontWeight: 700, color: "#f8fafc", margin: "0 0 4px" }}>Ask</h3>
      <div style={{ fontSize: 12, color: "#64748b", lineHeight: 1.5, marginBottom: 14 }}>
        Type or say what the lights should do in the box under the Live bar — "make the
        living room spooky but leave the hexa alone". On a phone, tap the microphone on the
        keyboard to speak. What you ask is sent to Anthropic's Claude Haiku 4.5, which
        chooses from LightEmUp's own actions; the hub carries them out. Anything aimed at the
        whole house asks first. A request costs about a cent or two.
      </div>

      {err && <div style={{ fontSize: 12, color: "#f87171", marginBottom: 10 }}>{err}</div>}

      {status && (
        <>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
            {stat("Status", status.enabled ? "On" : "Needs a key")}
            {stat("Today", `${status.today} of ${status.daily_cap}`)}
            {stat("This month", `${status.month_count} · $${(status.month_cost || 0).toFixed(2)}`)}
          </div>
          <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 6, fontWeight: 600 }}>
            Anthropic API key {status.enabled && <span style={{ color: "#86efac" }}>· saved on the hub</span>}
          </div>
          <form onSubmit={(e) => { e.preventDefault(); if (draft.trim()) saveKey(draft.trim()); }}
            style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input type="password" value={draft} onChange={(e) => setDraft(e.target.value)}
              placeholder={status.enabled ? "Replace the key (sk-ant-…)" : "sk-ant-…"}
              autoComplete="off" aria-label="Anthropic API key"
              style={{
                flex: "1 1 200px", minWidth: 0, padding: "8px 12px", borderRadius: 8,
                border: "1px solid #334155", background: "#0b1222", color: "#f1f5f9", fontSize: 14,
              }} />
            <button type="submit" disabled={saving || !draft.trim()} style={{
              padding: "8px 16px", borderRadius: 8, border: "1px solid #4f46e5",
              background: draft.trim() ? "#4f46e5" : "transparent",
              color: draft.trim() ? "#fff" : "#64748b", fontWeight: 700, fontSize: 13,
              cursor: draft.trim() ? "pointer" : "default",
            }}>Save key</button>
            {status.enabled && (
              <button type="button" disabled={saving} onClick={() => saveKey("")} style={{
                padding: "8px 14px", borderRadius: 8, border: "1px solid #7f1d1d",
                background: "transparent", color: "#fca5a5", fontWeight: 600, fontSize: 13, cursor: "pointer",
              }}>Remove key</button>
            )}
          </form>
          <div style={{ fontSize: 11, color: "#64748b", marginTop: 8, lineHeight: 1.5 }}>
            Create one at console.anthropic.com. It stays on the hub, is never shown again,
            and a backup made without credentials leaves it out.
          </div>
        </>
      )}
    </div>
  );
}
