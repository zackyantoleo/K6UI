import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const curlImport = read('../public/js/curl-import.js');
const body = read('../public/js/components/request-editor/body.js');
const scripts = read('../public/js/components/request-editor/scripts.js');
const reqCard = read('../public/js/components/req-card.js');

test('cURL import materializes lazy Headers and Body panels before hydration', () => {
  assert.match(curlImport, /card\.ensureRequestPanel\?\.\('headers'\)/);
  assert.match(curlImport, /card\.ensureRequestPanel\?\.\('body'\)/);
});

test('request body and script editors expose programmatic labels', () => {
  assert.match(body, /setAttribute\('aria-label', 'Request body'\)/);
  assert.match(scripts, /setAttribute\('aria-label', 'Pre-request processor script'\)/);
  assert.match(scripts, /setAttribute\('aria-label', 'Post-request processor script'\)/);
});

test('lazy request tabs implement linked tabpanels and keyboard navigation', () => {
  assert.match(reqCard, /role', 'tabpanel'/);
  assert.match(reqCard, /aria-controls/);
  assert.match(reqCard, /ArrowRight/);
  assert.match(reqCard, /ArrowLeft/);
  assert.match(reqCard, /Home/);
  assert.match(reqCard, /End/);
});

test('request duplication retains its fresh ID and includes before/after request data', () => {
  assert.doesNotMatch(reqCard, /clone\.dataset\.requestId\s*=\s*''/);
  assert.match(reqCard, /snapshot\.subRequests/);
  assert.match(reqCard, /applySubRequestSnapshot\(card, 'pre'/);
  assert.match(reqCard, /applySubRequestSnapshot\(card, 'post'/);
});
