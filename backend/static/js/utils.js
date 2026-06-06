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

async function api(path, options = {}) {
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

function getDeviceDisplayName(device, nicknames) {
  const deviceKey = device.type === "hue" ? `hue:${device.id}` : `govee:${device.ip}`;
  const nickname = nicknames?.[deviceKey] || "";
  const friendlyName = device.type === "hue"
    ? (device.product_name || device.name || device.model || `Light ${device.id}`)
    : (GOVEE_SKU_NAMES[device.sku] || device.name || device.sku || "Govee Device");
  return { nickname, friendlyName, deviceKey };
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

// ─── Favorite Colors ────────────────────────────────────────────────────────

const STORAGE_KEY = "lightemup_fav_colors";

function loadFavoriteColors() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return [
    { r: 255, g: 180, b: 100, label: "Warm" },
    { r: 180, g: 210, b: 255, label: "Cool" },
    { r: 255, g: 245, b: 228, label: "Daylight" },
    { r: 255, g: 40, b: 40, label: "Red" },
    { r: 40, g: 80, b: 255, label: "Blue" },
    { r: 40, g: 220, b: 80, label: "Green" },
    { r: 160, g: 50, b: 255, label: "Purple" },
    { r: 255, g: 120, b: 20, label: "Orange" },
  ];
}

function saveFavoriteColors(favs) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(favs)); } catch {}
}
