// gzip for request bodies over 1 KB (protocol 2.3). CompressionStream where the browser has it;
// otherwise a valid gzip member made of stored (uncompressed) deflate blocks, which every server
// decodes and costs a few hundred bytes of code instead of a deflate implementation.

let crcTable: number[] | undefined;

function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** gzip with stored deflate blocks of at most 65535 bytes. */
export function storedGzip(data: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(data.length / 65535));
  const out = new Uint8Array(10 + data.length + blocks * 5 + 8);
  out.set([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff]);
  let o = 10;
  for (let b = 0; b < blocks; b++) {
    const start = b * 65535;
    const len = Math.min(65535, data.length - start);
    out[o++] = b === blocks - 1 ? 1 : 0;
    out[o++] = len & 0xff;
    out[o++] = len >>> 8;
    out[o++] = ~len & 0xff;
    out[o++] = (~len >>> 8) & 0xff;
    out.set(data.subarray(start, start + len), o);
    o += len;
  }
  const crc = crc32(data);
  const size = data.length;
  out.set([crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, crc >>> 24, size & 0xff, (size >>> 8) & 0xff, (size >>> 16) & 0xff, size >>> 24], o);
  return out;
}

async function streamGzip(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  writer.write(data as Uint8Array<ArrayBuffer>).catch(() => undefined);
  writer.close().catch(() => undefined);
  const reader = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export async function gzip(text: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(text);
  if (typeof CompressionStream !== "undefined") {
    try {
      return await streamGzip(data);
    } catch {
      // fall through to the stored encoding
    }
  }
  return storedGzip(data);
}
