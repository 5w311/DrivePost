/*
 * Writes the browser's policy file for uBlock Origin Lite.
 *
 *   node ublock-policy.js <the folder the extension is unpacked in> <the policy file to write>
 *
 * The extension is left at its author's settings but for one: its filtering
 * is set to "complete", which also tidies away the boxes ads would have sat
 * in on any site, as the original uBlock Origin does. (Its own default,
 * "optimal", does that only on sites its lists name.)
 *
 * A browser's policies name an extension by its ID, and for an extension
 * loaded from a folder the browser works the ID out from the folder's path:
 * the first half of the path's SHA-256, written with the letters a to p. So
 * the file has to be made for where the extension actually is.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function extensionId(dir) {
  const hex = crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

export function policyFor(dir) {
  return { '3rdparty': { extensions: { [extensionId(dir)]: { defaultFiltering: 'complete', disableFirstRunPage: true, showBlockedCount: false } } } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const [dir, file] = process.argv.slice(2);
  if (!dir || !file) {
    console.error('usage: node ublock-policy.js <extension folder> <policy file>');
    process.exit(2);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(policyFor(dir), null, 2)}\n`);
  console.log(`policy for the extension in ${path.resolve(dir)} (${extensionId(dir)}) written to ${file}`);
}
