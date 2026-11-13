/*
 * Blocking ads in the pages the server's browser opens.
 *
 * It works the way a Pi-hole does for a home network. There is a list of
 * the names of the machines that serve ads and trackers, and whatever a
 * page asks for from one of them is refused at the door the browser
 * fetches everything through (guard.js). The page gets the rest.
 *
 * What it can't do: ads that come from the same machines as the programme
 * itself. Most free television splices its breaks into the stream, and no
 * list can tell those from the show.
 *
 * The list is a public one in the format of a hosts file (by default the
 * one Pi-hole starts with, StevenBlack/hosts). This server fetches it the
 * first time blocking is switched on, keeps a copy with its data, and
 * fetches it again once a week. It is off for every profile until someone
 * switches it on from their phone's Page card.
 */
import fs from 'node:fs';
import { config } from './config.js';

const REFRESH_MS = 7 * 24 * 3600 * 1000; // a copy older than this is fetched again
const RETRY_MS = 30 * 60 * 1000; // after a fetch that failed
const MAX_BYTES = 40 * 1024 * 1024;
const TOO_FEW = 50; // fewer names than this isn't a block list, it is a mistake

let names = new Set();
let state = 'none'; // none (never asked for) | loading | ready | failed
let listedAt = 0; // when the list in use was fetched
let triedAt = 0;
let loading = null;

const ADDRESS = /^(\d{1,3}(\.\d{1,3}){3}|[0-9a-f:]+(%\w+)?)$/i;
const OWN = /(^|\.)(localhost|localdomain|local|lan|internal)$/; // names for this machine or its own network
const NAME = /^(?=.{4,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/*
 * Read a list: a hosts file ("0.0.0.0 ads.example.com"), or one name a line.
 * Comments, blank lines, and the names every hosts file has for the machine
 * it is on (localhost and the like, which have no dot in them) are passed over.
 */
export function parseList(text) {
  const found = new Set();
  for (const raw of String(text).split('\n')) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    let name = parts.length === 1 ? parts[0] : ADDRESS.test(parts[0]) ? parts[1] : '';
    name = name.toLowerCase().replace(/^\|\|/, '').replace(/\^$/, '').replace(/\.$/, '');
    if (NAME.test(name) && !OWN.test(name)) found.add(name);
  }
  return found;
}

// Is this machine's name on the list? (Nothing is, until the list is there.)
export function adListed(hostname) {
  if (state === 'none') useAdList();
  return names.has(String(hostname || '').toLowerCase().replace(/\.$/, ''));
}

// For the phone: how things stand with the list.
export function adList() {
  return { state, size: names.size };
}

// Make sure the list is here and not stale. Safe to call often.
export function useAdList(now = Date.now()) {
  if (loading) return loading;
  if (state === 'ready' && now - listedAt < REFRESH_MS) return Promise.resolve();
  if (triedAt && now - triedAt < RETRY_MS) return Promise.resolve();
  triedAt = now;
  if (state === 'none') state = 'loading';
  loading = load()
    .catch((err) => console.log(`[ads] the block list couldn't be fetched (${err.message})${names.size ? ': keeping the one from before' : ''}`))
    .finally(() => {
      loading = null;
      state = names.size ? 'ready' : 'failed';
    });
  return loading;
}

async function load() {
  const file = config.pages.blockListFile;
  // The copy kept from last time, if this is a fresh start.
  if (!names.size) {
    try {
      const kept = parseList(fs.readFileSync(file, 'utf8'));
      if (kept.size >= TOO_FEW) {
        names = kept;
        listedAt = fs.statSync(file).mtimeMs;
        state = 'ready';
      }
    } catch {}
  }
  if (names.size && Date.now() - listedAt < REFRESH_MS) return;
  const res = await fetch(config.pages.blockList, { signal: AbortSignal.timeout(60000), redirect: 'follow' });
  if (!res.ok) throw new Error(`the list's site answered ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error('the list is far too long');
  const fresh = parseList(text);
  if (fresh.size < TOO_FEW) throw new Error("what came back isn't a block list");
  names = fresh;
  listedAt = Date.now();
  console.log(`[ads] block list fetched: ${fresh.size} names`);
  try {
    fs.writeFileSync(`${file}.new`, text);
    fs.renameSync(`${file}.new`, file);
  } catch (err) {
    console.log(`[ads] the block list couldn't be kept for next time (${err.message})`);
  }
}

// For tests: start over.
export function forgetAdList() {
  names = new Set();
  state = 'none';
  listedAt = 0;
  triedAt = 0;
}
