#!/usr/bin/env node
/*
 * Builds the "Send to Car" iPhone Shortcut that DriveTest hands out from its
 * Setup page (server/public/send-to-car.shortcut).
 *
 * The Shortcut is the same for everyone and holds nothing personal: when
 * someone adds it, their iPhone asks for their own DriveTest link and puts it
 * in. What it does:
 *
 *   1. takes whatever was shared (a link or text) from the share sheet,
 *   2. sends it to the DriveTest link as {"url": "..."},
 *   3. shows the server's answer ("Added to Up Next: ...") as a notification.
 *
 * iPhones only open Shortcut files that carry Apple's signature. This script
 * gets one of two ways:
 *
 *   node scripts/make-shortcut.mjs                write the unsigned file only
 *   node scripts/make-shortcut.mjs --sign         sign it: on a Mac with the
 *                                                 built-in `shortcuts` tool,
 *                                                 anywhere else online
 *   node scripts/make-shortcut.mjs --sign=online  sign it with Shortcuty's free
 *                                                 public signing service
 *                                                 (https://sign.shortcuty.app)
 *   node scripts/make-shortcut.mjs --sign=mac     sign it on this Mac (needs to
 *                                                 be signed in to iCloud)
 *
 * Signing online uploads the unsigned Shortcut, which is fine because there
 * is nothing personal in it. The signed file goes to
 * server/public/send-to-car.shortcut, and the Setup page then offers it as a
 * download. Without that file, the Setup page shows how to make the Shortcut
 * by hand.
 *
 * You only need to run this if you change the Shortcut. The signed file is
 * already in the repository.
 */
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SHORTCUT_NAME = 'Send to Car';
export const QUESTION = 'Paste your DriveTest link here. To copy it, open Setup & sharing in the DriveTest remote.';

const SIGN_URL = 'https://sign.shortcuty.app/api/v1/sign'; // documented at github.com/Shortcuty/Signing-Server-API-Documentation

const REQUEST_UUID = '6F2D5B0A-4C1E-4E57-9A53-0D5C6E1B7A11';
const VARIABLE = '\uFFFC'; // where a variable sits inside a piece of text

// A piece of text that is exactly one variable.
function variableText(attachment) {
  return {
    Value: { attachmentsByRange: { '{0, 1}': attachment }, string: VARIABLE },
    WFSerializationType: 'WFTextTokenString',
  };
}

function plainText(string) {
  return { Value: { string }, WFSerializationType: 'WFTextTokenString' };
}

// The Shortcut, as the plain data the Shortcuts app stores. Only actions that
// have existed unchanged since iOS 15 are used.
export function shortcutData() {
  return {
    WFWorkflowMinimumClientVersion: 900,
    WFWorkflowMinimumClientVersionString: '900',
    WFWorkflowClientVersion: '2106.0.3',
    WFWorkflowIcon: { WFWorkflowIconStartColor: 463140863, WFWorkflowIconGlyphNumber: 59452 }, // blue, car
    // Shows in the share sheet and accepts links and text.
    WFWorkflowTypes: ['ActionExtension'],
    WFWorkflowInputContentItemClasses: ['WFURLContentItem', 'WFStringContentItem'],
    WFWorkflowOutputContentItemClasses: [],
    WFQuickActionSurfaces: [],
    WFWorkflowHasShortcutInputVariables: true,
    WFWorkflowHasOutputFallback: false,
    // Run from the Shortcuts app instead of the share sheet: use the copied link.
    WFWorkflowNoInputBehavior: { Name: 'WFWorkflowNoInputBehaviorGetClipboard', Parameters: {} },
    // Asked once, when the Shortcut is added.
    WFWorkflowImportQuestions: [
      { ActionIndex: 1, Category: 'Parameter', ParameterKey: 'WFURL', DefaultValue: '', Text: QUESTION },
    ],
    WFWorkflowActions: [
      {
        WFWorkflowActionIdentifier: 'is.workflow.actions.comment',
        WFWorkflowActionParameters: {
          WFCommentActionText:
            'Sends what you share to your DriveTest server, which plays it in the car or adds it to Up Next.\n\n' +
            'The address below is your personal DriveTest link. If you make a new share token, copy the new link ' +
            'from Setup & sharing in the DriveTest remote and paste it over the old one.',
        },
      },
      {
        WFWorkflowActionIdentifier: 'is.workflow.actions.downloadurl',
        WFWorkflowActionParameters: {
          UUID: REQUEST_UUID,
          WFURL: '',
          WFHTTPMethod: 'POST',
          WFHTTPBodyType: 'JSON',
          ShowHeaders: false,
          WFJSONValues: {
            Value: {
              WFDictionaryFieldValueItems: [
                { WFItemType: 0, WFKey: plainText('url'), WFValue: variableText({ Type: 'ExtensionInput' }) },
              ],
            },
            WFSerializationType: 'WFDictionaryFieldValue',
          },
        },
      },
      {
        WFWorkflowActionIdentifier: 'is.workflow.actions.notification',
        WFWorkflowActionParameters: {
          WFNotificationActionTitle: 'DriveTest',
          WFNotificationActionBody: variableText({
            Type: 'ActionOutput',
            OutputName: 'Contents of URL',
            OutputUUID: REQUEST_UUID,
          }),
          WFNotificationActionSound: false,
        },
      },
    ],
  };
}

// ---- writing it as a property list (the XML kind) ----

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function node(value, indent) {
  const pad = '\t'.repeat(indent);
  if (typeof value === 'string') return `${pad}<string>${escapeXml(value)}</string>\n`;
  if (typeof value === 'boolean') return `${pad}<${value}/>\n`;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error('Only whole numbers are used here');
    return `${pad}<integer>${value}</integer>\n`;
  }
  if (Array.isArray(value)) {
    if (!value.length) return `${pad}<array/>\n`;
    return `${pad}<array>\n${value.map((v) => node(v, indent + 1)).join('')}${pad}</array>\n`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    if (!keys.length) return `${pad}<dict/>\n`;
    const body = keys.map((k) => `${pad}\t<key>${escapeXml(k)}</key>\n${node(value[k], indent + 1)}`).join('');
    return `${pad}<dict>\n${body}${pad}</dict>\n`;
  }
  throw new Error(`Can't write ${value} to a property list`);
}

export function toPlist(data) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n' +
    node(data, 0) +
    '</plist>\n'
  );
}

export function shortcutPlist() {
  return toPlist(shortcutData());
}

// A signed Shortcut is an Apple archive, which starts with these four letters.
export function looksSigned(buf) {
  return buf.length > 4 && buf.subarray(0, 4).toString('latin1') === 'AEA1';
}

// ---- signing ----

function signOnMac(plist) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drivetest-shortcut-'));
  const input = path.join(dir, `${SHORTCUT_NAME}.unsigned.shortcut`);
  const output = path.join(dir, `${SHORTCUT_NAME}.shortcut`);
  try {
    fs.writeFileSync(input, plist);
    execFileSync('shortcuts', ['sign', '--mode', 'anyone', '--input', input, '--output', output], { stdio: 'inherit' });
    return fs.readFileSync(output);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Shortcuty's public signing service: upload the unsigned file, get it back
// signed so that anyone can add it.
async function signOnline(plist) {
  const bytes = Buffer.from(plist, 'utf8');
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'application/octet-stream' }), `${SHORTCUT_NAME}.shortcut`);
  const res = await fetch(SIGN_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(180000) });
  const body = Buffer.from(await res.arrayBuffer());
  if (!res.ok) throw new Error(`The signing service answered ${res.status}: ${body.toString('utf8').slice(0, 300)}`);
  // The service says which bytes it signed; make sure they were ours.
  const sent = crypto.createHash('sha256').update(bytes).digest('hex');
  const signedInput = res.headers.get('x-shortcut-input-sha256');
  if (signedInput && signedInput.toLowerCase() !== sent) throw new Error('The signing service signed something other than what was sent.');
  const mode = res.headers.get('x-shortcut-signing-mode');
  if (mode && mode !== 'anyone') throw new Error(`Signed for "${mode}", but it has to be for anyone.`);
  return body;
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const unsignedFile = path.join(root, 'shortcut', 'send-to-car.unsigned.plist');
  const signedFile = path.join(root, 'server', 'public', 'send-to-car.shortcut');
  const arg = process.argv.slice(2).find((x) => x === '--sign' || x.startsWith('--sign='));
  const how = !arg ? null : arg === '--sign' ? (process.platform === 'darwin' ? 'mac' : 'online') : arg.slice('--sign='.length);

  const plist = shortcutPlist();
  fs.mkdirSync(path.dirname(unsignedFile), { recursive: true });
  fs.writeFileSync(unsignedFile, plist);
  console.log(`Wrote ${path.relative(root, unsignedFile)} (unsigned, for reading and reviewing)`);
  if (!how) {
    console.log('Not signed. iPhones only open signed Shortcuts: run again with --sign.');
    return;
  }
  if (how !== 'mac' && how !== 'online') throw new Error(`Unknown way to sign: ${how} (use mac or online)`);
  if (how === 'mac' && process.platform !== 'darwin') throw new Error('--sign=mac only works on a Mac. Use --sign=online instead.');
  const signed = how === 'mac' ? signOnMac(plist) : await signOnline(plist);
  if (!looksSigned(signed)) throw new Error("What came back isn't a signed Shortcut.");
  fs.writeFileSync(signedFile, signed);
  console.log(`Wrote ${path.relative(root, signedFile)} (${signed.length} bytes, signed ${how === 'mac' ? 'on this Mac' : 'by sign.shortcuty.app'})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
