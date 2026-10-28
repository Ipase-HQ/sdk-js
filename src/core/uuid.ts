// UUID formatting from 16 random bytes. The randomness comes from the Ids port.

function format(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < 16; i++) {
    if (i === 4 || i === 6 || i === 8 || i === 10) s += "-";
    s += (b[i] + 0x100).toString(16).slice(1);
  }
  return s;
}

/** Lowercase UUIDv4. */
export function uuid4(bytes: Uint8Array): string {
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return format(bytes);
}

/** Lowercase UUIDv7 (RFC 9562): 48 bits of Unix milliseconds, version 7, variant, 74 random bits. */
export function uuid7(ms: number, bytes: Uint8Array): string {
  let t = Math.max(0, Math.floor(ms));
  for (let i = 5; i >= 0; i--) {
    bytes[i] = t % 256;
    t = Math.floor(t / 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return format(bytes);
}
