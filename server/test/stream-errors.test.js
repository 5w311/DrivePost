import test from 'node:test';
import assert from 'node:assert/strict';
import { failureReason } from '../src/stream.js';

// A media link as ffmpeg prints it: long, and with the server's own address in it.
const LINK =
  'https://rr5---sn-abcdefgh.googlevideo.com/videoplayback?expire=1794445561&ei=abcdefghij&ip=203.0.113.7&id=o-ABCDEFGHIJKLMNOP&itag=137&source=youtube&requiressl=yes&sig=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function clean(r) {
  assert.ok(!/googlevideo\.com\/|203\.0\.113\.7|videoplayback/.test(r.said + r.raw), `no link or address: ${JSON.stringify(r)}`);
  assert.ok(r.said.length <= 160);
  return r;
}

test('the reason a video would not start is shown, not its link', () => {
  // What the car used to show was the first 160 characters of this line: all link, no reason.
  const refused = clean(failureReason(`[https @ 0x55d0] HTTP error 403 Forbidden\n${LINK}: Server returned 403 Forbidden (access denied)\n`, 1));
  assert.equal(refused.said, 'YouTube refused to send it (403 Forbidden)');
  assert.equal(refused.raw, 'Server returned 403 Forbidden (access denied)');

  // Newer ffmpeg words it differently and puts the link on its own line.
  const newer = clean(failureReason(`[in#0 @ 0x1] Error opening input: Server returned 403 Forbidden (access denied)\nError opening input file ${LINK}.\nError opening input files: Server returned 403 Forbidden (access denied)\n`, 1));
  assert.equal(newer.said, 'YouTube refused to send it (403 Forbidden)');
});

test('other failures are told apart', () => {
  const busy = clean(failureReason(`[https @ 0x1] HTTP error 429 Too Many Requests\n${LINK}: Server returned 4XX Client Error, but not one of 40{0,1,3,4}\n`, 1));
  assert.match(busy.said, /429 Too Many Requests/);
  assert.match(clean(failureReason(`[https @ 0x1] HTTP error 404 Not Found\n${LINK}: Server returned 404 Not Found\n`, 1)).said, /stopped working \(404\)/);
  assert.match(clean(failureReason(`[https @ 0x1] HTTP error 503 Service Unavailable\n${LINK}: Server returned 5XX Server Error reply\n`, 1)).said, /YouTube's server had a problem \(503\)/);
  assert.match(clean(failureReason(`${LINK}: Connection timed out\n`, 1)).said, /couldn't reach YouTube \(Connection timed out\)/);
  assert.match(clean(failureReason(`[tcp @ 0x1] Failed to resolve hostname rr5---sn-abcdefgh.googlevideo.com: Temporary failure in name resolution\n${LINK}: Input/output error\n`, 1)).said, /couldn't reach YouTube/);
  assert.equal(clean(failureReason(`${LINK}: Invalid data found when processing input\n`, 1)).said, 'Invalid data found when processing input');
  assert.equal(failureReason('', 137).said, 'ffmpeg exited with 137');
  assert.equal(failureReason(undefined, 1).said, 'ffmpeg exited with 1');
});
