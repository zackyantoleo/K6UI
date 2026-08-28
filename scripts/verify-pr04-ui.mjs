import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const baseURL = process.env.K6UI_URL || 'http://127.0.0.1:43873';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
const errors = [];
page.on('console', message => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`);
});
page.on('pageerror', error => errors.push(`page: ${error.message}`));

await page.goto(baseURL, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /Load Users and duration/ }).click();

const custom = page.locator('#load-custom-editor');
assert.equal(await custom.isHidden(), true, 'custom editor starts collapsed');

const inputValues = locator => locator.evaluateAll(inputs => inputs.map(input => input.value));

await page.evaluate(async () => {
  const { applyConfig } = await import('/js/project-io.js');
  applyConfig({
    schemaVersion: 2,
    scenario: { requests: [] },
    load: { mode: 'stages', stages: [{ duration: '45s', target: 7 }] },
  });
});
await page.locator('.nav-link[data-view="load"]').click();
assert.deepEqual(await inputValues(page.locator('.stage-target')), ['7'], 'loaded custom project is restored');
page.once('dialog', dialog => dialog.dismiss());
await page.getByRole('button', { name: /Smoke 1 VU/ }).click();
assert.deepEqual(await inputValues(page.locator('.stage-target')), ['7'], 'preset cannot silently overwrite loaded custom values');

page.once('dialog', dialog => dialog.accept());
await page.getByRole('button', { name: /Load up to 10 VUs/ }).click();
assert.equal(await page.locator('input[name="load-mode"]:checked').getAttribute('value'), 'stages');
assert.deepEqual(await inputValues(page.locator('.stage-dur')), ['1m', '3m', '1m']);
assert.deepEqual(await inputValues(page.locator('.stage-target')), ['10', '10', '0']);
assert.equal(await page.getByRole('button', { name: /Load up to 10 VUs/ }).getAttribute('aria-pressed'), 'true');

await page.getByRole('button', { name: 'Customize' }).click();
assert.equal(await custom.isVisible(), true);
await page.locator('.stage-target').nth(0).fill('12');

page.once('dialog', dialog => dialog.dismiss());
await page.getByRole('button', { name: /Stress up to 50 VUs/ }).click();
assert.equal(await page.locator('.stage-target').nth(0).inputValue(), '12', 'dismiss keeps custom load');

page.once('dialog', dialog => dialog.accept());
await page.getByRole('button', { name: /Stress up to 50 VUs/ }).click();
assert.deepEqual(await inputValues(page.locator('.stage-target')), ['10', '50', '50', '0']);
assert.equal(await page.getByRole('button', { name: /Stress up to 50 VUs/ }).getAttribute('aria-pressed'), 'true');

await page.locator('.nav-link[data-view="flow"]').click();
await page.locator('#empty-add-request').click();
const card = page.locator('.req-card').first();
await card.locator('.url').fill('https://example.test/health');
await card.getByRole('tab', { name: 'Checks settings' }).click();
await card.getByRole('button', { name: 'Successful response' }).click();
await card.getByRole('button', { name: 'Expected status' }).click();
await card.getByRole('button', { name: 'Response contains' }).click();
await card.getByRole('button', { name: 'Response time' }).click();
assert.deepEqual(await inputValues(card.locator('.assert-type')), [
  'status-2xx', 'status-eq', 'body-contains', 'duration-lt',
]);
assert.deepEqual(await inputValues(card.locator('.assert-val')), ['', '200', 'expected text', '500']);
for (const field of ['.assert-type', '.assert-val']) {
  assert.ok(await card.locator(field).first().getAttribute('aria-label'), `${field} has an accessible name`);
}

await page.setViewportSize({ width: 390, height: 844 });
const assertionBox = await card.locator('.assertion-row').last().evaluate(row => ({
  clientWidth: row.clientWidth,
  scrollWidth: row.scrollWidth,
}));
assert.ok(assertionBox.scrollWidth <= assertionBox.clientWidth + 1, 'check row does not overflow at 390px');
await page.setViewportSize({ width: 1280, height: 850 });

await page.locator('#preview-btn').click();
await page.locator('#view-script:not(.hidden)').waitFor();
await page.waitForFunction(() => document.querySelector('#script-preview').textContent.includes('export const options'));
const script = await page.locator('#script-preview').textContent();
for (const expected of ['"stages":', '"target": 50', 'status success (2xx)', 'status == 200', 'body contains', 'response < 500ms']) {
  assert.ok(script.includes(expected), `generated script includes ${expected}`);
}
assert.deepEqual(errors, []);

await browser.close();
console.log('PR-04 browser workflow passed with zero console/page errors.');
