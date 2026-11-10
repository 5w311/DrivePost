// Splits ffmpeg's MPEG-TS output into separate video and audio chunks, each
// tagged with its presentation time. The car buffers them and feeds its
// decoder at exactly the right moment: one video frame per chunk, so every
// frame can be shown on time, and audio in short runs so it can be scheduled
// to match the picture.

const PACKET = 188;
export const KIND_VIDEO = 0;
export const KIND_AUDIO = 1;

// If this TS packet starts a video or audio PES packet, returns its kind and
// presentation timestamp in seconds (pts may be null). Otherwise null.
export function readPes(p) {
  if (p[0] !== 0x47 || !(p[1] & 0x40)) return null; // needs payload-unit-start
  const afc = (p[3] >> 4) & 3;
  if (!(afc & 1)) return null; // no payload
  let i = 4;
  if (afc & 2) i += 1 + p[4]; // skip adaptation field
  if (i + 14 > PACKET) return null;
  if (p[i] !== 0 || p[i + 1] !== 0 || p[i + 2] !== 1) return null;
  const streamId = p[i + 3];
  let kind;
  if (streamId >= 0xe0 && streamId <= 0xef) kind = KIND_VIDEO;
  else if (streamId >= 0xc0 && streamId <= 0xdf) kind = KIND_AUDIO;
  else return null;
  if (!((p[i + 7] >> 6) & 2)) return { kind, pts: null };
  const b = i + 9;
  const pts =
    ((p[b] >> 1) & 0x07) * 1073741824 +
    p[b + 1] * 4194304 +
    (p[b + 2] >> 1) * 32768 +
    p[b + 3] * 128 +
    (p[b + 4] >> 1);
  return { kind, pts: pts / 90000 };
}

export function readPts(p) {
  const pes = readPes(p);
  return pes ? pes.pts : null;
}

export class TsSplitter {
  // onChunk(kind, pts, buffer)
  //   video: exactly one frame (one PES packet); pts is that frame's time.
  //   audio: up to `audioSpan` seconds of whole audio frames; pts is the
  //          time of the first one.
  // `prefix` reserves that many bytes at the start of each buffer for the
  // caller's own header, which saves a second copy.
  constructor(onChunk, { audioSpan = 0.1, prefix = 0 } = {}) {
    this.onChunk = onChunk;
    this.audioSpan = audioSpan;
    this.prefix = prefix;
    this.leftover = null;
    this.pidKind = new Map();
    this.v = { parts: [], size: 0, pts: null };
    this.a = { parts: [], size: 0, pts: null };
    this.firstVideoPts = null;
    this.lastVideoPts = null;
    this.videoFrames = 0;
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
    const pid = ((p[1] & 0x1f) << 8) | p[2];
    const pes = readPes(p);
    if (pes) this.pidKind.set(pid, pes.kind);
    const kind = this.pidKind.get(pid);
    if (kind === undefined) return; // program tables and padding: the player doesn't need them

    if (kind === KIND_VIDEO) {
      if (pes) {
        this.flushVideo();
        this.v.pts = pes.pts ?? this.lastVideoPts ?? 0;
        if (this.firstVideoPts === null) this.firstVideoPts = this.v.pts;
        this.lastVideoPts = this.v.pts;
        this.videoFrames++;
      }
      if (this.v.pts === null) return; // mid-frame data before the first frame start
      this.v.parts.push(p);
      this.v.size += PACKET;
    } else {
      if (pes) {
        const pts = pes.pts ?? this.a.pts ?? 0;
        if (this.a.size && pts - this.a.pts >= this.audioSpan) this.flushAudio();
        if (!this.a.size) this.a.pts = pts;
      }
      if (this.a.pts === null) return;
      this.a.parts.push(p);
      this.a.size += PACKET;
    }
  }

  emit(kind, c) {
    if (!c.size) return;
    const data = Buffer.allocUnsafe(this.prefix + c.size);
    let o = this.prefix;
    for (const part of c.parts) {
      part.copy(data, o);
      o += PACKET;
    }
    c.parts = [];
    c.size = 0;
    this.onChunk(kind, c.pts, data);
  }

  flushVideo() {
    this.emit(KIND_VIDEO, this.v);
  }

  flushAudio() {
    this.emit(KIND_AUDIO, this.a);
  }

  flush() {
    this.flushVideo();
    this.flushAudio();
  }
}
