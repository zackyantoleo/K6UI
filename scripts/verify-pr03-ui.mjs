import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const baseURL = process.env.K6UI_URL || 'http://127.0.0.1:43871';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
const consoleErrors = [];
const pageErrors = [];
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('pageerror', error => pageErrors.push(error.message));

await page.goto(baseURL, { waitUntil: 'networkidle' });
await page.locator('#empty-add-request').click();
let cards = page.locator('.req-card');
await assertCount(cards, 1);
await fillCard(cards.nth(0), 'Login', 'https://example.test/login');

await page.getByRole('button', { name: 'Add request' }).click();
await assertCount(cards, 2);
await fillCard(cards.nth(1), 'Disabled', 'https://disabled.example.test');
await cards.nth(1).locator('.request-enabled').uncheck();
assert.equal(await page.locator('.req-card.expanded').count(), 1, 'one-at-a-time editor expansion');

await page.locator('.keep-request-editors-open').check();
await cards.nth(0).locator('.request-expand').click();
assert.equal(await page.locator('.req-card.expanded').count(), 2, 'keep-open override');
await page.locator('.keep-request-editors-open').uncheck();
assert.equal(await page.locator('.req-card.expanded').count(), 1, 'disabling keep-open restores accordion mode');

const loginIndex = await cards.locator('.request-name').evaluateAll(nodes => nodes.findIndex(node => node.value === 'Login'));
assert.notEqual(loginIndex, -1, 'Login request exists');
const login = cards.nth(loginIndex);
await login.locator('.req-action-btn.curl').click();
await page.locator('#curl-input').fill("curl -X POST 'https://example.test/login' -H 'Content-Type: application/json' -d '{\"ok\":true}'");
await page.locator('#curl-apply').click();
assert.equal(await login.locator('.body').inputValue(), '{"ok":true}', 'cURL import hydrates lazy body');
assert.equal(await login.locator('.headers-list .header-row').count(), 1, 'cURL import hydrates lazy headers');
if (await login.locator('.req-card-body').isHidden()) await login.locator('.request-expand').click();
await login.locator('.subreq-pre .add-subreq-btn').click();
await login.locator('.subreq-pre .sr-url').fill('https://example.test/setup');
await login.locator('.subreq-pre .subreq-expand').click();
await login.locator('.subreq-pre .sr-body').fill('{"setup":true}');
const headersTab = login.getByRole('tab', { name: 'Headers settings' });
await headersTab.focus();
await headersTab.press('ArrowRight');
assert.equal(await login.getByRole('tab', { name: 'Body settings' }).getAttribute('aria-selected'), 'true', 'ArrowRight selects next tab');
await login.getByRole('tab', { name: 'Body settings' }).press('ArrowLeft');
assert.equal(await headersTab.getAttribute('aria-selected'), 'true', 'ArrowLeft selects previous tab');
await login.getByRole('button', { name: 'Add header' }).click();
await login.locator('.header-row').last().locator('.h-key').fill('X-Test');
await login.locator('.header-row').last().locator('.h-val').fill('safe');
await login.getByRole('tab', { name: 'Body settings' }).click();
await login.getByRole('tab', { name: 'Checks settings' }).click();
await login.getByRole('button', { name: '+ Add Assertion', exact: true }).click();
const originalId = await login.getAttribute('data-request-id');
await login.getByRole('button', { name: /Duplicate request/ }).click();
await assertCount(cards, 3);
const duplicate = cards.nth(loginIndex + 1);
const copyId = await duplicate.getAttribute('data-request-id');
assert.ok(copyId && copyId !== originalId, 'duplicate receives a fresh persistent ID');
assert.equal(await duplicate.locator('.subreq-pre .sr-url').inputValue(), 'https://example.test/setup', 'duplicate preserves before request');
assert.equal(await duplicate.locator('.subreq-pre .sr-body').inputValue(), '{"setup":true}', 'duplicate preserves before body');
await duplicate.locator('.request-name').fill('Login copy');
await duplicate.getByRole('button', { name: /Move request .* up/ }).click();

const ids = await cards.evaluateAll(nodes => nodes.map(node => node.dataset.requestId));
assert.equal(new Set(ids).size, 3, 'request IDs stay unique after duplicate');
const names = await cards.locator('.request-name').evaluateAll(nodes => nodes.map(node => node.value));
assert.deepEqual(names, ['Login copy', 'Login', 'Disabled']);
assert.equal(await cards.nth(2).locator('.request-enabled').isChecked(), false);

const downloadPromise = page.waitForEvent('download');
await page.locator('#save-project-btn').click();
const download = await downloadPromise;
const stream = await download.createReadStream();
let projectText = '';
for await (const chunk of stream) projectText += chunk;
const project = JSON.parse(projectText);
assert.deepEqual(project.scenario.requests.map(request => request.name), names);
assert.equal(project.scenario.requests[2].enabled, false);
assert.equal(new Set(project.scenario.requests.map(request => request.id)).size, 3);
assert.deepEqual(project.scenario.requests[0].headers.map(header => header.key), ['Content-Type', 'X-Test']);
assert.equal(project.scenario.requests[0].body, '{"ok":true}');

await page.locator('#preview-btn').click();
await page.locator('#script-preview').waitFor({ state: 'visible' });
const code = await page.locator('#script-preview').textContent();
assert.match(code, /example\.test\/login/);
assert.doesNotMatch(code, /disabled\.example\.test/);

assert.deepEqual(consoleErrors, []);
assert.deepEqual(pageErrors, []);
console.log(JSON.stringify({
  cards: 3,
  order: names,
  uniqueIds: new Set(ids).size,
  disabledExcludedFromGenerator: true,
  headersBodyChecksPreserved: true,
  consoleErrors,
  pageErrors,
}, null, 2));
await browser.close();

async function fillCard(card, name, url) {
  await card.locator('.request-name').fill(name);
  await card.locator('.url').fill(url);
}
async function assertCount(locator, expected) {
  assert.equal(await locator.count(), expected);
}
