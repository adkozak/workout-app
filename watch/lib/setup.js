// Reading the setup code (the same one the phone app uses). Kept apart from
// side.js so the settings page doesn't pull in the whole session logic.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** base64 / base64url to a UTF-8 string, without relying on atob or Buffer. */
export function b64decode(s) {
  const clean = s.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
  const bytes = [];
  let buf = 0, bits = 0;
  for (const ch of clean) {
    buf = (buf << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((buf >> bits) & 0xff); }
  }
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b < 0x80) out += String.fromCharCode(b);
    else if (b < 0xe0) out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[++i] & 0x3f));
    else if (b < 0xf0) out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[++i] & 0x3f) << 6) | (bytes[++i] & 0x3f));
    else {
      const cp = ((b & 0x07) << 18) | ((bytes[++i] & 0x3f) << 12) | ((bytes[++i] & 0x3f) << 6) | (bytes[++i] & 0x3f);
      out += String.fromCodePoint(cp);
    }
  }
  return out;
}

/** Accepts the PWA setup link or just its code; returns { url, token, name? } or null. */
export function parseSetup(input) {
  if (!input) return null;
  const m = /setup=([^&\s]+)/.exec(input);
  const code = (m ? m[1] : input).trim();
  try {
    const cfg = JSON.parse(b64decode(code));
    return cfg && cfg.url && cfg.token ? cfg : null;
  } catch (e) {
    return null;
  }
}
