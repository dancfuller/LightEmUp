// ─── React Hooks & API ──────────────────────────────────────────────────────
const { useState, useEffect, useCallback, useRef, useContext, createContext } = React;

const API = "/api";

// Per-tab identifier sent as X-Client-Id on every mutating request so the
// SSE event stream can tag each broadcast with its origin. A client ignores
// events whose source matches its own id, avoiding self-triggered refetches.
const CLIENT_ID =
  (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID()
    : `c-${Date.now()}-${Math.random().toString(36).slice(2)}`;

// PickerStyleContext: controls whether ColorPicker's "Wheel" tab renders
// the full ColorWheel or the compact HueBar. Provider lives at the App
// root; the user toggles it in Settings. Default "huebar".
const PickerStyleContext = createContext("huebar");

// ─── Responsive Helper ──────────────────────────────────────────────────────
// Matches portrait-mode phones (iPhone 17 ~402px, Galaxy S26 ~384px).
// Breakpoint 640px covers all common phones in portrait, including larger ones.
const MOBILE_BREAKPOINT = 640;
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined" ? window.innerWidth < MOBILE_BREAKPOINT : false
  );
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return isMobile;
}

// ─── Seeded PRNG ──────────────────────────────────────────────────────────
// Color assignment (palette/tonal/custom adjacency) used to call Math.random(),
// so every browser computed a *different* device→color layout from the same
// palette. That meant a second session never matched the lights another phone
// had already set. seededRng makes the assignment deterministic: given the same
// room + shuffle seed + inputs, every client computes the identical layout. The
// "Shuffle" button bumps the seed (persisted in room_color_state) so a re-roll
// propagates to all sessions instead of diverging.
function hashStr(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function seededRng(seed) {
  let a = (typeof seed === "number" ? seed : hashStr(String(seed))) >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Throttled slider control ────────────────────────────────────────────────
// Sliders that drive lights flood slow Govee LAN devices: each onChange tick
// fires a command, and the device applies/animates them slowly, so a drag lags
// seconds behind. This hook keeps the thumb/label instant via local state while
// committing onChange at most every `ms` (trailing — the final value always
// lands). External value changes are honored except mid-drag, so the thumb
// never jumps backward while the user is dragging.
// Below this much travel, a touch is a tap and not a drag.
const TAP_SLOP_PX = 6;

// Instant thumb + coalesced commands, AND a guard so an accidental touch never
// reaches a light (v3.32.0).
//
// The accident is specific, and was reported from a phone: a range input's TRACK
// is tappable, so landing a finger anywhere on it jumps the thumb — and the
// browser reports that as input, which `onInput` used to commit immediately (the
// throttle only ever governed the second command onward). Scrolling a long list
// of lights and brushing a slider therefore put a real command on the wire, for
// whichever light happened to sit under your thumb.
//
// So on TOUCH we wait for real movement before committing anything. The thumb
// still follows the finger, so the control stays alive; but nothing is sent
// until you actually drag, and a tap that never moved snaps back to the device's
// real value. A MOUSE is deliberately exempt — clicking a track to jump to 60%
// is a normal desktop interaction, and a pointer can't brush a control while
// scrolling.
//
// Spread the returned `guard` onto the <input type="range"> and give it
// `touchAction: "pan-y"`. The two halves fix different gestures and BOTH are
// needed: pan-y keeps a vertical swipe scrolling the page instead of being
// captured by the slider, and the guard stops the stationary tap.
// ─── Scene-apply progress, by scope (v3.35.0) ──────────────────────────────
// The backend streams `scene_apply` SSE events and app.js re-broadcasts them as
// a window CustomEvent. `scope` is the channel: a room name for a room scene, a
// device key for a one-light scene (see the backend's SceneApplyRequest.scope).
//
// This is a HOOK rather than a snippet because three places need the same
// answer — the scene panel, the light card's header, and (already) RoomSection —
// and a segmented apply runs 13+ seconds, so "is this thing still working?" has
// to be answerable from wherever the user happens to be looking. Two hand-rolled
// copies of this listener would drift on exactly the fields that matter (`label`
// was dropped by the first copy, which is what made the per-light status read as
// missing entirely).
function useSceneProgress(scope) {
  const [state, setState] = useState({ active: false, phase: null, done: 0, total: 0, label: "", endAt: 0 });
  // Set when we're following a ROOM's run because one of its steps named us —
  // see the device match below.
  const adoptedRoom = useRef(null);
  useEffect(() => {
    if (!scope) return;
    const onProgress = (e) => {
      const d = e.detail;
      if (!d) return;
      // Two ways an event is ours:
      //   • scope match — this run is ABOUT us (a one-light scene, or a room
      //     component asking about its own room).
      //   • device match — a ROOM scene whose current step is touching us
      //     (v3.35.1). A room apply is scoped to the room, so without this a
      //     segmented globe or rope sat visibly idle for the 1.8s-per-color it
      //     was actually being painted.
      const direct = d.scope === scope;
      const viaDevice = !!d.device && d.device === scope;
      // A room run's terminal event names no device, so a listener that only
      // ever matched via `device` would never see the end and would stay
      // "applying" forever. Remember whose run adopted us and accept its close.
      const ourRoomEnding = d.active === false && adoptedRoom.current && d.scope === adoptedRoom.current;
      if (!direct && !viaDevice && !ourRoomEnding) return;
      if (d.active === false) {
        adoptedRoom.current = null;
        setState(prev => ({ ...prev, active: false, phase: d.phase || "done", label: "" }));
        return;
      }
      if (viaDevice && !direct) adoptedRoom.current = d.scope;
      setState(prev => ({
        active: true,
        phase: d.phase || prev.phase,
        done: typeof d.done === "number" ? d.done : prev.done,
        total: typeof d.total === "number" ? d.total : prev.total,
        label: d.label !== undefined ? d.label : prev.label,
        endAt: typeof d.end_at === "number" ? d.end_at : prev.endAt,
      }));
    };
    window.addEventListener("lightemup-scene-apply", onProgress);
    return () => window.removeEventListener("lightemup-scene-apply", onProgress);
  }, [scope]);
  // Let a caller show progress the instant it presses Apply, before the first
  // event arrives — a 2.6s silent gap at the start otherwise reads as nothing
  // having happened.
  const begin = useCallback((total, endAt) => {
    setState({ active: true, phase: "applying", done: 0, total, label: "Starting…", endAt });
  }, []);
  const clear = useCallback(() => {
    setState({ active: false, phase: null, done: 0, total: 0, label: "", endAt: 0 });
  }, []);
  return [state, begin, clear];
}

// A thin progress bar + countdown, shared by every surface that reports a scene
// apply. Renders nothing when idle.
function SceneProgressBar({ progress, compact }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!progress.active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [progress.active]);
  if (!progress.active) return null;
  const pct = progress.total ? Math.min(100, Math.round(progress.done / progress.total * 100)) : 0;
  const left = Math.max(0, Math.ceil((progress.endAt - now) / 1000));
  return (
    <div style={{ width: "100%" }}>
      <div style={{
        height: compact ? 3 : 5, borderRadius: 3, background: "#1e293b", overflow: "hidden",
      }}>
        <div style={{
          width: `${pct}%`, height: "100%", background: "#6366f1",
          transition: "width 0.3s ease",
        }} />
      </div>
      <div style={{
        display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap",
        marginTop: 4, fontSize: compact ? 10 : 11, color: "#94a3b8",
      }}>
        <span style={{ fontWeight: 700, color: "#c7d2fe" }}>
          {progress.total ? `${progress.done}/${progress.total}` : "Working"}
        </span>
        {progress.label && (
          <span style={{
            minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>{progress.label}</span>
        )}
        <div style={{ flex: 1 }} />
        {left > 0 && <span style={{ color: "#64748b" }}>~{left}s left</span>}
      </div>
    </div>
  );
}

function useThrottledControl(value, onCommit, ms = 180) {
  const [local, setLocal] = useState(value);
  const dragging = useRef(false);
  const slot = useRef({ timer: null, pending: null });
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  const touch = useRef({ active: false, moved: false, x: 0 });
  // The device's real value, for putting the thumb back after a tap.
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => { if (!dragging.current) setLocal(value); }, [value]);

  const flush = useCallback((v) => {
    const s = slot.current;
    s.pending = v;
    if (s.timer) return;
    const fire = () => {
      if (s.pending == null) { s.timer = null; dragging.current = false; return; }
      const x = s.pending; s.pending = null;
      commitRef.current(x);
      s.timer = setTimeout(fire, ms);
    };
    fire();
  }, [ms]);

  const onInput = useCallback((v) => {
    dragging.current = true;
    setLocal(v);
    // A touch that hasn't travelled yet: show it, don't send it.
    if (touch.current.active && !touch.current.moved) return;
    flush(v);
  }, [flush]);

  const endTouch = useCallback(() => {
    const t = touch.current;
    if (t.active && !t.moved) {
      // A tap that drove nothing. Put the thumb back where the device actually
      // is, or the control would keep claiming a value it never sent.
      dragging.current = false;
      setLocal(valueRef.current);
    }
    touch.current = { active: false, moved: false, x: 0 };
  }, []);

  const guard = {
    onPointerDown: (e) => {
      if (e.pointerType !== "touch") return;
      touch.current = { active: true, moved: false, x: e.clientX };
    },
    onPointerMove: (e) => {
      const t = touch.current;
      if (!t.active || t.moved) return;
      if (Math.abs(e.clientX - t.x) > TAP_SLOP_PX) {
        t.moved = true;
        // Now it's a real drag: send where the thumb has already got to.
        flush(Number(e.currentTarget.value));
      }
    },
    onPointerUp: endTouch,
    // A vertical scroll under `touch-action: pan-y` cancels the pointer rather
    // than ending it — same treatment, or the guard would stay armed forever.
    onPointerCancel: endTouch,
  };

  return [local, onInput, guard];
}

// ─── Color Utilities ────────────────────────────────────────────────────────

function hsvToRgb(h, s, v) {
  let r, g, b;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

// ─── API Helpers ────────────────────────────────────────────────────────────

// When this page last sent anything but a GET. app.js's once-a-minute Hue refresh
// skips a tick that lands right after one: a bridge read racing a command can come
// back with the state from just BEFORE it and flip the card back (v3.50.0).
let API_LAST_WRITE_AT = 0;
function apiLastWriteAt() { return API_LAST_WRITE_AT; }

async function api(path, options = {}) {
  if (options.method && options.method !== "GET") API_LAST_WRITE_AT = Date.now();
  try {
    const { headers: optHeaders, ...rest } = options;
    const res = await fetch(`${API}${path}`, {
      ...rest,
      headers: {
        "Content-Type": "application/json",
        "X-Client-Id": CLIENT_ID,
        ...(optHeaders || {}),
      },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }
    return await res.json();
  } catch (e) {
    console.error(`API ${path}:`, e);
    throw e;
  }
}


// ─── Usage log (v3.49.0) ────────────────────────────────────────────────────
// Which screens and actions each device actually uses, so the interface can be
// arranged around real use instead of guesses. It records WHAT was used — never
// colors, names or anything typed. Storage and the summary are
// backend/usage_log.py; the Settings card is usage-log.js.
//
// Call `trackUse("open", {s})` when a screen or panel is shown and
// `trackUse("act", {s, a, room, key, detail})` when something is actually done.
// `s` is the surface ("room:scenes", "tab:schedules", "light"), `a` the action.
// Keep `detail` to a few small scalars; the server drops anything else.
const USAGE_DEVICE_KEY = "leu.usageDevice";
const USAGE_FLUSH_MS = 15000;
const USAGE_COALESCE_MS = 3000;
const USAGE_VIA_MS = 60000;
const usageQueue = [];

// WHERE a touch landed (v3.51.2). A container marks itself with
// data-usage-surface (and data-usage-room); the nearest one around the target
// wins, so a light card inside a room drawer reads as that drawer. Every "act"
// then records it as `via`. Capture phase, so a handler that stops propagation
// can't hide it; a touch outside every tagged surface clears it, so a stale
// surface can't be credited later. Without this a light switched from
// Favorites, a room drawer or All Lights all read as the same `light` event.
let usageLastSurface = null;
["pointerdown", "keydown"].forEach(type => document.addEventListener(type, (e) => {
  try {
    const el = e.target && e.target.closest ? e.target.closest("[data-usage-surface]") : null;
    usageLastSurface = el ? {
      s: el.getAttribute("data-usage-surface"),
      room: el.getAttribute("data-usage-room") || undefined,
      at: Date.now(),
    } : null;
  } catch (err) { /* a diagnostic must never break a control */ }
}, true));

// True when the last touch landed in surface `s` — for changes that ALSO happen
// with nobody touching anything (a layout fitted to its contents on open).
function usageTouchedWithin(s) {
  return !!usageLastSurface && usageLastSurface.s === s
    && Date.now() - usageLastSurface.at < USAGE_VIA_MS;
}

// One random id per browser, kept in localStorage. NOT crypto.randomUUID: the Pi
// is served over plain http://, which isn't a secure context, and randomUUID is
// undefined there. getRandomValues has no such restriction. If storage is blocked
// the id lasts for this page load only — a visit still counts, it just can't be
// tied to the last one.
let USAGE_DEVICE_ID = (() => {
  const make = () => {
    try {
      const b = new Uint8Array(9);
      crypto.getRandomValues(b);
      return Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
    } catch (e) {
      return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    }
  };
  // The Pi also keeps this id in a cookie it sets itself (v3.51.2). Safari
  // deletes a site's localStorage after seven days of browsing without visiting
  // it — every visit, for someone who opens the app monthly — but a cookie the
  // SERVER set isn't covered by that rule. So a wiped localStorage falls back to it.
  const fromCookie = (() => {
    try {
      const m = document.cookie.match(/(?:^|;\s*)leu_device=([A-Za-z0-9_-]{6,64})/);
      return m ? m[1] : null;
    } catch (e) { return null; }
  })();
  try {
    let id = localStorage.getItem(USAGE_DEVICE_KEY);
    if (!id || !/^[A-Za-z0-9_-]{6,64}$/.test(id)) {
      id = fromCookie || make();
      localStorage.setItem(USAGE_DEVICE_KEY, id);
    }
    return id;
  } catch (e) {
    return fromCookie || make();
  }
})();

// The server's answer to "which device is this?" wins (usage_log.canonical_id).
function usageAdoptDeviceId(id) {
  if (!id || id === USAGE_DEVICE_ID || !/^[A-Za-z0-9_-]{6,64}$/.test(id)) return;
  USAGE_DEVICE_ID = id;
  try { localStorage.setItem(USAGE_DEVICE_KEY, id); } catch (e) { /* ignore */ }
}

// Repeats of the same thing within a few seconds fold into one event with a
// count, so dragging a slider is one "brightness", not forty throttled commits.
function trackUse(ev, fields = {}) {
  try {
    const now = Date.now();
    if (ev === "act" && fields.via === undefined && usageLastSurface
        && now - usageLastSurface.at < USAGE_VIA_MS) {
      fields = { ...fields, via: usageLastSurface.s };
      if (usageLastSurface.room) fields.via_room = usageLastSurface.room;
    }
    const last = usageQueue[usageQueue.length - 1];
    // `via` and `detail` are part of what makes two events the same (v3.51.2).
    // Folding ignored `detail`, so two lightshow edits within 3s kept only the
    // first field changed, and two different zones pressed together kept one.
    if (last && last.ev === ev && last.s === fields.s && last.a === fields.a
        && last.room === fields.room && last.key === fields.key
        && last.zone === fields.zone && last.via === fields.via
        && JSON.stringify(last.detail || null) === JSON.stringify(fields.detail || null)
        && now - last.at < USAGE_COALESCE_MS) {
      last.n = (last.n || 1) + 1;
      last.at = now;
      return;
    }
    usageQueue.push({ ev, ...fields, at: now });
    if (usageQueue.length > 200) usageQueue.shift();
  } catch (e) { /* a diagnostic must never break a control */ }
}

// What kind of change a light or room command is, for the usage log.
function usageCmdKind(cmd) {
  if (!cmd) return "other";
  if (cmd.on === false) return "off";
  if (cmd.r !== undefined) return "color";
  if (cmd.color_temp !== undefined || cmd.color_temp_kelvin !== undefined) return "white";
  if (cmd.brightness !== undefined) return cmd.defer ? "level-while-off" : "brightness";
  if (cmd.on === true) return "on";
  return "other";
}

// Plain fetch, not api(): this must never surface an error or block anything.
// `keepalive` lets the last batch leave as the page is hidden or closed, which on
// a phone is how nearly every visit ends.
function flushUsage(keepalive) {
  if (!usageQueue.length) return;
  const events = usageQueue.splice(0, usageQueue.length);
  // A batch that doesn't arrive goes back in the queue (v3.51.2). It used to be
  // taken out first and dropped on any failure — a Wi-Fi blip, a deploy
  // restarting the Pi. A 4xx is not retried: it would only fail the same way.
  const requeue = () => {
    usageQueue.unshift(...events);
    if (usageQueue.length > 200) usageQueue.splice(0, usageQueue.length - 200);
  };
  try {
    fetch(`${API}/usage/events`, {
      method: "POST", keepalive: !!keepalive,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_id: USAGE_DEVICE_ID, width: window.innerWidth,
        sent_at: Date.now(), events,
      }),
    }).then(r => {
      if (r.ok) return r.json();
      if (r.status >= 500) requeue();
      return null;
    }).then(res => usageAdoptDeviceId(res && res.device_id))
      .catch(() => requeue());
  } catch (e) { requeue(); }
}
setInterval(() => flushUsage(false), USAGE_FLUSH_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushUsage(true);
});
window.addEventListener("pagehide", () => flushUsage(true));
trackUse("open", { s: "app" });

// ─── Device Name Helpers ────────────────────────────────────────────────────

// SKU subset for devices likely on this network. Full table is in discovery.py.
const GOVEE_SKU_NAMES = {
  "H6061": "Glide Hexa Light Panels",
  "H61D3": "Neon Rope Light 2",
  "H60A6": "Ceiling Light Pro",
  "H7065": "Outdoor Spot Lights 2-Pack",
  "H7066": "Outdoor Spot Lights 4-Pack",
  "H70C1": "Christmas String Lights 2 10M",
};

// ─── Device identity keys ───────────────────────────────────────────────────
// A Govee device's identity is its stable device-id (`mac`), NOT its DHCP IP.
// All persisted associations (rooms, nicknames, layouts, segments, calibration,
// state) key by a colon-free slug of the mac; the IP is only the live UDP address.
// Mirrors backend gv_slug()/gv_key(). Falls back to IP for a device with no mac.
function normMac(mac) {
  return (mac || "").replace(/[:-]/g, "").toLowerCase();
}
function goveeSlug(device) {
  const m = device?.mac;
  return (m && m !== "unknown") ? normMac(m) : (device?.ip || "");
}
function deviceKey(device) {
  return device.type === "hue" ? `hue:${device.id}` : `govee:${goveeSlug(device)}`;
}

// How many segments a Govee device is treated as having: a count configured for
// THIS device (a 7-panel Hexa) beats the SKU's maximum (15). Mirrors the
// backend's gv_segment_count — the two MUST agree, or a scheduled scene
// addresses a different number of segments than the same look applied by hand.
// (light-card.js, room-map.js, room-section.js and segment-reset-debug.js still
// inline this same expression; fold them in here when you next touch them.)
function goveeSegmentCount(light, segmentInfo) {
  if (!light) return 0;
  return (light.ip && segmentInfo?.configured_counts?.[goveeSlug(light)])
    || (light.sku && segmentInfo?.sku_table?.[light.sku]?.count) || 0;
}

function getDeviceDisplayName(device, nicknames) {
  const deviceKey_ = deviceKey(device);
  const nickname = nicknames?.[deviceKey_] || "";
  const friendlyName = device.type === "hue"
    ? (device.product_name || device.name || device.model || `Light ${device.id}`)
    : (GOVEE_SKU_NAMES[device.sku] || device.name || device.sku || "Govee Device");
  return { nickname, friendlyName, deviceKey: deviceKey_ };
}

// ─── Color Conversion Helpers ───────────────────────────────────────────────

function hueXYToRGB(xy, bri) {
  // Convert Hue CIE xy + brightness to RGB
  if (!xy || xy.length < 2) return null;
  const [x, y] = xy;
  const z = 1.0 - x - y;
  const Y = (bri || 254) / 254;
  const X = (Y / y) * x;
  const Z = (Y / y) * z;
  // Wide RGB D65 conversion
  let r = X * 1.656492 - Y * 0.354851 - Z * 0.255038;
  let g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152;
  let b = X * 0.051713 - Y * 0.121364 + Z * 1.011530;
  // Gamma correction
  r = r <= 0.0031308 ? 12.92 * r : (1.0 + 0.055) * Math.pow(r, 1.0 / 2.4) - 0.055;
  g = g <= 0.0031308 ? 12.92 * g : (1.0 + 0.055) * Math.pow(g, 1.0 / 2.4) - 0.055;
  b = b <= 0.0031308 ? 12.92 * b : (1.0 + 0.055) * Math.pow(b, 1.0 / 2.4) - 0.055;
  return {
    r: Math.max(0, Math.min(255, Math.round(r * 255))),
    g: Math.max(0, Math.min(255, Math.round(g * 255))),
    b: Math.max(0, Math.min(255, Math.round(b * 255))),
  };
}

function hueSatToRGB(hue, sat) {
  // Convert Hue hue (0-65535) + sat (0-254) to RGB
  if (hue == null || sat == null) return null;
  const h = hue / 65535;
  const s = sat / 254;
  const v = 1;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }
  return {
    r: Math.max(0, Math.min(255, Math.round(r * 255))),
    g: Math.max(0, Math.min(255, Math.round(g * 255))),
    b: Math.max(0, Math.min(255, Math.round(b * 255))),
  };
}

function getInitialColor(light) {
  // Explicit color from optimistic update takes precedence over polled XY/hue values
  if (light.state?.color) {
    const c = light.state.color;
    if (c.r != null) return { r: c.r, g: c.g, b: c.b };
  }
  if (light.type === "hue" && light.state) {
    // Prefer xy if available
    if (light.state.xy) {
      return hueXYToRGB(light.state.xy, light.state.brightness);
    }
    // Fall back to hue/sat
    if (light.state.hue != null && light.state.saturation != null) {
      return hueSatToRGB(light.state.hue, light.state.saturation);
    }
  }
  return null;
}

// ─── Hex ⇄ RGB ──────────────────────────────────────────────────────────────
// The leading "#" is optional everywhere — "#1e90ff", "1e90ff", "#19f" and
// "19f" all parse — so no caller (or user) has to think about it. Returns null
// when the text isn't a hex color, which is how the manual-entry inputs tell a
// half-typed draft from a real value.
function hexToRgb(hex) {
  const s = String(hex ?? "").trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(s)) {
    return {
      r: parseInt(s[0] + s[0], 16),
      g: parseInt(s[1] + s[1], 16),
      b: parseInt(s[2] + s[2], 16),
    };
  }
  if (/^[0-9a-f]{6}$/i.test(s)) {
    const n = parseInt(s, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  return null;
}

// Always emits the canonical "#RRGGBB" (uppercase). Channels are clamped to 0-255.
function rgbToHex(r, g, b) {
  const chan = (v) => Math.max(0, Math.min(255, Math.round(Number(v) || 0)))
    .toString(16).padStart(2, "0");
  return `#${chan(r)}${chan(g)}${chan(b)}`.toUpperCase();
}

// ─── HSL Utilities (for tonal shade generation) ─────────────────────────────

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) { h = s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  return { h, s, l };
}

function hslToRgb(h, s, l) {
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

function generateTonalShades(baseR, baseG, baseB, count) {
  // Vary HSV saturation with V=1 so every shade has max RGB channel = 255.
  // The device's brightness slider then sets actual brightness; tonal
  // variation comes from vivid → pastel (saturation), not dark → light
  // (lightness), so all lights appear at the chosen brightness.
  // HSV(h, s, 1) → HSL(h, 1, 1 - s/2).
  const { h } = rgbToHsl(baseR, baseG, baseB);
  const shades = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / (count - 1);
    const sV = 1.0 - t * 0.80; // HSV saturation: 1.00 (vivid) → 0.20 (near-white)
    const lH = 1 - sV / 2;     // HSL lightness: 0.50 → 0.90
    const hAdj = h + (t - 0.5) * 0.03; // tiny hue drift for richness
    shades.push(hslToRgb(((hAdj % 1) + 1) % 1, 1, lH));
  }
  return shades;
}

// ─── Color Temperature (white) Utilities ────────────────────────────────────

// User-facing tunable-white range. 2000K = candle warm, 6500K = cool daylight.
const CT_MIN_K = 2000;
const CT_MAX_K = 6500;

// 4 named white palettes — each a [min,max] Kelvin band.
const CT_PALETTES = [
  { name: "Warm White",    min: 2000, max: 3000 },
  { name: "Neutral White", min: 3000, max: 4500 },
  { name: "Cool White",    min: 4500, max: 6500 },
  { name: "All Whites",    min: 2000, max: 6500 },
];

// Fixed white-point sweep used by the CT calibration panel (Settings). Govee
// LAN devices render these bluer than Hue, so we sample a Hue reference vs each
// Govee device at each target and record a warmer corrected Kelvin.
const CT_CALIBRATION_TARGETS = [2000, 2700, 3500, 4500, 5500, 6500];

// Tanner Helland blackbody approximation → display RGB for a Kelvin value.
// Used for swatches, map dots, and Govee segment packets (segments are RGB-only).
function kelvinToRGB(kelvin) {
  const t = Math.max(1000, Math.min(40000, kelvin)) / 100;
  let r, g, b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return { r: clamp(r), g: clamp(g), b: clamp(b) };
}

// Kelvin → Hue mireds (m3k). Hue accepts ct in [153, 500] (≈6500K..2000K).
function kelvinToMired(kelvin) {
  return Math.max(153, Math.min(500, Math.round(1000000 / kelvin)));
}

// Spread n Kelvin values across [min,max], evenly in mired space (perceptually
// more uniform than linear Kelvin). Returns an array of Kelvin ints.
function spreadKelvin(minK, maxK, n) {
  if (n <= 0) return [];
  const m0 = 1000000 / maxK; // mired of the warmest visual = largest mired
  const m1 = 1000000 / minK;
  // Map index 0 → warmest (minK), index n-1 → coolest (maxK) for intuitive order.
  const out = [];
  for (let i = 0; i < n; i++) {
    const f = n === 1 ? 0 : i / (n - 1);
    // f=0 → minK (largest mired m1), f=1 → maxK (smallest mired m0)
    const mired = m1 + (m0 - m1) * f;
    out.push(Math.round(1000000 / mired));
  }
  return out;
}

// Favorite colors now live in backend config (GET /api/config → favorites,
// POST /api/favorites), loaded/saved by app.js — not in localStorage — so they
// sync across every session and device.

// ─── Color Clipboard ────────────────────────────────────────────────────────
// Copy a color off one light or segment and paste it onto another ("make the
// Triple Lamp's bottom bulb match its top"). Deliberately a short stack of
// RECENT copies rather than a single slot: the real job is usually "make these
// three match" or "reuse the two colors I just set", where one copy gets pasted
// several times and you want the previous one still reachable.
//
// This is the one piece of color state that DOESN'T live in backend config, and
// that's on purpose — it is not a re-litigation of the favorites decision above.
// Favorites are curated, durable, synced, and belong in a backup; the clipboard
// is churn from the last few minutes, scoped to the browser you're copying in,
// and would be noise in an export. The ★ Save button on a clipboard entry is the
// promotion path from "I used this a second ago" to "keep this forever".
const COLOR_CLIPBOARD_KEY = "leu.colorClipboard";
const COLOR_CLIPBOARD_MAX = 8;
// Same-tab notification. The native "storage" event only fires in OTHER tabs, so
// on its own it would leave the tab that did the copying showing a stale strip.
const COLOR_CLIPBOARD_EVENT = "leu-color-clipboard";

// Storage can throw outright (Safari private mode, site data blocked) and can
// hold anything a previous version — or a person with devtools — left there, so
// every read is defensive and a bad entry costs an empty strip, not a crash.
function readColorClipboard() {
  try {
    const raw = JSON.parse(localStorage.getItem(COLOR_CLIPBOARD_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(c => c && Number.isFinite(c.r) && Number.isFinite(c.g) && Number.isFinite(c.b))
      .slice(0, COLOR_CLIPBOARD_MAX);
  } catch (e) {
    return [];
  }
}

let colorClipboard = readColorClipboard();

function writeColorClipboard(next) {
  colorClipboard = next;
  try {
    localStorage.setItem(COLOR_CLIPBOARD_KEY, JSON.stringify(next));
  } catch (e) {
    // No persistence available — the clipboard still works for this page's life.
  }
  window.dispatchEvent(new CustomEvent(COLOR_CLIPBOARD_EVENT));
}

// `source` is a human label for where the color came from ("Triple Lamp - Top",
// "Hexa · Segment C") and is shown as the paste swatch's tooltip. Optional: the
// pickers that don't know what device they're editing just omit it.
function copyColorToClipboard(color, source) {
  const chan = (v) => Math.max(0, Math.min(255, Math.round(Number(v) || 0)));
  const entry = { r: chan(color?.r), g: chan(color?.g), b: chan(color?.b) };
  if (source) entry.source = String(source);
  // Copying a color you already have shouldn't fill the strip with duplicates —
  // the existing entry moves back to the front instead.
  const rest = colorClipboard.filter(
    c => !(c.r === entry.r && c.g === entry.g && c.b === entry.b)
  );
  writeColorClipboard([entry, ...rest].slice(0, COLOR_CLIPBOARD_MAX));
  return entry;
}

function clearColorClipboard() {
  writeColorClipboard([]);
}

// Subscribe a component to the clipboard. Every ColorPicker in the app calls
// this, which is why the store is a module-level singleton rather than props or
// context — there are eleven call sites across seven files, and threading a
// clipboard through all of them would be a lot of plumbing for a scratchpad.
function useColorClipboard() {
  const [items, setItems] = useState(colorClipboard);
  useEffect(() => {
    const onLocal = () => setItems(colorClipboard);
    const onStorage = (e) => {
      // Another tab copied something; our in-memory copy is now stale.
      if (e.key && e.key !== COLOR_CLIPBOARD_KEY) return;
      colorClipboard = readColorClipboard();
      setItems(colorClipboard);
    };
    window.addEventListener(COLOR_CLIPBOARD_EVENT, onLocal);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(COLOR_CLIPBOARD_EVENT, onLocal);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return items;
}

// Best-effort mirror to the SYSTEM clipboard, so a copied color can also be
// pasted into anything else — including this app's own hex field. Note the Pi is
// served over plain http://, which is NOT a secure context, so
// navigator.clipboard is usually undefined here and the deprecated execCommand
// path is the one that actually runs. Failure is silent by design: the in-app
// clipboard is the feature and it has already succeeded by this point.
function copyTextToSystemClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
      return;
    }
  } catch (e) { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  } catch (e) { /* no system clipboard reachable; in-app copy still happened */ }
}
