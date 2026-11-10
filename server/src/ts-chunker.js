// Splits an MPEG-TS byte stream into chunks tagged with presentation time,
// so the car can buffer ahead and still feed the decoder at real-time speed.

const PACKET = 188;

// Presentation timestamp (seconds) of the PES packet starting in this TS
// packet, or null if there isn't one.
export function readPts(p) {
  if (p[0] !== 0x47 || !(p[1] & 0x40)) return null; // needs payload-unit-start
  const afc = (p[3] >> 4) & 3;
  if (!(afc & 1)) return null; // no payload
  let i = 4;
  if (afc & 2) i += 1 + p[4]; // skip adaptation field
  if (i + 14 > PACKET) return null;
  if (p[i] !== 0 || p[i + 1] !== 0 || p[i + 2] !== 1) return null;
  const streamId = p[i + 3];
  if (streamId < 0xc0 || streamId > 0xef) return null; // audio C0–DF, video E0–EF
  if (!((p[i + 7] >> 6) & 2)) return null; // no PTS
  const b = i + 9;
  const pts =
    ((p[b] >> 1) & 0x07) * 1073741824 +
    p[b + 1] * 4194304 +
    (p[b + 2] >> 1) * 32768 +
    p[b + 3] * 128 +
    (p[b + 4] >> 1);
  return pts / 90000;
}

export class TsChunker {
  // onChunk(pts, buffer): pts is the latest timestamp seen up to the end of
  // the chunk, so a chunk is safe to decode once playback reaches it.
  constructor(onChunk, { maxSpan = 0.2, maxBytes = 64 * 1024 } = {}) {
    this.onChunk = onChunk;
    this.maxSpan = maxSpan;
    this.maxBytes = maxBytes;
    this.leftover = null;
    this.parts = [];
    this.size = 0;
    this.firstPts = null;
    this.maxPts = null;
    this.spanStart = null;
  }

  push(buf) {
    if (this.leftover) {
      buf = Buffer.concat([this.leftover, buf]);
      this.leftover = null;
    }
    let off = 0;
    while (off + PACKET <= buf.length) {
      if (buf[off] !== 0x47) {
        off++; // out of sync: skip until the next sync byte
        continue;
      }
      this.packet(buf.subarray(off, off + PACKET));
      off += PACKET;
    }
    if (off < buf.length) this.leftover = Buffer.from(buf.subarray(off));
  }

  packet(p) {
    const pts = readPts(p);
    if (pts !== null) {
      if (this.firstPts === null) this.firstPts = pts;
      if (this.maxPts === null || pts > this.maxPts) this.maxPts = pts;
      if (this.spanStart === null) this.spanStart = this.maxPts;
    }
    this.parts.push(p);
    this.size += PACKET;
    const span = this.spanStart === null ? 0 : this.maxPts - this.spanStart;
    if (this.size >= this.maxBytes || span >= this.maxSpan) this.flush();
  }

  flush() {
    if (!this.size) return;
    const data = Buffer.concat(this.parts, this.size);
    this.parts = [];
    this.size = 0;
    this.spanStart = this.maxPts;
    this.onChunk(this.maxPts ?? this.firstPts ?? 0, data);
  }
}
