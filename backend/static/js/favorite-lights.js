// ─── Favorite Lights strip (v3.33.0) ───────────────────────────────────────
// The problem this solves is pure distance. With 26 devices, All Lights renders
// 13 Hue cards and then 13 Govee ones — single-column on a phone — so reaching
// the three accent lights someone actually uses every evening means scrolling
// past twenty they don't. The Rooms tab is no better: they're buried inside a
// twelve-light room.
//
// So: star a light, and it's pinned to the top of both tabs, on screen before
// any scrolling happens at all. Rows are COMPACT by design (name + room +
// toggle, nothing draggable) so half a dozen favorites still fit above the
// fold; tapping the name expands the full LightCard in place, which is rendered
// by app.js's `renderLightCard` so it is the identical card All Lights shows.
//
// Deliberately a flat list, not named groups. Starring is one tap with nothing
// to name or manage, and in practice the list IS the group — "the lights I
// reach for". Groups remain a clean superset if several sets are ever needed.

function FavoriteLightRow({ light, deviceKey, roomName, nicknames, expanded, onToggleExpand,
                            onControl, isMobile }) {
  const isOn = light.state?.on ?? false;
  const isReachable = light.state?.reachable ?? true;
  const nickname = nicknames?.[deviceKey] || "";
  const friendly = light.type === "hue"
    ? (light.product_name || light.name || light.model || `Light ${light.id}`)
    : (GOVEE_SKU_NAMES[light.sku] || light.name || light.sku || "Govee Device");
  const displayName = nickname || friendly;
  const color = getInitialColor(light);
  const dotColor = (light.capabilities?.has_color && color)
    ? `rgb(${color.r},${color.g},${color.b})` : "#fbbf24";

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: isMobile ? 8 : 10,
      padding: isMobile ? "8px 10px" : "8px 12px",
      borderRadius: 10,
      background: isOn ? "rgba(99,102,241,0.10)" : "rgba(15,23,42,0.6)",
      border: `1px solid ${isOn ? "#3f4a6b" : "#1e293b"}`,
      opacity: isReachable ? 1 : 0.55,
    }}>
      <span style={{
        width: 10, height: 10, borderRadius: "50%", flexShrink: 0,
        background: isOn ? dotColor : "#1e293b",
        boxShadow: isOn ? `0 0 7px ${dotColor}` : "none",
        border: isOn ? "none" : "1px solid #334155",
      }} />
      <button
        onClick={onToggleExpand}
        title={expanded ? "Hide controls" : "Show full controls"}
        style={{
          flex: 1, minWidth: 0, display: "flex", alignItems: "baseline",
          gap: 6, background: "none", border: "none", padding: 0,
          cursor: "pointer", textAlign: "left", font: "inherit",
        }}
      >
        <span style={{
          minWidth: 0, fontSize: isMobile ? 13 : 14, fontWeight: 700,
          color: isOn ? "#f8fafc" : "#94a3b8",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>{displayName}</span>
        {roomName && !isMobile && (
          <span style={{ flexShrink: 0, fontSize: 10, color: "#475569" }}>{roomName}</span>
        )}
        <span style={{
          flexShrink: 0, fontSize: 9, color: "#475569",
          transform: expanded ? "rotate(90deg)" : "none",
          transition: "transform .15s", display: "inline-block",
        }}>&#x25B8;</span>
      </button>
      {!isReachable && (
        <span style={{ fontSize: 9, color: "#f87171", fontWeight: 700, textTransform: "uppercase", flexShrink: 0 }}>offline</span>
      )}
      <button
        onClick={() => onControl(light, { on: !isOn })}
        title={isOn ? "Turn off" : "Turn on"}
        style={{
          width: 40, height: 24, borderRadius: 12, border: "none", flexShrink: 0,
          background: isOn ? "#6366f1" : "#334155",
          cursor: "pointer", position: "relative", transition: "background 0.2s",
        }}
      >
        <div style={{
          width: 18, height: 18, borderRadius: "50%", background: "#fff",
          position: "absolute", top: 3, left: isOn ? 19 : 3, transition: "left 0.2s ease",
        }} />
      </button>
    </div>
  );
}

function FavoriteLightsBar({ favoriteKeys, hueLights, goveeDevices, nicknames, deviceRoomMap,
                             onControlHue, onControlGovee, onToggleFavorite, renderCard,
                             showEmptyHint }) {
  const isMobile = useIsMobile();
  const [expandedKey, setExpandedKey] = useState(null);

  // Resolve keys → live device objects, keeping the USER'S order (the array
  // order is the pin order — see the backend's favorite_lights comment).
  const byKey = {};
  hueLights.forEach(l => { byKey[`hue:${l.id}`] = l; });
  goveeDevices.forEach(d => { byKey[`govee:${goveeSlug(d)}`] = d; });

  const entries = (favoriteKeys || []).map(key => ({ key, light: byKey[key] }));
  const found = entries.filter(e => e.light);
  const orphans = entries.filter(e => !e.light);

  if (entries.length === 0) {
    // Nothing pinned. The hint only renders where the star is actually VISIBLE
    // (All Lights) — pointing at an affordance buried inside a collapsed room
    // drawer would be worse than saying nothing.
    if (!showEmptyHint) return null;
    return (
      <div style={{
        display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
        padding: isMobile ? "8px 10px" : "9px 14px", marginBottom: isMobile ? 12 : 16,
        borderRadius: 10, border: "1px dashed #334155", background: "rgba(15,23,42,0.5)",
        fontSize: isMobile ? 11 : 12, color: "#64748b",
      }}>
        <span style={{ color: "#475569", fontSize: 14 }}>&#9734;</span>
        Tap the star on any light to pin it here — pinned lights sit at the top of
        Rooms and All Lights, so you don't have to scroll to reach them.
      </div>
    );
  }

  const control = (light, cmd) => {
    if (light.type === "hue") onControlHue(light, cmd);
    else onControlGovee(light, cmd);
  };
  const setAll = (on) => found.forEach(({ light }) => control(light, { on }));

  return (
    <div style={{
      marginBottom: isMobile ? 12 : 16,
      padding: isMobile ? 10 : 14,
      borderRadius: 14,
      background: "linear-gradient(135deg, #1a2338 0%, #131c2e 100%)",
      border: "1px solid #334155",
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
        marginBottom: 8,
      }}>
        <span style={{
          display: "inline-flex", alignItems: "center", gap: 5,
          fontSize: 10, fontWeight: 800, color: "#fbbf24",
          textTransform: "uppercase", letterSpacing: 0.7,
        }}>
          <span style={{ fontSize: 12 }}>&#9733;</span>
          Favorites
        </span>
        <span style={{ fontSize: 10, color: "#475569" }}>
          {found.length} light{found.length === 1 ? "" : "s"}
        </span>
        <div style={{ flex: 1 }} />
        {/* Set-level power is the whole reason the strip is a group and not just
            a shortcut list: "turn on the hexa, globe and rope" is ONE press. */}
        <button
          onClick={() => setAll(true)}
          disabled={found.length === 0}
          style={{
            padding: isMobile ? "5px 10px" : "5px 12px", borderRadius: 7,
            border: "1px solid #4f5d7a", background: "rgba(99,102,241,0.18)",
            color: "#c7d2fe", fontSize: isMobile ? 11 : 11, fontWeight: 700,
            cursor: found.length ? "pointer" : "default",
          }}
        >All on</button>
        <button
          onClick={() => setAll(false)}
          disabled={found.length === 0}
          style={{
            padding: isMobile ? "5px 10px" : "5px 12px", borderRadius: 7,
            border: "1px solid #334155", background: "transparent",
            color: "#94a3b8", fontSize: isMobile ? 11 : 11, fontWeight: 700,
            cursor: found.length ? "pointer" : "default",
          }}
        >All off</button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {found.map(({ key, light }) => (
          <div key={key}>
            <FavoriteLightRow
              light={light} deviceKey={key} roomName={deviceRoomMap?.[key]}
              nicknames={nicknames}
              expanded={expandedKey === key}
              onToggleExpand={() => setExpandedKey(expandedKey === key ? null : key)}
              onControl={control} isMobile={isMobile}
            />
            {expandedKey === key && (
              <div style={{ marginTop: 6 }}>{renderCard(light)}</div>
            )}
          </div>
        ))}
        {/* A pinned light we can't resolve. Say so and offer the fix rather than
            dropping it silently — a favorite vanishing with no explanation is
            how you end up re-pinning it and wondering why it didn't stick. */}
        {orphans.map(({ key }) => (
          <div key={key} style={{
            display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
            padding: isMobile ? "7px 10px" : "7px 12px", borderRadius: 10,
            background: "rgba(15,23,42,0.6)", border: "1px dashed #334155",
            fontSize: 11, color: "#64748b",
          }}>
            <span style={{ fontFamily: "monospace", color: "#475569" }}>{key}</span>
            <span>isn't among the lights we can see right now.</span>
            <div style={{ flex: 1 }} />
            {onToggleFavorite && (
              <button
                onClick={() => onToggleFavorite(key)}
                style={{
                  padding: "3px 8px", borderRadius: 6, border: "1px solid #334155",
                  background: "transparent", color: "#94a3b8", fontSize: 10,
                  fontWeight: 700, cursor: "pointer",
                }}
              >Unpin</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
