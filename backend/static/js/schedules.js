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
  return "Unknown action";
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

function ScheduleEditor({ initial, rooms, favorites, onFavoritesChange, onSave, onCancel, isMobile }) {
  const [name, setName] = useState(initial?.name || "");
  const [trigger, setTrigger] = useState(initial?.trigger || { type: "weekly", time: "07:00", days: [0, 1, 2, 3, 4] });
  const [action, setAction] = useState(initial?.action || { type: "white", room: rooms[0] || "", kelvin: 2700, brightness: 100 });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // A captured scene can't be re-authored here — the look came from the color
  // tool. You can retarget everything else about it, just not rebuild it.
  const isScene = action.type === "scene";
  const patchTrigger = (p) => setTrigger(prev => ({ ...prev, ...p }));
  const patchAction = (p) => setAction(prev => ({ ...prev, ...p }));

  const toggleDay = (d) => {
    const days = trigger.days || [];
    patchTrigger({ days: days.includes(d) ? days.filter(x => x !== d) : [...days, d].sort((a, b) => a - b) });
  };

  const submit = async () => {
    if (!action.room) { setError("Pick a room."); return; }
    if (trigger.type !== "sun" && !/^\d{2}:\d{2}$/.test(trigger.time || "")) { setError("Pick a time."); return; }
    if (trigger.type === "oneoff" && !trigger.date) { setError("Pick a date."); return; }
    if (trigger.type !== "oneoff" && !(trigger.days || []).length) { setError("Pick at least one day."); return; }
    setSaving(true); setError(null);
    try {
      await onSave({
        id: initial?.id || undefined,
        name: name.trim() || `${action.room} ${trigger.type === "sun" ? trigger.event : prettyTime(trigger.time)}`,
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

        {!isScene && (
          <div style={{ marginBottom: 12 }}>
            <div style={label}>Brightness · {action.brightness}%</div>
            <input type="range" min={1} max={100} value={action.brightness}
              onChange={e => patchAction({ brightness: Number(e.target.value) })}
              style={{ width: "100%", accentColor: "#6366f1" }} />
          </div>
        )}

        <div style={label}>In which room</div>
        <select value={action.room} onChange={e => patchAction({ room: e.target.value })}
          disabled={isScene} style={{ ...field, opacity: isScene ? 0.6 : 1 }}>
          {!action.room && <option value="">Pick a room…</option>}
          {rooms.map(r => <option key={r} value={r}>{r}</option>)}
        </select>
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

// ─── Tab ────────────────────────────────────────────────────────────────────

function SchedulesTab({ schedules, rooms, location, favorites, onFavoritesChange,
                        onSave, onDelete, pendingScene, onConsumePending }) {
  const isMobile = useIsMobile();
  const [editing, setEditing] = useState(null);   // null | {} (new) | schedule
  const [confirmDelete, setConfirmDelete] = useState(null);

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
          rooms={rooms} favorites={favorites} onFavoritesChange={onFavoritesChange}
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
                {s.action?.room} · {actionSummary(s.action)}
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
    </div>
  );
}

// ─── Settings → Location card ───────────────────────────────────────────────
// Only sun-relative triggers need this, so it says so rather than looking like
// a mandatory setup step.

function LocationCard({ location, onChange, isMobile }) {
  const [lat, setLat] = useState(location?.lat ?? "");
  const [lng, setLng] = useState(location?.lng ?? "");
  const [status, setStatus] = useState(null);

  useEffect(() => {
    setLat(location?.lat ?? "");
    setLng(location?.lng ?? "");
  }, [location?.lat, location?.lng]);

  const locate = () => {
    if (!navigator.geolocation) { setStatus("This browser can't share a location."); return; }
    setStatus("Locating…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const la = Number(pos.coords.latitude.toFixed(5));
        const ln = Number(pos.coords.longitude.toFixed(5));
        setLat(la); setLng(ln);
        onChange(la, ln);
        setStatus("Saved.");
      },
      () => setStatus("Couldn't get your location — enter it manually."),
      { timeout: 10000 },
    );
  };

  const saveManual = () => {
    const la = Number(lat), ln = Number(lng);
    if (!isFinite(la) || !isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) {
      setStatus("That doesn't look like a valid latitude/longitude.");
      return;
    }
    onChange(la, ln);
    setStatus("Saved.");
  };

  const field = {
    padding: "8px 10px", borderRadius: 8, border: "1px solid #334155",
    background: "#0f172a", color: "#e2e8f0", fontSize: 13, width: "100%",
  };

  return (
    <div style={{
      background: "#1e293b", borderRadius: 16, padding: isMobile ? 14 : 20,
      marginBottom: 16, border: "1px solid #334155",
    }}>
      <div style={{ fontSize: isMobile ? 15 : 17, fontWeight: 700, color: "#e2e8f0", marginBottom: 4 }}>
        Location
      </div>
      <div style={{ fontSize: 12, color: "#64748b", marginBottom: 14, lineHeight: 1.6 }}>
        Used only to compute sunrise and sunset for sun-relative schedules. It stays on
        your hub — nothing is sent anywhere.
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <div style={{ flex: "1 1 140px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8", marginBottom: 6 }}>Latitude</div>
          <input value={lat} onChange={e => setLat(e.target.value)} placeholder="41.88" style={field} />
        </div>
        <div style={{ flex: "1 1 140px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8", marginBottom: 6 }}>Longitude</div>
          <input value={lng} onChange={e => setLng(e.target.value)} placeholder="-87.63" style={field} />
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button onClick={locate} style={{
          padding: "8px 16px", borderRadius: 8, border: "1px solid #6366f1",
          background: "transparent", color: "#a5b4fc", fontSize: 12, fontWeight: 600, cursor: "pointer",
        }}>📍 Use my location</button>
        <button onClick={saveManual} style={{
          padding: "8px 16px", borderRadius: 8, border: "none",
          background: "#6366f1", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer",
        }}>Save</button>
        {status && <span style={{ fontSize: 12, color: "#94a3b8" }}>{status}</span>}
      </div>
    </div>
  );
}
