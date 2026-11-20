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

test('request editor: headed sections, an "+ Add to this request" menu with keyboard support, "Wait after" below', () => {
  assert.doesNotMatch(reqCard, /role', 'tab(list|panel)?'/, 'no tabs left');
  assert.match(reqCard, /heading = document\.createElement\('h3'\)/, 'every section has a heading');
  assert.match(reqCard, /sectionShell\('headers', 'Headers'/);
  assert.match(reqCard, /sectionShell\('body', 'Body'/);
  for (const id of ['assertions', 'extractions', 'exports', 'statuses', 'outcomes', 'scripts']) {
    assert.match(reqCard, new RegExp(`id: '${id}', title: '`), `${id} can be added from the menu`);
  }
  assert.match(reqCard, /setAttribute\('role', 'menu'\)/);
  assert.match(reqCard, /setAttribute\('role', 'menuitem'\)/);
  assert.match(reqCard, /initMenuButton\(toggle, menu, \{ closeOnOutsideClick: false \}\)/, 'one shared outside-click listener');
  assert.match(reqCard, /\.req-add-menu:not\(\[hidden\]\)/);
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape']) assert.match(menuButton, new RegExp(key));
  assert.match(reqCard, /setAttribute\('aria-label', `Remove "\$\{title\}" from this request`\)/);
  assert.match(reqCard, /window\.confirm\(`Remove "\$\{definition\.title\}" from this request\?/, 'removing a part that holds something asks first');
  assert.match(reqCard, /sleep\.className = 'sleep'/);
  assert.match(reqCard, /waitLabel\.append\('Wait after ', sleep, unit\);\n {2}wait\.append\(waitLabel, helpButton\('pause'\)\);/, 'help beside the label, not inside');
});

test('request duplication retains its fresh ID; the editor has no Before/After sub-requests', () => {
  assert.doesNotMatch(reqCard, /clone\.dataset\.requestId\s*=\s*''/);
  assert.doesNotMatch(reqCard, /subreq|subRequests/);
});
