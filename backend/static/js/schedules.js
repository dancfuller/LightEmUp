// Schedules tab — time-based automation.
//
// A schedule pairs a TRIGGER (weekly / one-off / sunrise-sunset) with an ACTION
// (a captured color scene, a white temperature, or a single color) for one room.
//
// Scene actions are SNAPSHOTS, not recipes. All the scene math (palette,
// gradient, beacon, teams…) lives in color-mode.js in the browser, so a schedule
// stores the fully-resolved apply plan captured by "Schedule this look" — the
// backend replays it verbatim. That's also why a scene can't be authored here:
// you build the look in the room's Scenes panel and capture it.

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];   // 0 = Monday, matching Python's weekday()
const DAY_PRESETS = [
  { label: "Every day", days: [0, 1, 2, 3, 4, 5, 6] },
  { label: "Weekdays", days: [0, 1, 2, 3, 4] },
  { label: "Weekends", days: [5, 6] },
];
const WHITE_PRESETS = [
  { label: "Soft White", kelvin: 2700, tint: "#fbbf24" },
  { label: "Neutral", kelvin: 4000, tint: "#fde68a" },
  { label: "Cool White", kelvin: 6500, tint: "#93c5fd" },
];

function pad2(n) { return String(n).padStart(2, "0"); }

// "07:00" → "7:00 AM" — schedules are read at a glance, so 12-hour reads better
// than the 24-hour value we store.
function prettyTime(hhmm) {
  const [h, m] = (hhmm || "").split(":").map(Number);
  if (isNaN(h) || isNaN(m)) return hhmm || "--:--";
  const ampm = h < 12 ? "AM" : "PM";
  return `${((h + 11) % 12) + 1}:${pad2(m)} ${ampm}`;
}

function prettyDays(days) {
  if (!days || !days.length) return "never";
  const preset = DAY_PRESETS.find(p => p.days.length === days.length && p.days.every(d => days.includes(d)));
  if (preset) return preset.label.toLowerCase();
  return [...days].sort((a, b) => a - b).map(d => DAY_LABELS[d]).join(", ");
}

function prettyOffset(min) {
  const n = Number(min || 0);
  if (!n) return "";
  return n < 0 ? ` ${Math.abs(n)} min before` : ` ${n} min after`;
}

function triggerSummary(trig) {
  if (!trig) return "No trigger";
  if (trig.type === "weekly") return `${prettyTime(trig.time)} · ${prettyDays(trig.days)}`;
  if (trig.type === "oneoff") return `${trig.date} at ${prettyTime(trig.time)} · once`;
  if (trig.type === "sun") {
    const ev = trig.event === "sunset" ? "sunset" : "sunrise";
    const off = prettyOffset(trig.offset_min);
    return `${off ? off.trim() + " " : ""}${ev} · ${prettyDays(trig.days)}`.replace(/^(\d+ min (?:before|after)) /, "$1 ");
  }
  return "Unknown trigger";
}

function actionSummary(action) {
  if (!action) return "No action";
  if (action.type === "scene") {
    const p = action.payload || {};
    const n = (p.hue?.length || 0) + (p.govee_whole?.length || 0)
      + (p.razer?.length || 0) + (p.cloud?.length || 0);
    return `Scene · ${n} device${n === 1 ? "" : "s"}`;
  }
  if (action.type === "white") return `White ${action.kelvin}K · ${action.brightness}%`;
  if (action.type === "color") {
    const c = action.rgb || {};
    return `Color rgb(${c.r}, ${c.g}, ${c.b}) · ${action.brightness}%`;
  }
  if (action.type === "power") return action.on === false ? "Turn off" : "Turn on";
  return "Unknown action";
}

// The room or zone a schedule targets, for the list row.
function targetSummary(action) {
  if (!action) return "";
  return action.zone ? `Zone: ${action.zone}` : (action.room || "");
}

// Next fire time for weekly/one-off, purely client-side for the "next run" hint.
// Sun triggers need the Pi's astral computation, so they get a text hint instead
// of a wrong guess.
function nextRunLabel(sched) {
  const trig = sched.trigger || {};
  if (!sched.enabled) return "Disabled";
  if (trig.type === "sun") return "At " + (trig.event === "sunset" ? "sunset" : "sunrise");
  const [h, m] = (trig.time || "").split(":").map(Number);
  if (isNaN(h) || isNaN(m)) return "—";
  const now = new Date();

  if (trig.type === "oneoff") {
    if (!trig.date) return "—";
    const [y, mo, d] = trig.date.split("-").map(Number);
    const when = new Date(y, mo - 1, d, h, m);
    if (when <= now) return "Passed";
    return when.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  const days = trig.days || [];
  if (!days.length) return "Never";
  for (let i = 0; i < 8; i++) {
    const cand = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, h, m);
    // JS getDay() is 0=Sunday; our storage is 0=Monday (Python weekday()).
    const pyDay = (cand.getDay() + 6) % 7;
    if (days.includes(pyDay) && cand > now) {
      return i === 0 ? `Today ${prettyTime(trig.time)}`
        : i === 1 ? `Tomorrow ${prettyTime(trig.time)}`
        : `${DAY_LABELS[pyDay]} ${prettyTime(trig.time)}`;
    }
  }
  return "—";
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// ─── Editor ─────────────────────────────────────────────────────────────────

function ScheduleEditor({ initial, rooms, zoneNames, favorites, onFavoritesChange, onSave, onCancel, isMobile }) {
  const [name, setName] = useState(initial?.name || "");
  const [trigger, setTrigger] = useState(initial?.trigger || { type: "weekly", time: "07:00", days: [0, 1, 2, 3, 4] });
  const [action, setAction] = useState(initial?.action || { type: "white", room: rooms[0] || "", kelvin: 2700, brightness: 100 });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // A captured scene can't be re-authored here — the look came from the color
  // tool. You can retarget everything else about it, just not rebuild it.
  const isScene = action.type === "scene";
  // Target is a room OR a zone (a group of rooms). A scene is always room-only
  // (it's a device-specific snapshot); a zone fans white/color/power out.
  const isZone = !!action.zone;
  const patchTrigger = (p) => setTrigger(prev => ({ ...prev, ...p }));
  const patchAction = (p) => setAction(prev => ({ ...prev, ...p }));

  // Switch the target between a single room and a zone, adding/removing the
  // right key (patchAction only merges, so removal needs an explicit rebuild).
  const setTargetKind = (kind) => setAction(prev => {
    const { room, zone, ...rest } = prev;
    return kind === "zone"
      ? { ...rest, zone: zone || (zoneNames[0] || "") }
      : { ...rest, room: room || (rooms[0] || "") };
  });

  const toggleDay = (d) => {
    const days = trigger.days || [];
    patchTrigger({ days: days.includes(d) ? days.filter(x => x !== d) : [...days, d].sort((a, b) => a - b) });
  };

  const submit = async () => {
    if (isZone) { if (!action.zone) { setError("Pick a zone."); return; } }
    else if (!action.room) { setError("Pick a room."); return; }
    if (trigger.type !== "sun" && !/^\d{2}:\d{2}$/.test(trigger.time || "")) { setError("Pick a time."); return; }
    if (trigger.type === "oneoff" && !trigger.date) { setError("Pick a date."); return; }
    if (trigger.type !== "oneoff" && !(trigger.days || []).length) { setError("Pick at least one day."); return; }
    setSaving(true); setError(null);
    try {
      await onSave({
        id: initial?.id || undefined,
        name: name.trim() || `${action.zone || action.room} ${trigger.type === "sun" ? trigger.event : prettyTime(trigger.time)}`,
        enabled: initial ? initial.enabled : true,
        trigger, action,
      });
    } catch (e) {
      setError("Couldn't save — " + (e?.message || "the hub didn't accept it."));
      setSaving(false);
    }
  };

  const label = { fontSize: 11, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 };
  const field = {
    padding: "8px 10px", borderRadius: 8, border: "1px solid #334155",
    background: "#0f172a", color: "#e2e8f0", fontSize: 13, width: "100%",
  };
  const seg = (active) => ({
    padding: isMobile ? "7px 10px" : "7px 14px", borderRadius: 8,
    border: active ? "1px solid #6366f1" : "1px solid #334155",
    background: active ? "rgba(99,102,241,0.18)" : "transparent",
    color: active ? "#c7d2fe" : "#94a3b8",
    fontSize: isMobile ? 11 : 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
  });

  return (
    <div style={{
      background: "#1e293b", borderRadius: 16, padding: isMobile ? 14 : 20,
      marginBottom: 16, border: "1px solid #6366f1",
    }}>
      <div style={{ fontSize: isMobile ? 15 : 17, fontWeight: 700, color: "#e2e8f0", marginBottom: 16 }}>
        {initial?.id ? "Edit schedule" : "New schedule"}
      </div>

      <div style={{ marginBottom: 16 }}>
        <div style={label}>Name</div>
        <input value={name} onChange={e => setName(e.target.value)}
          placeholder="Morning Ocean" style={field} />
      </div>

      {/* ─── Target: room or zone ───────────────────────────────────── */}
      <div style={{ marginBottom: 16 }}>
        <div style={label}>Apply to</div>
        {/* A scene is room-only, so the Room/Zone toggle is hidden for it. */}
        {!isScene && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
            <button style={seg(!isZone)} onClick={() => setTargetKind("room")}>A room</button>
            <button style={seg(isZone)}
              onClick={() => setTargetKind("zone")}
              disabled={zoneNames.length === 0}
              title={zoneNames.length === 0 ? "Create a zone below first" : "A group of rooms"}>
              A zone
            </button>
          </div>
        )}
        {isZone ? (
          <select value={action.zone} onChange={e => patchAction({ zone: e.target.value })} style={field}>
            {!action.zone && <option value="">Pick a zone…</option>}
            {zoneNames.map(z => <option key={z} value={z}>{z}</option>)}
          </select>
        ) : (
          <select value={action.room} onChange={e => patchAction({ room: e.target.value })}
            disabled={isScene} style={{ ...field, opacity: isScene ? 0.6 : 1 }}>
            {!action.room && <option value="">Pick a room…</option>}
            {rooms.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        )}
      </div>

      {/* ─── Action ─────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 16 }}>
        <div style={label}>Do what</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
          {isScene && <button style={seg(true)} disabled>Captured scene</button>}
          {!isScene && (
            <>
              <button style={seg(action.type === "white")}
                onClick={() => patchAction({ type: "white", kelvin: action.kelvin || 2700, brightness: action.brightness ?? 100 })}>White</button>
              <button style={seg(action.type === "color")}
                onClick={() => patchAction({ type: "color", rgb: action.rgb || { r: 255, g: 180, b: 100 }, brightness: action.brightness ?? 100 })}>Color</button>
              <button style={seg(action.type === "power")}
                onClick={() => patchAction({ type: "power", on: action.on ?? true })}>On / Off</button>
            </>
          )}
        </div>

        {isScene && (
          <div style={{
            padding: 12, borderRadius: 10, background: "rgba(99,102,241,0.10)",
            border: "1px solid #4338ca", fontSize: 12, color: "#c7d2fe", marginBottom: 12,
          }}>
            {actionSummary(action)} — captured from the color tool in{" "}
            <strong>{action.room}</strong>. To change the look, build it again in that
            room's Scenes panel and capture it fresh.
          </div>
        )}

        {action.type === "power" && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
            <button style={seg(action.on !== false)} onClick={() => patchAction({ on: true })}>Turn on</button>
            <button style={seg(action.on === false)} onClick={() => patchAction({ on: false })}>Turn off</button>
          </div>
        )}

        {action.type === "white" && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
            {WHITE_PRESETS.map(p => (
              <button key={p.kelvin} onClick={() => patchAction({ kelvin: p.kelvin })}
                style={{ ...seg(action.kelvin === p.kelvin), color: action.kelvin === p.kelvin ? p.tint : "#94a3b8" }}>
                {p.label} · {p.kelvin}K
              </button>
            ))}
          </div>
        )}

        {action.type === "color" && (
          <div style={{ marginBottom: 12 }}>
            <ColorPicker
              currentColor={action.rgb}
              onColorSelect={(r, g, b) => patchAction({ rgb: { r, g, b } })}
              favorites={favorites} onFavoritesChange={onFavoritesChange}
            />
          </div>
        )}

        {(action.type === "white" || action.type === "color") && (
          <div style={{ marginBottom: 12 }}>
            <div style={label}>Brightness · {action.brightness}%</div>
            <input type="range" min={1} max={100} value={action.brightness}
              onChange={e => patchAction({ brightness: Number(e.target.value) })}
              style={{ width: "100%", accentColor: "#6366f1" }} />
          </div>
        )}
      </div>

      {/* ─── Trigger ────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 16 }}>
        <div style={label}>When</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
          <button style={seg(trigger.type === "weekly")}
            onClick={() => setTrigger({ type: "weekly", time: trigger.time || "07:00", days: trigger.days || [0, 1, 2, 3, 4] })}>Weekly</button>
          <button style={seg(trigger.type === "oneoff")}
            onClick={() => setTrigger({ type: "oneoff", time: trigger.time || "07:00", date: trigger.date || todayISO() })}>Once</button>
          <button style={seg(trigger.type === "sun")}
            onClick={() => setTrigger({ type: "sun", event: trigger.event || "sunset", offset_min: trigger.offset_min || 0, days: trigger.days || [0, 1, 2, 3, 4, 5, 6] })}>Sunrise / sunset</button>
        </div>

        {trigger.type === "sun" ? (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
            <div style={{ flex: "1 1 140px" }}>
              <div style={label}>Event</div>
              <select value={trigger.event} onChange={e => patchTrigger({ event: e.target.value })} style={field}>
                <option value="sunrise">Sunrise</option>
                <option value="sunset">Sunset</option>
              </select>
            </div>
            <div style={{ flex: "1 1 140px" }}>
              <div style={label}>Offset (minutes)</div>
              <input type="number" step={5} value={trigger.offset_min ?? 0}
                onChange={e => patchTrigger({ offset_min: Number(e.target.value) })}
                style={field} />
              <div style={{ fontSize: 10, color: "#64748b", marginTop: 4 }}>
                Negative = before, positive = after.
              </div>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
            <div style={{ flex: "1 1 140px" }}>
              <div style={label}>Time</div>
              <input type="time" value={trigger.time || ""}
                onChange={e => patchTrigger({ time: e.target.value })} style={field} />
            </div>
            {trigger.type === "oneoff" && (
              <div style={{ flex: "1 1 140px" }}>
                <div style={label}>Date</div>
                <input type="date" value={trigger.date || ""} min={todayISO()}
                  onChange={e => patchTrigger({ date: e.target.value })} style={field} />
              </div>
            )}
          </div>
        )}

        {trigger.type !== "oneoff" && (
          <div>
            <div style={label}>On these days</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
              {DAY_LABELS.map((d, i) => (
                <button key={d} onClick={() => toggleDay(i)} style={{
                  ...seg((trigger.days || []).includes(i)),
                  minWidth: 44, textAlign: "center", padding: "7px 8px",
                }}>{d}</button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {DAY_PRESETS.map(p => (
                <button key={p.label} onClick={() => patchTrigger({ days: [...p.days] })}
                  style={{ ...seg(false), fontSize: 11, padding: "5px 10px" }}>{p.label}</button>
              ))}
            </div>
          </div>
        )}
      </div>

      {error && (
        <div style={{ fontSize: 12, color: "#f87171", marginBottom: 12 }}>{error}</div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button onClick={submit} disabled={saving} style={{
          padding: "8px 20px", borderRadius: 8, border: "none",
          background: saving ? "#334155" : "#6366f1", color: saving ? "#64748b" : "#fff",
          fontSize: 13, fontWeight: 700, cursor: saving ? "wait" : "pointer",
        }}>{saving ? "Saving…" : "Save schedule"}</button>
        <button onClick={onCancel} style={{
          padding: "8px 20px", borderRadius: 8, border: "1px solid #334155",
          background: "transparent", color: "#94a3b8", fontSize: 13, fontWeight: 600, cursor: "pointer",
        }}>Cancel</button>
      </div>
    </div>
  );
}

// ZoneManager moved to zones.js (v3.15.0). Zones are no longer a
// schedules-only concept: they have live On/Off controls in the global bar
// and are managed in Assign Rooms, next to the rooms they group. This tab
// still TARGETS zones (see the Room/Zone toggle in ScheduleEditor); it just
// no longer owns them.

// ─── Tab ────────────────────────────────────────────────────────────────────

function SchedulesTab({ schedules, rooms, zones, location, favorites, onFavoritesChange,
                        onSave, onDelete, onSaveZone, onDeleteZone, pendingScene, onConsumePending }) {
  const isMobile = useIsMobile();
  const [editing, setEditing] = useState(null);   // null | {} (new) | schedule
  const [confirmDelete, setConfirmDelete] = useState(null);
  const zoneNames = Object.keys(zones || {});

  // A look captured by "Schedule this look" lands here: open the editor
  // pre-filled with that scene, then clear the handoff so a later tab visit
  // doesn't reopen it.
  useEffect(() => {
    if (!pendingScene) return;
    setEditing({
      action: { type: "scene", room: pendingScene.room, payload: pendingScene.plan },
      trigger: { type: "weekly", time: "07:00", days: [0, 1, 2, 3, 4] },
    });
    onConsumePending();
  }, [pendingScene]);

  const needsLocation = schedules.some(s => s.trigger?.type === "sun")
    && (location?.lat == null || location?.lng == null);

  const save = async (sched) => {
    await onSave(sched);
    setEditing(null);
  };

  const card = {
    background: "#1e293b", borderRadius: 16, padding: isMobile ? 12 : 16,
    marginBottom: 10, border: "1px solid #334155",
  };

  return (
    <div style={{ padding: isMobile ? "12px 10px" : "20px 24px", maxWidth: 900, margin: "0 auto" }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        gap: 10, flexWrap: "wrap", marginBottom: 16,
      }}>
        <div>
          <div style={{ fontSize: isMobile ? 17 : 20, fontWeight: 700, color: "#e2e8f0" }}>Schedules</div>
          <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>
            The hub runs these on its own — no browser needed.
          </div>
        </div>
        {!editing && (
          <button onClick={() => setEditing({})} style={{
            padding: "8px 16px", borderRadius: 8, border: "none",
            background: "#6366f1", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer",
          }}>+ New schedule</button>
        )}
      </div>

      {needsLocation && (
        <div style={{
          padding: 12, borderRadius: 10, marginBottom: 12,
          background: "rgba(251,191,36,0.10)", border: "1px solid #b45309",
          fontSize: 12, color: "#fcd34d",
        }}>
          A sunrise/sunset schedule needs your location to know when the sun rises.
          Set it in <strong>Settings → Location</strong> — until then those schedules
          won't fire.
        </div>
      )}

      {editing && (
        <ScheduleEditor
          initial={editing.id || editing.action ? editing : null}
          rooms={rooms} zoneNames={zoneNames}
          favorites={favorites} onFavoritesChange={onFavoritesChange}
          onSave={save} onCancel={() => setEditing(null)} isMobile={isMobile}
        />
      )}

      {schedules.length === 0 && !editing && (
        <div style={{ ...card, textAlign: "center", padding: isMobile ? 24 : 36 }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>⏰</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: "#94a3b8", marginBottom: 6 }}>No schedules yet</div>
          <div style={{ fontSize: 12, color: "#64748b", lineHeight: 1.6 }}>
            Add one here for a white or single-color look, or build a full scene in a
            room's <strong>Scenes</strong> panel and press <strong>⏰ Schedule this look</strong>.
          </div>
        </div>
      )}

      {schedules.map(s => (
        <div key={s.id} style={{ ...card, opacity: s.enabled ? 1 : 0.6 }}>
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 200px", minWidth: 0 }}>
              <div style={{ fontSize: isMobile ? 14 : 15, fontWeight: 700, color: "#e2e8f0" }}>
                {s.name}
              </div>
              <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>
                {triggerSummary(s.trigger)}
              </div>
              <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>
                {targetSummary(s.action)} · {actionSummary(s.action)}
              </div>
              <div style={{ fontSize: 11, color: s.enabled ? "#34d399" : "#64748b", marginTop: 6 }}>
                Next: {nextRunLabel(s)}
              </div>
            </div>

            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              {/* Enable toggle — a patch POST, so flipping it never disturbs
                  the trigger (and never resets last_fired). */}
              <button onClick={() => onSave({ id: s.id, enabled: !s.enabled })}
                title={s.enabled ? "Disable" : "Enable"}
                style={{
                  width: 44, height: 24, borderRadius: 12, border: "none", padding: 2,
                  background: s.enabled ? "#6366f1" : "#334155", cursor: "pointer",
                  display: "flex", justifyContent: s.enabled ? "flex-end" : "flex-start",
                }}>
                <div style={{ width: 20, height: 20, borderRadius: 10, background: "#fff" }} />
              </button>
              <button onClick={() => setEditing(s)} style={{
                padding: "6px 12px", borderRadius: 8, border: "1px solid #334155",
                background: "transparent", color: "#94a3b8", fontSize: 12, fontWeight: 600, cursor: "pointer",
              }}>Edit</button>
              {confirmDelete === s.id ? (
                <button onClick={() => { onDelete(s.id); setConfirmDelete(null); }} style={{
                  padding: "6px 12px", borderRadius: 8, border: "none",
                  background: "#ef4444", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer",
                }}>Confirm</button>
              ) : (
                <button onClick={() => setConfirmDelete(s.id)} style={{
                  padding: "6px 12px", borderRadius: 8, border: "1px solid #7f1d1d",
                  background: "transparent", color: "#f87171", fontSize: 12, fontWeight: 600, cursor: "pointer",
                }}>Delete</button>
              )}
            </div>
          </div>
        </div>
      ))}

      {/* Zones are managed in Assign Rooms now — point there rather than
          duplicating the editor, so there's one place membership can change. */}
      <div style={{
        marginTop: 18, padding: isMobile ? 12 : 14, borderRadius: 12,
        background: "#16233a", border: "1px solid #334155",
        fontSize: 12, color: "#94a3b8", lineHeight: 1.6,
      }}>
        <strong style={{ color: "#e2e8f0" }}>Zones</strong> ({zoneNames.length}) let a
        schedule act on several rooms at once, and have On/Off buttons in the bar at the
        top of every page. Create and edit them in <strong>Assign Rooms</strong>.
        {zoneNames.length > 0 && (
          <div style={{ marginTop: 6, color: "#64748b" }}>{zoneNames.join(" · ")}</div>
        )}
      </div>
    </div>
  );
}

// ─── Settings → Location card ───────────────────────────────────────────────
// Only sun-relative triggers need this, so it says so rather than looking like
// a mandatory setup step.

// Four ways in, because "type your latitude" is an expert-only ask. All of them
// converge on the same onChange(lat,lng) → POST /api/location. No geocoding API is
// used anywhere: ZIP and city resolve against the offline tables in
// location-data.js, so this works with no internet and no API key.
const LOCATION_METHODS = [
  { id: "auto", label: "Use my location" },
  { id: "zip", label: "US ZIP code" },
  { id: "city", label: "Nearest city" },
  { id: "maps", label: "Google Maps" },
];

function LocationCard({ location, onChange, isMobile }) {
  const [method, setMethod] = useState("auto");
  const [status, setStatus] = useState(null);
  const [zip, setZip] = useState("");
  const [city, setCity] = useState("");
  const [paste, setPaste] = useState("");

  const has = location?.lat != null && location?.lng != null;

  const commit = (la, ln, note) => {
    onChange(Number(la.toFixed(5)), Number(ln.toFixed(5)));
    setStatus(note || "Saved.");
  };

  const locate = () => {
    if (!navigator.geolocation) { setStatus("This browser can't share a location."); return; }
    setStatus("Locating…");
    navigator.geolocation.getCurrentPosition(
      (pos) => commit(pos.coords.latitude, pos.coords.longitude, "Saved from your device."),
      () => setStatus("Couldn't get your location — try one of the other options."),
      { timeout: 10000 },
    );
  };

  // ZIP resolves on the 3-digit prefix (see location-data.js): accurate to the
  // ZIP region, which is far tighter than sunrise/sunset needs.
  const applyZip = () => {
    const digits = (zip || "").replace(/\D/g, "");
    if (digits.length < 3) { setStatus("Enter at least the first 3 digits of a US ZIP."); return; }
    const hit = typeof ZIP3_COORDS !== "undefined" ? ZIP3_COORDS[digits.slice(0, 3)] : null;
    if (!hit) { setStatus(`No match for ZIP ${digits} — try the city list.`); return; }
    commit(hit[0], hit[1], `Set to the ${digits.slice(0, 3)}xx area.`);
  };

  const applyCity = (value) => {
    setCity(value);
    const idx = Number(value);
    const row = typeof WORLD_CITIES !== "undefined" ? WORLD_CITIES[idx] : null;
    if (!row) return;
    commit(row[2], row[3], `Set to ${row[1]}.`);
  };

  // Accepts what Google Maps actually puts on the clipboard: "41.878, -87.629".
  const applyPaste = () => {
    const m = (paste || "").match(/(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)/);
    if (!m) { setStatus("Paste coordinates like  41.878, -87.629"); return; }
    const la = Number(m[1]), ln = Number(m[2]);
    if (!isFinite(la) || !isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) {
      setStatus("Those numbers aren't a valid latitude/longitude.");
      return;
    }
    commit(la, ln);
  };

  const field = {
    padding: "8px 10px", borderRadius: 8, border: "1px solid #334155",
    background: "#0f172a", color: "#e2e8f0", fontSize: 13, width: "100%",
  };
  const tab = (active) => ({
    padding: isMobile ? "7px 10px" : "7px 14px", borderRadius: 8,
    border: active ? "1px solid #6366f1" : "1px solid #334155",
    background: active ? "rgba(99,102,241,0.18)" : "transparent",
    color: active ? "#c7d2fe" : "#94a3b8",
    fontSize: isMobile ? 11 : 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
  });
  const primaryBtn = {
    padding: "8px 16px", borderRadius: 8, border: "none",
    background: "#6366f1", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer",
  };

  // Group the city list by country for a scannable <optgroup> select.
  const cityGroups = [];
  if (typeof WORLD_CITIES !== "undefined") {
    WORLD_CITIES.forEach((row, i) => {
      const last = cityGroups[cityGroups.length - 1];
      if (last && last.country === row[0]) last.items.push([i, row[1]]);
      else cityGroups.push({ country: row[0], items: [[i, row[1]]] });
    });
  }

  return (
    <div style={{
      background: "#1e293b", borderRadius: 16, padding: isMobile ? 14 : 20,
      marginBottom: 16, border: "1px solid #334155",
    }}>
      <div style={{ fontSize: isMobile ? 15 : 17, fontWeight: 700, color: "#e2e8f0", marginBottom: 4 }}>
        Location
      </div>
      <div style={{ fontSize: 12, color: "#64748b", marginBottom: 12, lineHeight: 1.6 }}>
        Used only to compute sunrise and sunset for sun-relative schedules. It stays on
        your hub — nothing is sent anywhere. Rough is fine: being a few miles off moves
        sunset by well under a minute.
      </div>

      {/* Current value — the card should answer "is this set?" at a glance. */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
        padding: "8px 12px", borderRadius: 10, marginBottom: 14,
        background: has ? "rgba(52,211,153,0.10)" : "rgba(251,191,36,0.10)",
        border: `1px solid ${has ? "#047857" : "#b45309"}`,
      }}>
        <span style={{ fontSize: 12, color: has ? "#6ee7b7" : "#fcd34d", fontWeight: 600 }}>
          {has ? `Set to ${location.lat}, ${location.lng}` : "Not set — sun schedules won't fire"}
        </span>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        {LOCATION_METHODS.map(m => (
          <button key={m.id} style={tab(method === m.id)}
            onClick={() => { setMethod(m.id); setStatus(null); }}>{m.label}</button>
        ))}
      </div>

      {method === "auto" && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button onClick={locate} style={primaryBtn}>📍 Use my location</button>
          <span style={{ fontSize: 11, color: "#64748b" }}>
            Asks the browser for this device's position.
          </span>
        </div>
      )}

      {method === "zip" && (
        <div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div style={{ flex: "1 1 160px" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8", marginBottom: 6 }}>US ZIP code</div>
              <input value={zip} inputMode="numeric" maxLength={10}
                onChange={e => { setZip(e.target.value); setStatus(null); }}
                onKeyDown={e => { if (e.key === "Enter") applyZip(); }}
                placeholder="60601" style={field} />
            </div>
            <button onClick={applyZip} style={primaryBtn}>Use this ZIP</button>
          </div>
          <div style={{ fontSize: 11, color: "#64748b", marginTop: 8, lineHeight: 1.6 }}>
            Resolved offline from the ZIP's region — accurate to within a few miles, which
            is plenty for sunrise and sunset.
          </div>
        </div>
      )}

      {method === "city" && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8", marginBottom: 6 }}>Nearest city</div>
          <select value={city} onChange={e => applyCity(e.target.value)} style={field}>
            <option value="">Pick the closest city…</option>
            {cityGroups.map(g => (
              <optgroup key={g.country} label={g.country}>
                {g.items.map(([i, name]) => <option key={i} value={i}>{name}</option>)}
              </optgroup>
            ))}
          </select>
          <div style={{ fontSize: 11, color: "#64748b", marginTop: 8, lineHeight: 1.6 }}>
            Not exhaustive — if your city isn't listed, pick the nearest one or use the
            Google Maps option.
          </div>
        </div>
      )}

      {method === "maps" && (
        <div>
          <div style={{ fontSize: 12, color: "#cbd5e1", lineHeight: 1.7, marginBottom: 10 }}>
            <a href="https://www.google.com/maps" target="_blank" rel="noopener noreferrer"
              style={{ color: "#a5b4fc", fontWeight: 700 }}>Open Google Maps ↗</a>
            <div style={{ marginTop: 8, color: "#94a3b8" }}>
              <div>1. Find your home on the map.</div>
              <div>2. <strong>Right-click it</strong> (long-press on a phone).</div>
              <div>3. The first item in the menu <em>is</em> the latitude and longitude — click it to copy.</div>
              <div>4. Paste it below.</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div style={{ flex: "1 1 200px" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8", marginBottom: 6 }}>
                Pasted coordinates
              </div>
              <input value={paste}
                onChange={e => { setPaste(e.target.value); setStatus(null); }}
                onKeyDown={e => { if (e.key === "Enter") applyPaste(); }}
                placeholder="41.878, -87.629" style={field} />
            </div>
            <button onClick={applyPaste} style={primaryBtn}>Use these</button>
          </div>
        </div>
      )}

      {status && (
        <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 12 }}>{status}</div>
      )}
    </div>
  );
}
