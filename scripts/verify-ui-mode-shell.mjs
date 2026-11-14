// Stage 2 only: real browser shell checks; never run k6 or contact fixture targets.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from '../server/index.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = resolve('.hermes/plans/k6ui-ui-revamp-preview/stage2');
await mkdir(output, { recursive: true });
const server = createServer({ port: 0, host: '127.0.0.1' });
let browser;
const errors = [], forbidden = [], checks = [], layouts = [];
let generated = 0;
try {
  await once(server, 'listening');
  assert.equal(server.address().address, '127.0.0.1');
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || url.pathname === '/api/run') {
      forbidden.push(`${route.request().method()} ${url.origin}${url.pathname}`);
      return route.abort();
    }
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
    return route.continue();
  });
  context.on('page', page => {
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/generate') generated++; });
  });
  const page = await context.newPage();
  const radio = mode => page.locator(`input[name="ui-mode"][value="${mode}"]`);
  const nav = view => page.locator(`#advanced-nav [data-view="${view}"]`);
  async function ready(target = page) {
    await target.waitForFunction(() => document.querySelector('#reqs-main'));
  }
  async function active(mode, view, current) {
    assert.equal(await page.locator('html').getAttribute('data-ui-mode'), mode);
    assert.equal(await page.locator(`#view-${view}`).isVisible(), true);
    assert.equal(await page.locator('[data-ui-nav]:not([hidden])').count(), 1);
    assert.equal(await page.locator('.nav-link[aria-current]').count(), 1);
    assert.equal(await page.locator('.nav-link[aria-current]').getAttribute('aria-current'), mode === 'simple' ? 'step' : 'page');
    assert.equal(await page.locator('.nav-link[aria-current]').getAttribute('data-view'), current);
    assert.equal(await page.locator('[data-ui-nav][hidden] .active').count(), 0);
  }
  await page.goto(origin);
  await ready();
  await active('advanced', 'flow', 'flow');
  await page.locator('#empty-add-request').click();
  await page.locator('.req-card .url').fill('https://fixture.test/unsaved');
  await page.locator('.req-tab[data-tab="body"]').click();
  await page.locator('.req-card textarea.body').fill('  unsaved body\nwith trailing spaces  ');
  await page.evaluate(async () => {
    window.originalCard = document.querySelector('.req-card');
    window.originalBody = document.querySelector('.req-card textarea.body');
    window.originalStore = (await import('/js/project-store.js')).projectStore.getState();
    window.originalPanelCount = document.querySelectorAll('[data-panel-ready="true"]').length;
    if (window.originalPanelCount < 2) throw new Error('Headers and Body must be hydrated for this check');
  });
  await radio('simple').check();
  await page.locator('#simple-nav [data-view="data"]').click();
  await active('simple', 'data', 'data');
  await radio('advanced').check();
  await active('advanced', 'vars', 'vars');
  await page.locator('.var-key').fill('unsaved_name');
  await page.locator('.var-val').fill('  unsaved variable  ');
  await nav('headers').click();
  await page.locator('#global-headers-list .h-key').fill('X-Unsaved');
  await page.locator('#global-headers-list .h-val').fill('  unsaved header  ');
  for (let i = 0; i < 3; i++) {
    await radio('simple').check();
    await active('simple', 'headers', 'data');
    await radio('advanced').check();
    await active('advanced', 'headers', 'headers');
  }
  await nav('flow').click();
  assert.equal(await page.locator('.req-card textarea.body').inputValue(), '  unsaved body\nwith trailing spaces  ');
  assert.equal(await page.locator('.req-card .url').inputValue(), 'https://fixture.test/unsaved');
  assert.equal(await page.locator('.var-val').inputValue(), '  unsaved variable  ');
  assert.equal(await page.locator('#global-headers-list .h-val').inputValue(), '  unsaved header  ');
  assert.equal(await page.evaluate(async () => window.originalCard === document.querySelector('#reqs-main > .req-card') &&
    window.originalBody === document.querySelector('.req-card textarea.body') &&
    window.originalStore === (await import('/js/project-store.js')).projectStore.getState() &&
    window.originalPanelCount === document.querySelectorAll('[data-panel-ready="true"]').length), true);
  assert.equal(await page.locator('.req-tab[aria-selected="true"]').getAttribute('data-tab'), 'body');
  assert.equal(generated, 0, 'Switching/navigation do not collect or generate');
  checks.push('Raw unsaved inputs, DOM identity, tab, lazy panels and stale store survive repeated switch/direct navigation');

  // Native radio keyboard behavior and visible focus, then ordinary button navigation.
  await radio('advanced').focus();
  await page.keyboard.press('ArrowLeft');
  await active('simple', 'flow', 'flow');
  assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement.nextElementSibling).outlineStyle), 'solid');
  await page.keyboard.press('ArrowRight');
  await active('advanced', 'flow', 'flow');
  await nav('vars').focus();
  await page.keyboard.press('Enter');
  await active('advanced', 'vars', 'vars');
  assert.equal(await page.locator('#page-title').evaluate(node => node === document.activeElement), true);
  for (const mode of ['simple', 'advanced']) {
    await radio(mode).check();
    await page.locator('#open-project-btn').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.closest('[data-ui-nav]')?.dataset.uiNav), mode);
  }
  checks.push('Keyboard switch/category navigation, visible focus, one aria-current and hidden navigation excluded from tab order');

  for (const view of ['vars', 'headers', 'sla', 'flow', 'load', 'results']) {
    await nav(view).click();
    await active('advanced', view, view);
    await radio('simple').check();
    await active('simple', view, ['vars', 'headers', 'sla'].includes(view) ? 'data' : view);
    await radio('advanced').check();
    await active('advanced', view, view);
  }
  await nav('load').click();
  // Stage 4: Advanced always shows the custom load editor (no Customize click).
  assert.equal(await page.locator('#load-custom-editor').isVisible(), true);
  await page.locator('#vus').fill('7');
  await page.locator('#duration').fill('17s');
  await radio('simple').check();
  await radio('advanced').check();
  assert.equal(await page.locator('#vus').inputValue(), '7');
  assert.equal(await page.locator('#duration').inputValue(), '17s');
  assert.equal(await page.locator('input[name="load-mode"]:checked').inputValue(), 'simple');
  await nav('results').click();
  await page.locator('.results-tab[data-tab="errors"]').click();
  await radio('simple').check();
  await radio('advanced').check();
  assert.equal(await page.locator('.results-tab[aria-selected="true"]').getAttribute('data-tab'), 'errors');
  checks.push('Every category maps to its shared view; load.mode and unsaved load values/results tab remain independent');

  // Generation-only parity; the .test target is never executed.
  const before = await page.evaluate(async () => (await import('/js/config.js')).collectConfig());
  let response = page.waitForResponse(res => res.url() === `${origin}/api/generate`);
  await nav('script').click();
  const scriptBefore = (await (await response).json()).script;
  await page.waitForFunction(() => !document.querySelector('#view-script').classList.contains('hidden'));
  assert.equal(generated, 1);
  assert.match(scriptBefore, /fixture\.test\/unsaved/);
  await radio('simple').check();
  await active('simple', 'script', 'results');
  await radio('advanced').check();
  await active('advanced', 'script', 'script');
  assert.equal(generated, 1, 'Switch on Script does not regenerate');
  const after = await page.evaluate(async () => (await import('/js/config.js')).collectConfig());
  assert.deepEqual(after, before);
  assert.equal('uiMode' in after, false);
  response = page.waitForResponse(res => res.url() === `${origin}/api/generate`);
  await nav('script').click();
  assert.equal((await (await response).json()).script, scriptBefore);
  await nav('flow').click();
  await page.locator('.req-card .url').fill('https://fixture.test/changed');
  response = page.waitForResponse(res => res.url() === `${origin}/api/generate`);
  await nav('script').click();
  assert.match((await (await response).json()).script, /fixture\.test\/changed/);
  assert.equal(generated, 3, 'Each Script click has exactly one generator request');
  checks.push('Script category refreshes live form exactly once per click; config/script parity across mode switch; no serialized uiMode');

  // Real storage and reload, plus fault injection at each storage boundary.
  await radio('simple').check();
  assert.deepEqual(await page.evaluate(() => Object.entries(localStorage)), [['k6ui.uiMode', 'simple']]);
  await page.reload(); await ready(); await active('simple', 'flow', 'flow');
  assert.equal(await page.locator('.req-card').count(), 0, 'UI preference is not project autosave');
  await radio('advanced').check();
  await page.reload(); await ready(); await active('advanced', 'flow', 'flow');
  await page.evaluate(() => localStorage.setItem('k6ui.uiMode', ' Advanced '));
  await page.reload(); await ready(); await active('advanced', 'flow', 'flow');
  const faults = ['getter', 'read', 'write'];
  for (const fault of faults) {
    await page.evaluate(() => localStorage.removeItem('k6ui.uiMode'));
    const isolated = await context.newPage();
    await isolated.addInitScript(fault => {
      if (fault === 'getter') Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } });
      else Storage.prototype[fault === 'read' ? 'getItem' : 'setItem'] = () => { throw new Error('blocked'); };
    }, fault);
    await isolated.goto(origin); await ready(isolated);
    assert.equal(await isolated.locator('html').getAttribute('data-ui-mode'), 'advanced');
    await isolated.locator('input[name="ui-mode"][value="simple"]').check();
    assert.equal(await isolated.locator('html').getAttribute('data-ui-mode'), 'simple');
    await isolated.locator('#simple-nav [data-view="load"]').click();
    assert.equal(await isolated.locator('#view-load').isVisible(), true);
    await isolated.close();
  }
  checks.push('Only the enum is stored; refresh remembers valid modes but not project; invalid/get/read/write failures remain usable');

  // Presentation smoke for this shell, not the later outline/results redesign.
  await page.evaluate(async () => {
    const { addRequest } = await import('/js/components/flow-view.js');
    const card = addRequest();
    card.querySelector('.url').value = 'https://fixture.test/' + 'long-path/'.repeat(20);
    card.querySelector('.request-name').value = 'Synthetic unsaved request';
  });
  for (const [width, height] of [[1440, 900], [1024, 768], [768, 1024], [375, 812], [720, 450]]) {
    await page.setViewportSize({ width, height });
    for (const mode of ['simple', 'advanced']) {
      await radio(mode).check();
      const flowLink = page.locator(`#${mode}-nav [data-view="flow"]`);
      await flowLink.click();
      const layout = await page.evaluate(() => {
        const inputs = [...document.querySelectorAll('input[name="ui-mode"]')];
        const box = document.querySelector('.req-card .url').getBoundingClientRect();
        const ids = [...document.querySelectorAll('[id]')].map(node => node.id);
        return {
          overflow: document.documentElement.scrollWidth > innerWidth,
          duplicateIds: ids.length !== new Set(ids).size,
          switchFits: inputs.every(input => { const r = input.nextElementSibling.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.width >= 44 && r.height >= 44; }),
          endpointWidth: box.width,
        };
      });
      assert.equal(layout.overflow, false, `${mode} ${width}: page overflow`);
      assert.equal(layout.duplicateIds, false);
      assert.equal(layout.switchFits, true);
      assert.ok(layout.endpointWidth >= Math.min(200, width / 2), 'Long endpoint has usable space');
      assert.equal(await page.locator('html').getAttribute('data-ui-mode'), mode);
      layouts.push({ mode, width, height, ...layout });
      if (width === 1440 || width === 375) {
        await page.screenshot({ path: resolve(output, `${mode}-${width}.png`), fullPage: true });
      }
    }
  }
  checks.push('Shell layout: both modes at four requested viewports plus 720x450 reflow equivalent (not native zoom)');
  assert.deepEqual(forbidden, []);
  assert.deepEqual(errors, []);
  const result = { checks, layouts, generated, errors, forbidden, nativeZoomTested: false, realRunTested: false };
  console.log(JSON.stringify(result, null, 2));
  await writeFile(resolve(output, 'verification.json'), JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
}
