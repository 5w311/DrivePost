import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stampPage } from '../src/pages.js';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

test('a page is stamped with its version and asks for its files by that version', () => {
  const html = '<!doctype html>\n<html lang="en">\n<head>\n<link rel="icon" href="/static/icon-192.png">\n' +
    '<link rel="stylesheet" href="/static/app.css">\n</head>\n<body>\n<script src="/static/common.js"></script>\n' +
    '<script src="/static/car.js"></script>\n<a href="/setup">Setup</a>\n</body>\n</html>\n';
  const out = stampPage(html, 'abc123');
  assert.ok(out.includes('<html data-version="abc123" lang="en">'));
  assert.ok(out.includes('href="/static/app.css?v=abc123"'));
  assert.ok(out.includes('src="/static/common.js?v=abc123"'));
  assert.ok(out.includes('src="/static/car.js?v=abc123"'));
  assert.ok(out.includes('href="/static/icon-192.png"'), 'pictures are left alone');
  assert.ok(out.includes('href="/setup"'), 'links to pages are left alone');
  assert.equal(out.match(/\?v=abc123/g).length, 3);
});

test('every real page gets a version and has no unversioned script or style left', () => {
  for (const name of fs.readdirSync(PUBLIC).filter((n) => n.endsWith('.html'))) {
    const out = stampPage(fs.readFileSync(path.join(PUBLIC, name), 'utf8'), 'v1');
    assert.match(out, /<html data-version="v1"/, name);
    assert.doesNotMatch(out, /(?:src|href)="\/static\/[^"?]+\.(?:js|css)"/, name);
  }
});

// ---- the Feedback link ----
import { feedbackLink } from '../src/pages.js';

const DETAILS = [
  'Browser: Chrome 148, H.264 yes, VP9 yes, AV1 no',
  'Window: 1180x919',
  'Quality: 1080p',
  'Format: H.264',
  'Picture: 1920x1080 25fps 4.1Mbps',
  'Decoding: 12 ready, 0 skipped',
  'Buffer: 6.8s, ran dry 0, fell behind 0',
  'Sound: running 48000Hz, realigned 0, skipped 0',
  'Server: 31x real time',
  'State: playing',
].join('\n');

test('the feedback link opens a new issue with the details filled in', () => {
  const link = feedbackLink('https://github.com/5w311/DrivePost/issues/new', DETAILS, 'abc123def456');
  const url = new URL(link);
  assert.equal(url.origin + url.pathname, 'https://github.com/5w311/DrivePost/issues/new');
  assert.equal(url.searchParams.get('title'), 'Feedback: ');
  const body = url.searchParams.get('body');
  assert.ok(body.startsWith('**What happened?**\n'), 'room to write comes first');
  for (const line of DETAILS.split('\n')) assert.ok(body.includes(`- ${line}\n`), line);
  assert.ok(body.includes('- Build: abc123def456\n'));
  assert.ok(link.length < 700, `short enough for an easy QR code (was ${link.length})`);
});

test('feedback details are cut down to plain, short lines', () => {
  const messy = 'Fine: yes\n\n  spaced  \nsymbols × · … é \u0007\n' + 'x'.repeat(500) + '\n' + Array(40).fill('extra').join('\n');
  const body = new URL(feedbackLink('https://example.com/new', messy, 'v')).searchParams.get('body');
  const lines = body.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(lines[0], '- Fine: yes');
  assert.equal(lines[1], '- spaced');
  assert.equal(lines[2], '- symbols');
  assert.equal(lines[3].length, 2 + 140, 'long lines are cut');
  assert.equal(lines.length, 13, '12 lines of details at most, plus the build');
  assert.equal(lines.at(-1), '- Build: v');
  assert.match(body, /^[\x20-\x7E\n]*$/, 'plain characters only');
});

test('special characters survive the trip through the link', () => {
  const body = new URL(feedbackLink('https://example.com/new?template=x', 'A&B=C+D #1 100%? "q"', 'v')).searchParams.get('body');
  assert.ok(body.includes('- A&B=C+D #1 100%? "q"\n'));
  assert.equal(new URL(feedbackLink('https://example.com/new?template=x', '', 'v')).searchParams.get('template'), 'x');
});
