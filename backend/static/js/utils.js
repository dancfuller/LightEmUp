// ─── React Hooks & API ──────────────────────────────────────────────────────
const { useState, useEffect, useCallback, useRef } = React;

const API = "/api";

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
    const res = await fetch(`${API}${path}`, {
      headers: { "Content-Type": "application/json" },
      ...options,
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
  const { h, s } = rgbToHsl(baseR, baseG, baseB);
  const shades = [];
  // Distribute lightness from 25% to 80%, saturation varies slightly
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const l = 0.25 + t * 0.55;
    const sAdj = Math.max(0.3, s * (0.7 + 0.6 * (1 - Math.abs(t - 0.5) * 2)));
    const hAdj = h + (t - 0.5) * 0.03; // tiny hue drift for richness
    shades.push(hslToRgb(((hAdj % 1) + 1) % 1, sAdj, l));
  }
  return shades;
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
