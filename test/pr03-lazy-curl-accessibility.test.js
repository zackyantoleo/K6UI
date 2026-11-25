import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const curlImport = read('../public/js/curl-import.js');
const body = read('../public/js/components/request-editor/body.js');
const scripts = read('../public/js/components/request-editor/scripts.js');
const reqCard = read('../public/js/components/req-card.js');
const menuButton = read('../public/js/components/menu-button.js');

test('cURL import materializes lazy Headers and Body panels before hydration', () => {
  assert.match(curlImport, /card\.ensureRequestPanel\?\.\('headers'\)/);
  assert.match(curlImport, /card\.ensureRequestPanel\?\.\('body'\)/);
});

test('request body and script editors expose programmatic labels', () => {
  assert.match(body, /setAttribute\('aria-label', 'Request body'\)/);
  assert.match(scripts, /setAttribute\('aria-label', 'Pre-request processor script'\)/);
  assert.match(scripts, /setAttribute\('aria-label', 'Post-request processor script'\)/);
});

test('request editor: Postman-style tabs with keyboard support, "Wait after" in Settings', () => {
  assert.match(reqCard, /setAttribute\('role', 'tablist'\)/);
  assert.match(reqCard, /setAttribute\('role', 'tab'\)/);
  assert.match(reqCard, /setAttribute\('role', 'tabpanel'\)/);
  assert.match(reqCard, /setAttribute\('aria-controls', `\$\{idBase\}-panel`\)/);
  assert.match(reqCard, /setAttribute\('aria-labelledby', `\$\{idBase\}-tab`\)/);
  for (const [id, label] of [['headers', 'Headers'], ['body', 'Body'], ['checks', 'Checks'], ['extractions', 'Extract'],
    ['exports', 'Save CSV'], ['outcomes', 'Outcomes'], ['scripts', 'Scripts'], ['settings', 'Settings']]) {
    assert.match(reqCard, new RegExp(`id: '${id}', label: '${label}'`), `${id} has a tab`);
  }
  assert.doesNotMatch(reqCard, /label: 'Statuses'/, 'success statuses live in the Checks tab');
  assert.match(reqCard, /\{ id: 'statuses', title: 'Success statuses'/);
  assert.match(reqCard, /\{ id: 'assertions', title: 'Response checks'/);
  for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) assert.match(reqCard, new RegExp(key));
  assert.match(reqCard, /tab\.tabIndex = active \? 0 : -1/, 'roving tabindex');
  assert.doesNotMatch(reqCard, /req-add-menu|role', 'menuitem'/, 'no "+ Add to this request" menu left');
  assert.match(reqCard, /sleep\.className = 'sleep'/);
  assert.match(reqCard, /panels\.querySelector\('\.req-panel\[data-panel="settings"\]'\)\.appendChild\(settings\)/);
});

test('request duplication retains its fresh ID; the editor has no Before/After sub-requests', () => {
  assert.doesNotMatch(reqCard, /clone\.dataset\.requestId\s*=\s*''/);
  assert.doesNotMatch(reqCard, /subreq|subRequests/);
});
