// ─── Zones ──────────────────────────────────────────────────────────────────
//
// A zone is a named group of ROOMS ("Upstairs", "Downstairs", "Outside").
//
// Zones shipped in v3.9.0 as a scheduling target only, and their management UI
// lived inside the Schedules tab. That was the wrong shape twice over: the
// everyday use of a zone is a panic button — "all downstairs off" on the way to
// bed — and grouping rooms is an organisational act that belongs next to
// assigning devices to rooms, not buried under automation. So:
//   * ZoneBar   — live on/off controls in the global bar, on every tab.
//   * ZoneManager — create/edit/delete, in Assign Rooms next to the rooms it groups.
// Schedules still TARGET zones; it just no longer owns them.

// Quick actions. Sits in the app-wide bar beside "All Off", so a zone is one tap
// away wherever you are — which is the whole point of a scram button.
function ZoneBar({ zones, onControl, isMobile }) {
  const [busy, setBusy] = useState(null);   // `${zone}|${on}` currently in flight
  const names = Object.keys(zones || {});
  if (names.length === 0) return null;      // nothing to show until a zone exists

  const press = async (name, on) => {
    const key = `${name}|${on}`;
    setBusy(key);
    try { await onControl(name, { type: "power", on }); }
    finally { setBusy(b => (b === key ? null : b)); }
  };

  const btn = (name, on) => {
    const key = `${name}|${on}`;
    const active = busy === key;
    return (
      <button
        onClick={() => press(name, on)}
        disabled={!!busy}
        title={`Turn every light in ${name} ${on ? "on (resume each room's last lighting)" : "off"}`}
        style={{
          padding: isMobile ? "4px 9px" : "4px 11px",
          borderRadius: 7, border: "1px solid transparent",
          background: active ? "rgba(99,102,241,0.35)"
            : on ? "rgba(99,102,241,0.16)" : "rgba(148,163,184,0.10)",
          color: on ? "#c7d2fe" : "#cbd5e1",
          fontSize: isMobile ? 11 : 12, fontWeight: 700,
          cursor: busy ? "wait" : "pointer", whiteSpace: "nowrap",
        }}
      >{active ? "…" : (on ? "On" : "Off")}</button>
    );
  };

  return (
    <>
      <span style={{
        fontSize: 11, color: "#64748b", fontWeight: 700, textTransform: "uppercase",
        letterSpacing: 0.6, marginLeft: isMobile ? 0 : 10, marginRight: 2,
      }}>Zones</span>
      {names.map(name => (
        <span key={name}
          title={(zones[name]?.rooms || []).join(", ") || "no rooms in this zone"}
          style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            padding: isMobile ? "3px 4px 3px 9px" : "3px 5px 3px 11px",
            borderRadius: 9, border: "1px solid #334155", background: "rgba(15,23,42,0.5)",
          }}
        >
          <span style={{
            fontSize: isMobile ? 11 : 12, fontWeight: 700, color: "#e2e8f0",
            maxWidth: isMobile ? 90 : 160, overflow: "hidden",
            textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>{name}</span>
          {btn(name, true)}
          {btn(name, false)}
        </span>
      ))}
    </>
  );
}

// Create / edit / delete. Lives in Assign Rooms — a zone groups rooms the same
// way a room groups devices, so both live on the same organisational tab.
function ZoneManager({ zones, rooms, onSaveZone, onDeleteZone, onRenameZone, isMobile }) {
  const [editing, setEditing] = useState(null);   // null | {name, rooms} draft
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [saveError, setSaveError] = useState("");
  const zoneNames = Object.keys(zones || {});

  const startNew = () => { setSaveError(""); setEditing({ name: "", rooms: [], _isNew: true }); };
  // _original remembers the name we opened with, so save can tell a rename from
  // an ordinary membership edit.
  const startEdit = (name) => {
    setSaveError("");
    setEditing({ name, _original: name, rooms: [...(zones[name]?.rooms || [])] });
  };
  const toggleRoom = (r) => setEditing(e => ({
    ...e, rooms: e.rooms.includes(r) ? e.rooms.filter(x => x !== r) : [...e.rooms, r],
  }));
  const saveDraft = async () => {
    const nm = (editing.name || "").trim();
    if (!nm) return;
    setSaveError("");
    // Rename FIRST, then save membership under the new name. The other order
    // would upsert a second zone and strand the original along with any
    // schedule pointing at it.
    if (editing._original && nm !== editing._original) {
      const res = onRenameZone ? await onRenameZone(editing._original, nm) : true;
      if (res !== true) { setSaveError(typeof res === "string" ? res : "Rename failed"); return; }
    }
    await onSaveZone(nm, editing.rooms);
    setEditing(null);
  };

  const card = {
    background: "#1e293b", borderRadius: 16, padding: isMobile ? 12 : 16,
    marginBottom: 18, border: "1px solid #334155",
  };
  const chip = (active) => ({
    padding: isMobile ? "6px 10px" : "6px 12px", borderRadius: 8,
    border: active ? "1px solid #6366f1" : "1px solid #334155",
    background: active ? "rgba(99,102,241,0.18)" : "transparent",
    color: active ? "#c7d2fe" : "#94a3b8",
    fontSize: isMobile ? 11 : 12, fontWeight: 600, cursor: "pointer",
  });
  const field = {
    padding: "8px 10px", borderRadius: 8, border: "1px solid #334155",
    background: "#0f172a", color: "#e2e8f0", fontSize: 13, width: "100%",
  };

  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: isMobile ? 15 : 16, fontWeight: 700, color: "#e2e8f0" }}>
            Zones <span style={{ fontSize: 12, color: "#64748b", fontWeight: 400 }}>({zoneNames.length})</span>
          </div>
          <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>
            Groups of rooms you can switch together
          </div>
        </div>
        {!editing && (
          <button onClick={startNew} style={{
            padding: "6px 12px", borderRadius: 8, border: "1px solid #6366f1",
            background: "transparent", color: "#a5b4fc", fontSize: 12, fontWeight: 600, cursor: "pointer",
          }}>+ New zone</button>
        )}
      </div>

      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 12, color: "#64748b", marginBottom: 12, lineHeight: 1.6 }}>
          A zone gets <strong>On / Off</strong> buttons in the bar at the top of every page —
          so "all upstairs off" is one tap from anywhere. Schedules can target a zone too.
          A room can belong to several zones.
        </div>

        {editing && (
          <div style={{
            background: "#0f172a", borderRadius: 12, padding: 12, marginBottom: 12,
            border: "1px solid #4338ca",
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", marginBottom: 6 }}>
              Zone name
            </div>
            {/* Editable for existing zones too (v3.15.0). It used to be disabled
                because renaming wasn't supported and saving under a new name would
                have created a duplicate; /api/zones/rename now migrates the
                schedules that reference it. */}
            <input value={editing.name}
              onChange={e => setEditing({ ...editing, name: e.target.value })}
              onFocus={e => e.target.select()}
              placeholder="Upstairs" style={{ ...field, marginBottom: 6 }} />
            {editing._original && editing.name.trim() && editing.name.trim() !== editing._original && (
              <div style={{ fontSize: 11, color: "#fbbf24", marginBottom: 12 }}>
                Renaming “{editing._original}” → “{editing.name.trim()}”. Schedules
                targeting this zone follow the new name.
              </div>
            )}
            {saveError && (
              <div style={{ fontSize: 11, color: "#f87171", marginBottom: 12 }}>{saveError}</div>
            )}
            <div style={{ marginBottom: 12 }} />
            <div style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", marginBottom: 6 }}>
              Rooms in this zone
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
              {rooms.length === 0 && <span style={{ fontSize: 12, color: "#64748b" }}>No rooms yet.</span>}
              {rooms.map(r => (
                <button key={r} style={chip(editing.rooms.includes(r))} onClick={() => toggleRoom(r)}>{r}</button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button onClick={saveDraft} disabled={!editing.name.trim()} style={{
                padding: "7px 16px", borderRadius: 8, border: "none",
                background: editing.name.trim() ? "#6366f1" : "#334155",
                color: editing.name.trim() ? "#fff" : "#64748b",
                fontSize: 12, fontWeight: 700, cursor: editing.name.trim() ? "pointer" : "default",
              }}>Save zone</button>
              <button onClick={() => setEditing(null)} style={{
                padding: "7px 16px", borderRadius: 8, border: "1px solid #334155",
                background: "transparent", color: "#94a3b8", fontSize: 12, fontWeight: 600, cursor: "pointer",
              }}>Cancel</button>
            </div>
          </div>
        )}

        {zoneNames.length === 0 && !editing && (
          <div style={{ fontSize: 12, color: "#64748b" }}>
            No zones yet — try one for each floor, plus an outdoor one.
          </div>
        )}
        {zoneNames.map(z => (
          <div key={z} style={{
            display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap",
            padding: "8px 0", borderTop: "1px solid #1e293b",
          }}>
            <div style={{ flex: "1 1 180px", minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0" }}>{z}</div>
              <div style={{ fontSize: 12, color: "#64748b" }}>
                {(zones[z]?.rooms || []).join(", ") || "no rooms"}
              </div>
            </div>
            <button onClick={() => startEdit(z)} style={{
              padding: "5px 10px", borderRadius: 8, border: "1px solid #334155",
              background: "transparent", color: "#94a3b8", fontSize: 12, fontWeight: 600, cursor: "pointer",
            }}>Edit</button>
            {confirmDelete === z ? (
              <button onClick={() => { onDeleteZone(z); setConfirmDelete(null); }} style={{
                padding: "5px 10px", borderRadius: 8, border: "none",
                background: "#ef4444", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer",
              }}>Confirm</button>
            ) : (
              <button onClick={() => setConfirmDelete(z)} style={{
                padding: "5px 10px", borderRadius: 8, border: "1px solid #7f1d1d",
                background: "transparent", color: "#f87171", fontSize: 12, fontWeight: 600, cursor: "pointer",
              }}>Delete</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
