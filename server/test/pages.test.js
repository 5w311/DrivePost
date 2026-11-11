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
