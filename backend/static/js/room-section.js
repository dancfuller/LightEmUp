// ─── Room Section ──────────────────────────────────────────────────────────

// "Now showing" — what this room was last set to, in the header so it's readable
// WITHOUT opening the Scenes panel and even while the room is collapsed. The
// point is cross-session recall: set a look on your phone, open a laptop later,
// and the room still tells you what it's wearing. The record is written by the
// BACKEND on every whole-room change (see record_room_applied), so it also covers
// schedules that fired while nobody had the app open — which is exactly the case
// the old room_color_state couldn't answer.
function relativeTime(iso) {
  if (!iso) return "";
  const then = new Date(iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z");
  const secs = Math.floor((Date.now() - then.getTime()) / 1000);
  if (!isFinite(secs)) return "";
  if (secs < 45) return "just now";
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  const days = Math.round(secs / 86400);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

// Compact brightness control for the room header row (v3.25.0). The full-width
// `Slider` (label above, value right) can't sit inline, but the THROTTLING can:
// same useThrottledControl hook, so dragging still coalesces into ~180ms of
// requests rather than one per pixel of travel.
//
// Floor is 1%, not 0: this sits inches from the power toggle, which owns off.
// A slider that silently turns the room off while the toggle still reads "On"
// would be two controls disagreeing about the same fact.
function InlineBrightness({ value, onChange, isMobile }) {
  const [local, onInput, guard] = useThrottledControl(value, onChange, 180);
  const pct = Math.max(1, Math.min(100, Math.round(local)));
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}
      title="Brightness for every light in this room">
      <input
        type="range" min={1} max={100} value={pct}
        onChange={(e) => onInput(Number(e.target.value))}
        {...guard}
        style={{
          // This one sits in a long scrolling list of rooms — the exact place a
          // thumb brushes a control on the way past.
          touchAction: "pan-y",
          width: isMobile ? 88 : 116, height: 6, appearance: "none", borderRadius: 3,
          background: `linear-gradient(to right, #fbbf24 ${pct}%, #334155 ${pct}%)`,
          cursor: "pointer", outline: "none",
        }}
      />
      <span style={{
        fontSize: 11, fontWeight: 700, color: "#94a3b8",
        width: 30, textAlign: "right", flexShrink: 0,
      }}>{pct}%</span>
    </div>
  );
}

function RoomLastApplied({ entry, status, onReapply, isMobile, applying }) {
  const [busy, setBusy] = useState(false);

  // A scene is recorded only when it FINISHES (a cancelled apply left the room
  // half-set, so claiming it early would be a lie) — but a room with segmented
  // Govee devices takes ~30s, because the cloud_v2 segment calls are rate
  // limited. For that whole window the strip used to keep advertising the
  // PREVIOUS look, so pressing Apply on a palette and glancing up showed
  // "Soft White · 2700K" and looked like the record was simply wrong.
  // Say what's actually true instead: it's mid-change.
  if (applying) {
    return (
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: isMobile ? "6px 9px" : "6px 11px", borderRadius: 9,
        background: "rgba(15,27,46,0.75)", border: "1px solid #24334a",
      }}>
        <span style={{
          fontSize: 10, fontWeight: 700, color: "#818cf8",
          textTransform: "uppercase", letterSpacing: 0.5,
        }}>Applying…</span>
        <span style={{ fontSize: isMobile ? 11 : 12, color: "#94a3b8" }}>
          setting the new look
        </span>
      </div>
    );
  }

  if (!entry || !entry.label) return null;

  // LightEmUp isn't the only thing driving these lights (Hue app, Govee app,
  // Google Home routines), so this record is "what we set", not "what's on".
  // The backend can PROVE the room drifted but can never prove it didn't — so
  // only the diverged state is announced. "match" and "can't tell" both render
  // quietly, because a confident tick we can't stand behind is worse than none.
  const diverged = status && status.state === "diverged";
  // Two very different failures wear the same amber panel, and conflating them
  // sends you to the wrong place. "Changed since" = something ELSE set these
  // lights (a Google Home routine, the Hue/Govee app) and you want your look
  // back. "Didn't take" = our own command never landed on a Govee device — the
  // backend proved it by reading the device — and the fix is simply to send it
  // again. See `_govee_verify_repair` in main.py.
  const notApplied = diverged && status.reason === "not_applied";

  // White is stored as a Kelvin value rather than swatches, so the backend never
  // needs colour math just to label a temperature — render the chip here.
  let swatches = entry.swatches || [];
  if (!swatches.length && entry.kelvin) {
    const c = kelvinToRGB(entry.kelvin);
    if (c) swatches = [[c.r, c.g, c.b]];
  }
  const off = entry.kind === "power" && /off/i.test(entry.label);
  const when = relativeTime(entry.at);
  const bySchedule = entry.source === "schedule";
  const dot = isMobile ? 13 : 15;

  const names = (diverged && status.changed_names) || [];
  const changedBy = names.length
    ? `Changed since — ${names.join(", ")} no longer match`
    : "Changed since LightEmUp set this";
  const notAppliedBy = names.length
    ? `${names.join(", ")} didn't take this`
    : "Some lights in this room didn't take this";

  return (
    <div
      title={notApplied
        ? `${notAppliedBy} — unreachable, or the command was lost on the way. Nothing else changed the room; "Try again" re-sends it.`
        : diverged
        ? `${changedBy}. Something else (a Google Home routine, the Hue or Govee app) has set these lights since. "Set here" puts this look back.`
        : `${entry.label}${bySchedule && entry.source_detail ? ` — set by schedule "${entry.source_detail}"` : ""}${when ? ` · ${when}` : ""}`}
      style={{
        display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
        padding: isMobile ? "6px 9px" : "6px 11px", borderRadius: 9,
        background: diverged ? "rgba(69,45,16,0.5)" : "rgba(15,27,46,0.75)",
        border: diverged ? "1px solid #7c5312" : "1px solid #24334a",
      }}
    >
      <span style={{
        fontSize: 9, fontWeight: 700, letterSpacing: 0.7, textTransform: "uppercase",
        color: diverged ? "#fbbf24" : "#64748b",
      }}>
        {notApplied ? "Didn't take" : diverged ? "Changed since" : "Now showing"}
      </span>

      {swatches.length > 0 && (
        <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
          {swatches.map((c, i) => (
            <span key={i} style={{
              width: dot, height: dot, borderRadius: "50%",
              background: `rgb(${c[0]},${c[1]},${c[2]})`,
              // Fairly strong rim: a very dark swatch (navy, near-black team
              // colors) is otherwise indistinguishable from the panel behind it.
              border: "1px solid rgba(255,255,255,0.3)", flexShrink: 0,
            }} />
          ))}
        </span>
      )}
      {off && (
        <span style={{
          width: dot, height: dot, borderRadius: "50%", background: "#0f172a",
          border: "1px solid #334155", flexShrink: 0,
        }} />
      )}
      {entry.kind === "lightning" && <span style={{ fontSize: dot }}>⚡</span>}

      <span style={{
        fontSize: isMobile ? 11 : 12, fontWeight: 600,
        // Dimmed when the room has drifted: this is what we SET, not what's on.
        color: diverged ? "#94a3b8" : (off ? "#94a3b8" : "#e2e8f0"),
        textDecoration: diverged ? "line-through" : "none",
        minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>{entry.label}</span>

      {/* The call to action. Divergence is nearly always a routine elsewhere
          forcing a plain colour temperature, and what you want is your look
          back — so make that one tap instead of "go find the scene again". */}
      {diverged && onReapply && status.can_reapply !== false && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setBusy(true);
            Promise.resolve(onReapply()).finally(() => setBusy(false));
          }}
          disabled={busy}
          title={notApplied
            ? "Send this look to the room again"
            : "Re-apply this look to the room"}
          style={{
            fontSize: isMobile ? 11 : 12, fontWeight: 700,
            padding: isMobile ? "3px 10px" : "3px 12px", borderRadius: 7,
            border: "1px solid #b45309", background: "#b45309", color: "#fff",
            cursor: busy ? "wait" : "pointer", whiteSpace: "nowrap",
          }}
        >{busy ? "Setting…" : notApplied ? "Try again" : "Set here"}</button>
      )}

      {/* Attribution only when it wasn't a person in the app — "you did this" is
          the boring default and doesn't need saying. */}
      {bySchedule && (
        <span style={{
          fontSize: 10, fontWeight: 700, color: "#a5b4fc",
          background: "rgba(99,102,241,0.14)", border: "1px solid rgba(99,102,241,0.3)",
          borderRadius: 6, padding: "1px 6px", whiteSpace: "nowrap",
        }}>⏰ {entry.source_detail || "Schedule"}</span>
      )}

      {when && (
        <span style={{ fontSize: 10, color: "#64748b", marginLeft: "auto", whiteSpace: "nowrap" }}>
          {when}
        </span>
      )}
    </div>
  );
}

// Overlay control surface: a right-side drawer on desktop, a bottom sheet on
// mobile. Holds the per-room Lightning / Scenes / Controls / Debug panels so
// opening one no longer reflows the light-card grid below.
function ControlSurface({ view, views, onView, onClose, roomName, isMobile, children }) {
  if (!view) return null;

  const tabs = (
    <div style={{
      display: "flex", gap: 4, background: "#0a0f1e", borderRadius: 10,
      padding: 4, border: "1px solid #1e293b", marginBottom: 18, flexWrap: "wrap",
    }}>
      {views.map(t => (
        <button key={t.key} onClick={() => onView(t.key)} style={{
          flex: "1 1 auto", padding: "8px 6px", borderRadius: 7, border: "none", cursor: "pointer",
          background: view === t.key ? "rgba(99,102,241,0.18)" : "transparent",
          color: view === t.key ? t.accent : "#94a3b8", fontSize: 12, fontWeight: 700,
          whiteSpace: "nowrap",
        }}>{t.label}</button>
      ))}
    </div>
  );

  const header = (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
      <div style={{ fontSize: 12, color: "#64748b", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.6 }}>{roomName}</div>
      <button onClick={onClose} style={{
        background: "none", border: "none", color: "#64748b",
        fontSize: 24, cursor: "pointer", lineHeight: 1, padding: "0 4px",
      }} title="Close">&#x00D7;</button>
    </div>
  );

  // MOBILE: bottom sheet sliding up.
  if (isMobile) {
    return (
      <div onClick={onClose} style={{
        position: "fixed", inset: 0, zIndex: 200, background: "rgba(2,6,15,0.6)",
        display: "flex", alignItems: "flex-end",
      }}>
        <div onClick={(e) => e.stopPropagation()} style={{
          width: "100%", maxHeight: "88%", overflowY: "auto",
          background: "linear-gradient(180deg, #0f172a 0%, #0a0f1e 100%)",
          borderTop: "1px solid #334155", borderRadius: "20px 20px 0 0", padding: 18,
          boxShadow: "0 -20px 60px rgba(0,0,0,0.6)", animation: "sheetUp 0.25s ease",
        }}>
          <div style={{ width: 40, height: 4, borderRadius: 2, background: "#334155", margin: "0 auto 14px" }} />
          {header}
          {tabs}
          {children}
        </div>
      </div>
    );
  }

  // DESKTOP: right drawer.
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 200, background: "rgba(2,6,15,0.55)",
      display: "flex", justifyContent: "flex-end",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: 460, maxWidth: "100%", height: "100%", overflowY: "auto",
        background: "linear-gradient(180deg, #0f172a 0%, #0a0f1e 100%)",
        borderLeft: "1px solid #334155", padding: 22,
        boxShadow: "-20px 0 60px rgba(0,0,0,0.5)", animation: "drawerIn 0.25s ease",
      }}>
        {header}
        {tabs}
        {children}
      </div>
    </div>
  );
}

function RoomSection({ name, hueLights, goveeDevices, onControlHue, onControlGovee, onControlRoom, favorites, onFavoritesChange, nicknames, onNicknameChange, lightningActive, onLightningStart, onLightningStop, segmentInfo, segmentState, onSegmentStateRefresh, deviceModes, onDeviceModeChange, onDeviceModesBulkChange, sceneAddress, onSceneAddressChange, unassignedDevices, onAssignDevices, onNavigate, segmentFillModes, onSegmentFillModeChange, onSegmentCountChange, roomLayouts, onLayoutChange, fixtures, onFixtureUpsert, onFixtureDelete, minSatEnabled, minSatPct, savedColorState, ctCorrection, onScheduleLook, lastApplied, lastStatus, onReapply, onRecheck }) {
  const isMobile = useIsMobile();
  const [collapsed, setCollapsed] = useState(true);
  // Single overlay surface state — replaces the old per-panel show* booleans.
  // null | "lightning" | "scenes" | "controls" | "debug"
  const [surfaceView, setSurfaceView] = useState(null);
  // null until you actually drag it — the displayed value is then derived from
  // the lights (below), so the header slider can't sit at a made-up 75% while
  // the room is dim.
  const [roomBrightness, setRoomBrightness] = useState(null);
  const [roomColor, setRoomColor] = useState(null);
  const [colorModeApplied, setColorModeApplied] = useState(null);

  // Is a backend scene apply running for THIS room? app.js re-broadcasts the
  // scene_apply SSE stream as a window event; the colour panel uses it for its
  // progress bar, and the header strip needs it so it doesn't keep advertising
  // the previous look for the ~30s a segmented room takes to fill in. Tracked
  // here rather than in RoomLastApplied so it survives the panel being closed.
  // Creating a room in Rooms left you with an empty card and no way forward —
  // the only place to put lights in it was the Assign Rooms tab, which you had
  // to know about. Same picker, opened here (v3.26.0).
  const [showAssign, setShowAssign] = useState(false);
  const [applying, setApplying] = useState(false);
  useEffect(() => {
    const onProgress = (e) => {
      const d = e.detail || {};
      if (d.room !== name) return;
      setApplying(d.active !== false && d.phase !== "done" && d.phase !== "canceled");
    };
    window.addEventListener("lightemup-scene-apply", onProgress);
    return () => window.removeEventListener("lightemup-scene-apply", onProgress);
  }, [name]);

  const allLights = [
    ...hueLights.map(l => ({ ...l, _controlFn: onControlHue })),
    ...goveeDevices.map(d => ({ ...d, _controlFn: onControlGovee })),
  ];
  const anyOn = allLights.some(l => l.state?.on);
  const anyColor = allLights.some(l => l.capabilities?.has_color);

  // What the room is ACTUALLY at, averaged over the lights that are ON — an off
  // light's remembered brightness isn't what you're looking at. Hue reports
  // 1–254, Govee 0–100, so they're normalised before averaging. Used until you
  // drag, after which your own value stands (it's what was sent, so it matches).
  const litPcts = allLights
    .filter(l => l.state?.on)
    .map(l => l.type === "hue"
      ? Math.round(((l.state.brightness ?? 0) / 254) * 100)
      : Math.round(l.state.brightness ?? 0));
  const avgBrightness = litPcts.length
    ? Math.round(litPcts.reduce((a, b) => a + b, 0) / litPcts.length)
    : null;
  const shownBrightness = roomBrightness != null ? roomBrightness
    : (avgBrightness != null ? avgBrightness : 75);
  const segmentCountFor = (d) => {
    const configured = segmentInfo?.configured_counts?.[goveeSlug(d)];
    const skuCount = segmentInfo?.sku_table?.[d.sku]?.count;
    return configured || skuCount || 1;
  };
  const anySegmented = goveeDevices.some(d => segmentCountFor(d) > 1);
  const totalSegments = goveeDevices.reduce((s, d) => {
    const c = segmentCountFor(d);
    return c > 1 ? s + c : s;
  }, 0);

  // Tabs available in the control surface. Debug only appears when there is a
  // segment-capable device to debug.
  // "Room Map" is a real room (has a layout handler) with at least one device —
  // the pseudo-"Unassigned" group has neither, so it gets no map.
  const canMap = typeof RoomMap === "function" && !!onLayoutChange && allLights.length > 0;
  // A real room has a layout handler; the pseudo-"Unassigned" group doesn't. Used
  // to word the whole-room white group as "Set room to" vs "Set lights to".
  const isRealRoom = !!onLayoutChange;
  const views = [
    { key: "lightning", label: lightningActive ? "⚡ Storm" : "⚡ Lightning", accent: "#fbbf24" },
    { key: "scenes", label: "Scenes", accent: "#34d399" },
    { key: "controls", label: "Controls", accent: "#a5b4fc" },
  ];
  if (canMap) views.push({ key: "map", label: "🗺 Room Map", accent: "#22d3ee" });
  if (anySegmented) views.push({ key: "debug", label: "Debug", accent: "#fbbf24" });

  const applyRoomBrightness = (val) => {
    setRoomBrightness(val);
    onControlRoom(name, { on: true, brightness: val });
  };

  const applyRoomColor = (r, g, b) => {
    setRoomColor({ r, g, b });
    onControlRoom(name, { on: true, r, g, b });
  };

  // Per-room white quick-actions. Turn THIS room on at a fixed color temperature.
  // These replace the old global "All On" buttons — you rarely want to light the
  // whole house/outside, but "warm up this room" / "cool white this room" is a
  // genuinely useful one-tap. Fans out client-side per device so each vendor gets
  // its native command (Hue mireds, Govee kelvin → server-side ct_rgb calibration).
  // Cool White is effectively an "emergency / brightest" mode → 6500K daylight.
  // Both shortcuts force full brightness. Brightness scale is vendor-specific:
  // Hue's `bri` is 1–254, Govee's is 0–100, so 100% is 254 vs 100 respectively.
  const SOFT_WHITE_K = 2700, COOL_WHITE_K = 6500;
  const setRoomWhite = (kelvin, label) => {
    hueLights.forEach(l => onControlHue(l, { on: true, brightness: 254, color_temp: kelvinToMired(kelvin) }));
    goveeDevices.forEach(d => onControlGovee(d, { on: true, brightness: 100, color_temp_kelvin: kelvin }));
    // This fan-out is CLIENT-side, so no room endpoint sees it — tell the backend
    // what the room now shows, or the header would still advertise the old scene.
    // Only for real rooms: "Unassigned" isn't a room the backend knows about.
    if (isRealRoom) {
      api("/rooms/last-applied", {
        method: "POST",
        body: JSON.stringify({
          room_name: name, kind: "white",
          label: `${label} · ${kelvin}K`, kelvin,
        }),
      }).catch(e => console.warn("[RoomSection] last-applied save failed:", e));
    }
  };
  const whiteBtn = (label, kelvin, fg, bg, border) => (
    <button
      onClick={() => setRoomWhite(kelvin, label)}
      title={`Set every light in this room to ${kelvin}K white at full brightness`}
      style={{
        padding: isMobile ? "6px 12px" : "6px 16px", borderRadius: 8,
        border: `1px solid ${border}`, background: bg, color: fg,
        fontSize: isMobile ? 11 : 12, fontWeight: 700, cursor: "pointer",
        whiteSpace: "nowrap", transition: "all 0.2s",
      }}
    >{label}</button>
  );

  // Master power toggle. It's really Resume ⇄ Off: turning "on" sends {on:true},
  // so each light comes back to its last state (bulbs/strips remember) rather
  // than a fixed look. The white presets beside it own the specific looks, so the
  // two don't read as duplicate whole-room controls. Tooltip spells out the
  // resume semantics (no hover on mobile, but the label shows state honestly).
  // Built here as a value because it's placed differently on phone vs desktop.
  const powerToggle = (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
      <span style={{ fontSize: 12, fontWeight: 700, color: anyOn ? "#e2e8f0" : "#64748b", whiteSpace: "nowrap" }}>
        {anyOn ? "On" : "Off"}
      </span>
      <button
        onClick={() => onControlRoom(name, { on: !anyOn })}
        title={anyOn ? "Turn the whole room off" : "Resume the room's last lighting"}
        style={{
          width: 48, height: 28, borderRadius: 14, border: "none",
          background: anyOn ? "#6366f1" : "#334155", cursor: "pointer",
          position: "relative", transition: "background 0.2s", flexShrink: 0,
          boxShadow: anyOn ? "0 0 8px rgba(99,102,241,0.4)" : "none",
        }}
      >
        <div style={{ width: 22, height: 22, borderRadius: "50%", background: "#fff", position: "absolute", top: 3, left: anyOn ? 23 : 3, transition: "left 0.2s ease" }} />
      </button>
    </div>
  );

  // Opener button in the room header (sets the surface view).
  const openerBtn = (key, label, accent, dashed) => (
    <button
      onClick={() => setSurfaceView(key)}
      style={{
        padding: isMobile ? "6px 12px" : "6px 16px", borderRadius: 8,
        border: dashed ? "1px dashed #475569" : "1px solid #334155",
        background: "transparent", color: accent,
        fontSize: isMobile ? 11 : 12, fontWeight: 700, cursor: "pointer",
        whiteSpace: "nowrap", transition: "all 0.2s",
      }}
    >{label}</button>
  );

  // Room map is now its own first-class surface view ("Room Map" opener), not a
  // buried collapsible inside Controls — the layout was too hidden.
  const roomMapEl = (
    <RoomMap
      roomName={name}
      segmentState={segmentState}
      hueLights={hueLights} goveeDevices={goveeDevices}
      onControlHue={onControlHue} onControlGovee={onControlGovee}
      favorites={favorites} onFavoritesChange={onFavoritesChange}
      nicknames={nicknames} onNicknameChange={onNicknameChange}
      segmentInfo={segmentInfo}
      roomLayouts={roomLayouts} onLayoutChange={onLayoutChange}
      appliedColors={colorModeApplied}
      fixtures={fixtures}
      onFixtureUpsert={onFixtureUpsert}
      onFixtureDelete={onFixtureDelete}
    />
  );

  // Room-level controls panel (override + brightness + color).
  const controlsPanel = (
    <div>
      {/* Override header + on/off toggle */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 8, flexWrap: "wrap" }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#a5b4fc", textTransform: "uppercase", letterSpacing: 0.8 }}>
          Override all lights in {name}
        </div>
        <button
          onClick={() => onControlRoom(name, { on: !anyOn })}
          style={{
            width: 48, height: 28, borderRadius: 14, border: "none",
            background: anyOn ? "#6366f1" : "#334155",
            cursor: "pointer", position: "relative", transition: "background 0.2s", flexShrink: 0,
          }}
          title={anyOn ? "Turn all off" : "Turn all on"}
        >
          <div style={{ width: 22, height: 22, borderRadius: "50%", background: "#fff", position: "absolute", top: 3, left: anyOn ? 23 : 3, transition: "left 0.2s ease" }} />
        </button>
      </div>

      <Slider
        label="Room Brightness" value={shownBrightness} min={0} max={100}
        onChange={applyRoomBrightness} color="#fbbf24" unit="%"
      />

      {anyColor && (
        <div style={{ marginTop: 4 }}>
          <ColorPicker
            size={160}
            currentColor={roomColor}
            onColorSelect={() => {}}
            stageApply={true}
            onApply={applyRoomColor}
            applyLabel={name}
            favorites={favorites}
            onFavoritesChange={onFavoritesChange}
          />
        </div>
      )}
    </div>
  );

  // Resolve the active panel for the surface.
  let panel = null;
  if (surfaceView === "lightning") {
    panel = (
      <LightningPanel
        roomName={name}
        isActive={lightningActive}
        onStart={onLightningStart}
        onStop={onLightningStop}
        goveeDevices={goveeDevices}
        segmentInfo={segmentInfo}
      />
    );
  } else if (surfaceView === "scenes") {
    panel = (
      <ColorMode
        roomName={name}
        hueLights={hueLights} goveeDevices={goveeDevices}
        onControlHue={onControlHue} onControlGovee={onControlGovee}
        favorites={favorites} onFavoritesChange={onFavoritesChange}
        nicknames={nicknames}
        segmentInfo={segmentInfo}
        roomLayouts={roomLayouts}
        fixtures={fixtures}
        minSatEnabled={minSatEnabled}
        minSatPct={minSatPct}
        segmentFillModes={segmentFillModes}
        sceneAddress={sceneAddress}
        onSceneAddressChange={onSceneAddressChange}
        savedColorState={savedColorState}
        onScheduleLook={onScheduleLook ? (plan) => onScheduleLook(name, plan) : null}
        onApply={(applied, colorStateSnapshot) => {
          setColorModeApplied(applied);
          if (colorStateSnapshot) {
            api("/room-color-state", {
              method: "POST",
              body: JSON.stringify({ room_name: name, ...colorStateSnapshot }),
            }).catch(e => console.warn("[RoomSection] color-state save failed:", e));
          }
          if (onSegmentStateRefresh) {
            setTimeout(onSegmentStateRefresh, 5000);
          }
          // Applying a scene used to ALSO rewrite every segmented device's
          // LightCard control mode from the room-level address toggle (v3.18.0
          // removed it). Two unrelated preferences moving as one is exactly the
          // coupling the per-device scene-addressing switch exists to undo: how
          // a scene paints a device and which controls its card shows are
          // different questions.
        }}
      />
    );
  } else if (surfaceView === "controls") {
    panel = controlsPanel;
  } else if (surfaceView === "map") {
    panel = roomMapEl;
  } else if (surfaceView === "debug") {
    panel = (
      <SegmentResetDebug
        roomName={name}
        goveeDevices={goveeDevices}
        segmentInfo={segmentInfo}
      />
    );
  }

  return (
    <div style={{ marginBottom: 32 }}>
      {/* Room header — name row, then a row of surface-opener buttons. */}
      <div style={{ display: "flex", flexDirection: "column", marginBottom: 4, paddingBottom: 12, borderBottom: "1px solid #1e293b", gap: 12 }}>
        {/* Name, the quick looks, brightness and power all on ONE line (v3.25.0).
            The white presets used to sit in their own "Set room to" block two rows
            further down, which put the three things you reach for most often —
            warm it up, dim it, turn it off — in three different places. The
            heading is gone with them: the buttons already say "Soft White" and
            "Cool White", and a header row can't afford a label per group.
            On a phone the right-hand group wraps to its own line as a unit. */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div
            onClick={() => setCollapsed(!collapsed)}
            style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", userSelect: "none", flex: isMobile ? "1 1 auto" : "0 1 auto", minWidth: 0 }}
          >
            <span style={{ fontSize: 14, color: "#64748b", transition: "transform 0.2s", transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)", display: "inline-block" }}>&#x25BC;</span>
            <h2 style={{ fontSize: isMobile ? 17 : 20, fontWeight: 700, color: "#f8fafc", margin: 0 }}>{name}</h2>
            <span style={{ fontSize: 12, color: "#64748b", whiteSpace: "nowrap" }}>
              {allLights.length} {allLights.length === 1 ? "light" : "lights"}
              {totalSegments > 0 && <> &middot; {totalSegments} segments</>}
            </span>
          </div>

          {/* Power stays glued to the NAME on a phone. 390px can't hold name +
              two presets + slider + toggle on one line, so something has to wrap
              — and the right thing to keep on the identity line is the control
              you reach for in the dark. The looks wrap below it as a unit. */}
          {isMobile && powerToggle}

          <div style={{
            display: "flex", alignItems: "center", gap: isMobile ? 6 : 8,
            flexWrap: "wrap", marginLeft: isMobile ? 0 : "auto",
            width: isMobile ? "100%" : "auto",
          }}>
            {allLights.length > 0 && (
              <>
                {whiteBtn("Soft White", SOFT_WHITE_K, "#fcd34d", "rgba(251,191,36,0.12)", "rgba(251,191,36,0.4)")}
                {whiteBtn("Cool White", COOL_WHITE_K, "#93c5fd", "rgba(96,165,250,0.12)", "rgba(96,165,250,0.4)")}
                <InlineBrightness value={shownBrightness} onChange={applyRoomBrightness} isMobile={isMobile} />
              </>
            )}
            {!isMobile && powerToggle}
          </div>
        </div>

        {/* What the room is currently set to. Sits directly under the name and
            OUTSIDE the `collapsed` gate, so a collapsed room still answers "what
            did I set this to?" at a glance — the whole point of the feature. */}
        <RoomLastApplied entry={lastApplied} status={lastStatus} applying={applying}
          onReapply={onReapply ? () => onReapply(name) : null} isMobile={isMobile} />

        {/* Surface openers */}
        <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 6 : 8, flexWrap: "wrap" }}>
          {openerBtn("lightning", lightningActive ? "⚡ Storm" : "⚡ Lightning", lightningActive ? "#fbbf24" : "#94a3b8")}
          {openerBtn("scenes", "Scenes", "#34d399")}
          {openerBtn("controls", "Controls", "#a5b4fc")}
          {canMap && openerBtn("map", "🗺 Room Map", "#22d3ee")}
          {anySegmented && openerBtn("debug", "Debug", "#64748b", true)}
          {/* Adding a light LATER hits the same wall as creating an empty room,
              so the picker is reachable here too — not only from the empty state.
              Hidden when there's nothing spare to add. */}
          {isRealRoom && allLights.length > 0 && (unassignedDevices || []).length > 0 && onAssignDevices && (
            <button
              onClick={() => setShowAssign(true)}
              title={`${unassignedDevices.length} light${unassignedDevices.length === 1 ? "" : "s"} not in any room`}
              style={{
                padding: isMobile ? "6px 12px" : "6px 16px", borderRadius: 8,
                border: "1px dashed #475569", background: "transparent", color: "#94a3b8",
                fontSize: isMobile ? 11 : 12, fontWeight: 700, cursor: "pointer",
                whiteSpace: "nowrap", transition: "all 0.2s",
              }}
            >+ Lights</button>
          )}
        </div>

        {/* The "Set room to" block that used to live here moved INTO the name row
            above (v3.25.0) — same buttons, same behaviour, one less place to look. */}

        {/* A brand-new room is empty, and every control above it is inert. Say so,
            and offer the one thing that makes it useful — rather than leaving the
            user to discover that lights are assigned on a different tab. */}
        {isRealRoom && allLights.length === 0 && (
          <div style={{
            padding: isMobile ? 12 : 14, borderRadius: 10,
            background: "rgba(99,102,241,0.08)", border: "1px dashed #4338ca",
            display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
          }}>
            <div style={{ flex: "1 1 200px", minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#c7d2fe" }}>
                No lights in this room yet
              </div>
              <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>
                {(unassignedDevices || []).length > 0
                  ? `${(unassignedDevices || []).length} light${(unassignedDevices || []).length === 1 ? " isn't" : "s aren't"} in a room yet.`
                  : (
                    <>
                      Every light is already in another room — move one here from{" "}
                      <button
                        onClick={() => onNavigate && onNavigate("assign rooms")}
                        disabled={!onNavigate}
                        style={{
                          border: "none", background: "transparent", padding: 0,
                          font: "inherit", color: "#818cf8", fontWeight: 700,
                          textDecoration: "underline", textUnderlineOffset: 2,
                          cursor: onNavigate ? "pointer" : "default",
                        }}
                      >Assign Rooms</button>.
                    </>
                  )}
              </div>
            </div>
            {(unassignedDevices || []).length > 0 && onAssignDevices && (
              <button
                onClick={() => setShowAssign(true)}
                style={{
                  padding: isMobile ? "8px 14px" : "8px 18px", borderRadius: 8,
                  border: "none", background: "#6366f1", color: "#fff",
                  fontSize: isMobile ? 12 : 13, fontWeight: 700, cursor: "pointer",
                  whiteSpace: "nowrap", flexShrink: 0,
                }}
              >Assign lights</button>
            )}
          </div>
        )}
      </div>

      {showAssign && (
        <DevicePickerModal
          title={`Add lights to ${name}`}
          devices={unassignedDevices || []}
          onSelect={(picked) => onAssignDevices(name, picked)}
          onClose={() => setShowAssign(false)}
          nicknames={nicknames}
        />
      )}

      {/* Light-card grid — renders independently of the control surface. */}
      {!collapsed && (
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fill, minmax(260px, 1fr))", gap: 12, marginTop: 18 }}>
          {allLights.map((light, i) => {
            const devKey = light.type === "hue" ? `hue:${light.id}` : `govee:${goveeSlug(light)}`;
            const segColors = {};
            const persistedEntry = light.ip && segmentState ? segmentState[light.ip] : null;
            if (persistedEntry?.colors) {
              Object.entries(persistedEntry.colors).forEach(([k, v]) => {
                segColors[parseInt(k)] = v;
              });
            }
            if (colorModeApplied) {
              Object.entries(colorModeApplied).forEach(([k, v]) => {
                const m = k.match(/^(.+):seg(\d+)$/);
                if (m && m[1] === devKey) segColors[parseInt(m[2])] = v;
              });
            }
            return (
              <LightCard
                key={`${light.type}-${light.id || light.ip}-${i}`}
                light={light}
                onControl={(l, cmd) => {
                  l._controlFn(l, cmd);
                  if (l.type === "govee" && onSegmentStateRefresh &&
                      (cmd.r !== undefined || cmd.on === false)) {
                    setTimeout(onSegmentStateRefresh, 200);
                  }
                }}
                favorites={favorites}
                onFavoritesChange={onFavoritesChange}
                nicknames={nicknames}
                onNicknameChange={onNicknameChange}
                segmentInfo={segmentInfo}
                segmentColors={Object.keys(segColors).length > 0 ? segColors : null}
                segmentBrightness={persistedEntry?.brightness}
                onSegmentStateRefresh={onSegmentStateRefresh}
                controlMode={deviceModes?.[devKey]}
                onControlModeChange={(m) => onDeviceModeChange && onDeviceModeChange(devKey, m)}
                segmentFillMode={segmentFillModes?.[devKey]}
                onSegmentFillModeChange={(m) => onSegmentFillModeChange && onSegmentFillModeChange(devKey, m)}
                onSegmentCountChange={onSegmentCountChange}
                onRecheck={onRecheck}
                ctCorrection={ctCorrection}
              />
            );
          })}
        </div>
      )}

      <ControlSurface
        view={surfaceView} views={views}
        onView={setSurfaceView} onClose={() => setSurfaceView(null)}
        roomName={name} isMobile={isMobile}
      >
        {panel}
      </ControlSurface>
    </div>
  );
}
