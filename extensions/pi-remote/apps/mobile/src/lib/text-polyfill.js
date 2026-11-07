// Minimal UTF-8 TextEncoder/TextDecoder for engines that lack them (needed by @getpaseo/relay/e2ee).
function encodeUtf8(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const d = str.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
      else c = 0xfffd;
    } else if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}

function decodeUtf8(bytes, fatal) {
  let s = "";
  let i = 0;
  const bad = () => { if (fatal) throw new TypeError("The encoded data was not valid utf-8"); return 0xfffd; };
  const parts = [];
  while (i < bytes.length) {
    const b = bytes[i++];
    let cp;
    if (b < 0x80) cp = b;
    else if (b >= 0xc2 && b < 0xe0 && i < bytes.length && (bytes[i] & 0xc0) === 0x80) cp = ((b & 31) << 6) | (bytes[i++] & 63);
    else if (b >= 0xe0 && b < 0xf0 && i + 1 < bytes.length && (bytes[i] & 0xc0) === 0x80 && (bytes[i + 1] & 0xc0) === 0x80) {
      cp = ((b & 15) << 12) | ((bytes[i] & 63) << 6) | (bytes[i + 1] & 63); i += 2;
      if (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff)) cp = bad();
    } else if (b >= 0xf0 && b < 0xf5 && i + 2 < bytes.length && (bytes[i] & 0xc0) === 0x80 && (bytes[i + 1] & 0xc0) === 0x80 && (bytes[i + 2] & 0xc0) === 0x80) {
      cp = ((b & 7) << 18) | ((bytes[i] & 63) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63); i += 3;
      if (cp < 0x10000 || cp > 0x10ffff) cp = bad();
    } else cp = bad();
    if (cp > 0xffff) { cp -= 0x10000; parts.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023)); }
    else parts.push(cp);
    if (parts.length > 8192) { s += String.fromCharCode.apply(null, parts); parts.length = 0; }
  }
  return s + String.fromCharCode.apply(null, parts);
}

if (typeof globalThis.TextEncoder === "undefined") {
  globalThis.TextEncoder = class TextEncoder {
    get encoding() { return "utf-8"; }
    encode(s = "") { return encodeUtf8(String(s)); }
  };
}

let needDecoder = typeof globalThis.TextDecoder === "undefined";
if (!needDecoder) {
  try { new globalThis.TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array([0x61])); } catch { needDecoder = true; }
}
if (needDecoder) {
  globalThis.TextDecoder = class TextDecoder {
    constructor(label = "utf-8", opts = {}) { this.fatal = !!opts.fatal; }
    get encoding() { return "utf-8"; }
    decode(input) {
      if (input == null) return "";
      const bytes = input instanceof Uint8Array ? input : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
      return decodeUtf8(bytes, this.fatal);
    }
  };
}
