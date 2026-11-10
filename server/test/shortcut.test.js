import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shortcutData, shortcutPlist, toPlist, looksSigned, QUESTION } from '../../scripts/make-shortcut.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('the Shortcut shows in the share sheet and takes links and text', () => {
  const s = shortcutData();
  assert.deepEqual(s.WFWorkflowTypes, ['ActionExtension']);
  assert.deepEqual(s.WFWorkflowInputContentItemClasses, ['WFURLContentItem', 'WFStringContentItem']);
  assert.equal(s.WFWorkflowHasShortcutInputVariables, true);
});

test('it posts what was shared as {"url": ...} and shows the answer', () => {
  const [, request, notify] = shortcutData().WFWorkflowActions;
  assert.equal(request.WFWorkflowActionIdentifier, 'is.workflow.actions.downloadurl');
  const p = request.WFWorkflowActionParameters;
  assert.equal(p.WFHTTPMethod, 'POST');
  assert.equal(p.WFHTTPBodyType, 'JSON');
  const fields = p.WFJSONValues.Value.WFDictionaryFieldValueItems;
  assert.equal(fields.length, 1);
  assert.equal(fields[0].WFKey.Value.string, 'url');
  assert.deepEqual(fields[0].WFValue.Value.attachmentsByRange, { '{0, 1}': { Type: 'ExtensionInput' } });

  assert.equal(notify.WFWorkflowActionIdentifier, 'is.workflow.actions.notification');
  const shown = notify.WFWorkflowActionParameters.WFNotificationActionBody.Value.attachmentsByRange['{0, 1}'];
  assert.equal(shown.Type, 'ActionOutput');
  assert.equal(shown.OutputUUID, p.UUID); // the notification shows what the request returned
});

test('the phone asks for the personal link when the Shortcut is added', () => {
  const s = shortcutData();
  assert.equal(s.WFWorkflowImportQuestions.length, 1);
  const q = s.WFWorkflowImportQuestions[0];
  assert.equal(q.Text, QUESTION);
  assert.equal(q.Category, 'Parameter');
  // The question fills in the address of the request.
  const target = s.WFWorkflowActions[q.ActionIndex];
  assert.equal(target.WFWorkflowActionIdentifier, 'is.workflow.actions.downloadurl');
  assert.equal(q.ParameterKey, 'WFURL');
  assert.equal(target.WFWorkflowActionParameters.WFURL, '');
});

test('nothing personal is built in: no address, no token', () => {
  const plist = shortcutPlist();
  assert.doesNotMatch(plist, /https?:\/\/(?!www\.apple\.com\/DTDs)/);
  assert.doesNotMatch(plist, /key=|Bearer|Authorization/);
});

test('property lists are written correctly', () => {
  const xml = toPlist({ b: true, a: 'x & <y>', n: 3, list: ['one', { k: false }], none: [], empty: {} });
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<!DOCTYPE plist /);
  assert.ok(xml.includes('<key>a</key>\n\t<string>x &amp; &lt;y&gt;</string>'));
  assert.ok(xml.includes('<key>b</key>\n\t<true/>'));
  assert.ok(xml.includes('<key>n</key>\n\t<integer>3</integer>'));
  assert.ok(xml.includes('<key>none</key>\n\t<array/>'));
  assert.ok(xml.includes('<key>empty</key>\n\t<dict/>'));
  assert.ok(xml.includes('<array>\n\t\t<string>one</string>\n\t\t<dict>\n\t\t\t<key>k</key>\n\t\t\t<false/>'));
  assert.ok(xml.indexOf('<key>a</key>') < xml.indexOf('<key>b</key>')); // keys in order
  assert.throws(() => toPlist({ x: 1.5 }));
});

test('the unsigned copy in the repository matches what the script makes', () => {
  const saved = fs.readFileSync(path.join(root, 'shortcut', 'send-to-car.unsigned.plist'), 'utf8');
  assert.equal(saved, shortcutPlist(), 'run: node scripts/make-shortcut.mjs');
});

test('a signed Shortcut is told apart from an unsigned one', () => {
  assert.equal(looksSigned(Buffer.from('AEA1\0\0\0\0rest')), true);
  assert.equal(looksSigned(Buffer.from(shortcutPlist())), false);
  assert.equal(looksSigned(Buffer.from('AEA')), false);
});

test('a signed Shortcut shipped with the app really is signed', () => {
  const file = path.join(root, 'server', 'public', 'send-to-car.shortcut');
  if (!fs.existsSync(file)) return; // not shipped: the Setup page shows the by-hand steps
  assert.equal(looksSigned(fs.readFileSync(file)), true);
});
