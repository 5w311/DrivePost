/*
 * What the browser's own media controls say of the video a page is playing:
 * playing or paused, how far in, how long. These are the controls a
 * keyboard's play key and a desktop's media buttons use (MPRIS), asked with
 * dbus-send; nothing here looks into a page.
 */

// The answer to "tell me everything" (Properties.GetAll), read. null if it isn't one.
export function readPlayer(text, at = Date.now()) {
  const s = String(text || '');
  const status = (/string "PlaybackStatus"\s+variant\s+string "(\w+)"/.exec(s) || [])[1];
  if (!status) return null;
  const num = (re) => {
    const m = re.exec(s);
    return m ? Number(m[1]) : null;
  };
  const pos = num(/string "Position"\s+variant\s+int64 (-?\d+)/); // millionths of a second
  const len = num(/string "mpris:length"\s+variant\s+int64 (\d+)/);
  const rate = num(/string "Rate"\s+variant\s+double ([\d.eE+-]+)/);
  return {
    // (Stopped: the controls are there with nothing in them to play.)
    status: status === 'Playing' ? 'playing' : status === 'Paused' ? 'paused' : 'stopped',
    t: pos !== null && pos >= 0 ? pos / 1e6 : null,
    // A live broadcast has no length, or an absurd one.
    d: len !== null && len > 0 && len < 48 * 3600 * 1e6 ? len / 1e6 : null,
    rate: rate !== null && rate > 0 ? rate : 1,
    seek: /string "CanSeek"\s+variant\s+boolean true/.test(s),
    at,
  };
}

// Where a video that was as `m` says is by `now`, if nothing but time has passed.
export function expected(m, now = Date.now()) {
  if (!m || m.t === null) return null;
  return m.t + (m.status === 'playing' ? ((now - m.at) / 1000) * m.rate : 0);
}

// Is `next` news to someone who was told `prev`? Time passing on a playing video isn't.
export function isNews(prev, next) {
  if (!prev || !next) return !!prev !== !!next;
  if (prev.status !== next.status || prev.seek !== next.seek || prev.rate !== next.rate) return true;
  if ((prev.d === null) !== (next.d === null) || (prev.d !== null && Math.abs(prev.d - next.d) > 0.5)) return true;
  const e = expected(prev, next.at);
  if ((e === null) !== (next.t === null)) return true;
  return e !== null && Math.abs(e - next.t) > 0.75; // a skip, or another video
}
