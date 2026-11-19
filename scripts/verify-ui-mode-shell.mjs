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
  // A first visit starts in Simple, the guided layout; the rest of this check starts from Advanced.
  await active('simple', 'flow', 'flow');
  assert.equal(await page.evaluate(() => localStorage.getItem('k6ui.uiMode')), null, 'The default is not written to storage');
  await radio('advanced').check();
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
    // Run is the last control of the top bar; the visible navigation follows it.
    await page.locator('#run-btn').focus();
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
  await page.reload(); await ready(); await active('simple', 'flow', 'flow');
  const faults = ['getter', 'read', 'write'];
  for (const fault of faults) {
    await page.evaluate(() => localStorage.removeItem('k6ui.uiMode'));
    const isolated = await context.newPage();
    await isolated.addInitScript(fault => {
      if (fault === 'getter') Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } });
      else Storage.prototype[fault === 'read' ? 'getItem' : 'setItem'] = () => { throw new Error('blocked'); };
    }, fault);
    await isolated.goto(origin); await ready(isolated);
    assert.equal(await isolated.locator('html').getAttribute('data-ui-mode'), 'simple');
    await isolated.locator('input[name="ui-mode"][value="advanced"]').check();
    assert.equal(await isolated.locator('html').getAttribute('data-ui-mode'), 'advanced');
    await isolated.locator('#advanced-nav [data-view="load"]').click();
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
      assert.ok(layout.endpointWidth >= Math.min(200, width / 2), `Long endpoint has usable space (${Math.round(layout.endpointWidth)}px, ${mode} ${width})`);
      assert.equal(await page.locator('html').getAttribute('data-ui-mode'), mode);
      layouts.push({ mode, width, height, ...layout });
      if (width === 1440 || width === 375) {
        await page.screenshot({ path: resolve(output, `${mode}-${width}.png`), fullPage: true });
      }
    }
  }
  checks.push('Shell layout: both modes at four requested viewports plus 720x450 reflow equivalent (not native zoom)');

  // Help: "?" buttons share one tooltip (hover, focus, click to keep), the Glossary panel, the Import menu.
  {
    await page.setViewportSize({ width: 1440, height: 900 });
    await radio('simple').check();
    await page.locator('#simple-nav [data-view="load"]').click();
    const tip = page.locator('#help-tip');
    const smokeHelp = page.locator('.preset-item [data-help="smoke"]');
    assert.equal(await smokeHelp.getAttribute('aria-label'), 'About Smoke test');
    await smokeHelp.hover();
    assert.equal(await tip.isVisible(), true, 'Hover shows the tooltip');
    assert.match(await tip.textContent(), /Smoke test.*1 virtual user/s);
    assert.equal(await smokeHelp.getAttribute('aria-describedby'), 'help-tip');
    await page.mouse.move(0, 0);
    assert.equal(await tip.isVisible(), false, 'Leaving hides it');
    await smokeHelp.click();
    await page.mouse.move(0, 0);
    assert.equal(await tip.isVisible(), true, 'A click keeps it open (touch)');
    assert.equal(await smokeHelp.getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('Escape');
    assert.equal(await tip.isVisible(), false, 'Escape closes it');
    assert.equal(await page.locator('#load-custom-editor').isVisible(), false, 'A help click does nothing else');
    await page.locator('#customize-load').click();
    const stagesRadio = page.locator('input[name="load-mode"][value="stages"]');
    const before = await page.locator('input[name="load-mode"]:checked').getAttribute('value');
    await page.locator('.radio-card [data-help="stages"]').click();
    assert.equal(await page.locator('input[name="load-mode"]:checked').getAttribute('value'), before, 'Help inside a radio card does not pick it');
    assert.equal(await stagesRadio.evaluate(node => node.labels[0].querySelector('strong').textContent), 'Staged');
    assert.equal(await page.evaluate(() => document.querySelector('input[name="load-mode"][value="stages"]').getAttribute('aria-labelledby')), 'load-mode-stages-name');
    await page.keyboard.press('Escape');
    await page.locator('#customize-load').click();
    await page.locator('label[for="vus"]').count().then(count => assert.equal(count, 1, 'VUs has a real label'));

    // Glossary: opens on the filter, filters, Escape closes and returns focus.
    await page.locator('#glossary-btn').click();
    assert.equal(await page.locator('#glossary-panel').isVisible(), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'glossary-filter');
    const terms = await page.locator('#glossary-list dt').count();
    assert.ok(terms >= 25, 'Every term is listed');
    await page.locator('#glossary-filter').fill('p95');
    assert.ok(await page.locator('#glossary-list dt').count() < terms);
    assert.equal(await page.locator('#glossary-p95').isVisible(), true);
    await page.locator('#glossary-filter').fill('zzzz');
    assert.match(await page.locator('#glossary-list').textContent(), /No term matches "zzzz"/);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#glossary-panel').isVisible(), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'glossary-btn');

    // Import menu: keyboard opens it on the first item, Escape closes it; cURL adds a request.
    const menuButton = page.locator('#import-menu-btn');
    await menuButton.focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator('#import-menu').isVisible(), true);
    assert.equal(await menuButton.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'import-curl-btn');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'import-k6-btn');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#import-menu').isVisible(), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'import-menu-btn');
    await menuButton.click();
    await page.locator('#import-k6-btn').click();
    assert.equal(await page.locator('#k6-import-modal').isVisible(), true, 'k6 / JMeter item opens the import dialog');
    await page.locator('#k6-import-cancel').click();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'import-menu-btn', 'Focus returns to the menu button');
    const cardsBefore = await page.locator('.req-card').count();
    await menuButton.click();
    await page.locator('#import-curl-btn').click();
    assert.equal(await page.locator('#view-flow').isVisible(), true, 'cURL goes to the request flow');
    assert.equal(await page.locator('.req-card').count(), cardsBefore + 1);
    assert.equal(await page.locator('#curl-modal').isVisible(), true);
    await page.locator('#curl-input').fill("curl 'https://fixture.test/from-menu' -H 'Accept: application/json'");
    await page.locator('#curl-apply').click();
    assert.equal(await page.locator('.req-card').last().locator('.url').inputValue(), 'https://fixture.test/from-menu');
    await page.locator('.req-card').last().locator('.req-tab[data-tab="extractions"]').click();
    assert.equal(await page.locator('.req-card').last().locator('[data-help="extraction"]').getAttribute('aria-label'), 'About Extraction');
  }
  checks.push('Help: one tooltip on hover/focus (aria-describedby), click keeps it, Escape closes; help in a radio card does not pick it; Glossary lists, filters, returns focus; Import menu by keyboard and mouse, cURL adds a request');

  // Request cards: drag handle, group bands, ⋯ panel, one method list (Simple).
  {
    await page.setViewportSize({ width: 1440, height: 900 });
    await radio('simple').check();
    await page.locator('#simple-nav [data-view="flow"]').click();
    const project = {
      schemaVersion: 2,
      scenario: {
        groups: [{ id: 'grp_pay', name: 'Checkout', enabled: true, collapsed: false, headers: [],
          runIf: { variable: 'MODE', operator: 'one-of', values: ['ORDER', 'ALL'] } }],
        requests: [
          { id: 'req_a', name: 'Login', type: 'http', method: 'POST', url: 'https://fixture.test/login' },
          { id: 'req_b', name: 'Create order', groupId: 'grp_pay', type: 'http', method: 'POST', url: 'https://fixture.test/orders' },
          { id: 'req_c', name: 'Pay', groupId: 'grp_pay', type: 'http', method: 'POST', url: 'https://fixture.test/pay' },
          { id: 'req_d', name: 'Profile', type: 'http', method: 'GET', url: 'https://fixture.test/me' },
        ],
      },
      variables: [{ key: 'MODE', value: 'ORDER' }],
      load: { mode: 'simple', vus: '1', duration: '5s' },
      thresholds: { p95: '', errorRate: '' },
    };
    await page.evaluate(async config => (await import('/js/project-io.js')).applyConfig(config), project);
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => setTimeout(done, 0))));
    const cardOf = id => page.locator(`#reqs-main > .req-card[data-request-id="${id}"]`);
    const order = () => page.$$eval('#reqs-main > .req-card', cards => cards.map(card => card.dataset.requestId));
    const groupOf = id => cardOf(id).locator('.request-group-select').inputValue();
    const settleBands = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => setTimeout(done, 0))));

    // Bands: the first request of a group's run names the group and its condition.
    assert.equal(await cardOf('req_b').locator('.req-group-band').count(), 1);
    assert.equal(await cardOf('req_b').locator('.req-group-band-name').textContent(), 'Checkout');
    assert.match(await cardOf('req_b').locator('.req-group-band-condition').textContent(), /Runs only if MODE/);
    assert.equal(await cardOf('req_c').locator('.req-group-band').count(), 0, 'one band per run');
    assert.equal(await cardOf('req_c').getAttribute('data-group-run'), 'end');

    // Drag Profile into the band (top half of Create order): it moves and joins the group.
    await cardOf('req_d').locator('.req-drag-handle').dragTo(cardOf('req_b'), { targetPosition: { x: 60, y: 6 } });
    await settleBands();
    assert.deepEqual(await order(), ['req_a', 'req_d', 'req_b', 'req_c']);
    assert.equal(await groupOf('req_d'), 'grp_pay', 'dropped inside the band → joins the group');
    assert.equal(await cardOf('req_d').locator('.req-group-band').count(), 1, 'the band moves to the new first request');
    assert.match(await page.locator('#flow-announcer').textContent(), /Profile is now request 2, in group Checkout/);
    assert.equal(await cardOf('req_d').locator('.req-num').textContent(), '#2');

    // Drag Pay above Login (outside the band): it leaves the group.
    await cardOf('req_c').locator('.req-drag-handle').dragTo(cardOf('req_a'), { targetPosition: { x: 60, y: 6 } });
    await settleBands();
    assert.deepEqual(await order(), ['req_c', 'req_a', 'req_d', 'req_b']);
    assert.equal(await groupOf('req_c'), '', 'dropped outside → no group');
    const config = await page.evaluate(async () => (await import('/js/config.js')).collectConfig());
    assert.deepEqual(config.scenario.requests.map(request => [request.id, request.groupId]),
      [['req_c', ''], ['req_a', ''], ['req_d', 'grp_pay'], ['req_b', 'grp_pay']], 'the project follows the cards');

    // ⋯ panel by keyboard: Enter opens on the first action, arrows move, Escape returns to the button.
    const more = cardOf('req_a').locator('.request-more');
    await more.focus();
    await page.keyboard.press('Enter');
    assert.equal(await cardOf('req_a').locator('.req-more-panel').isVisible(), true);
    assert.equal(await more.getAttribute('aria-expanded'), 'true');
    assert.match(await page.evaluate(() => document.activeElement.className), /request-duplicate/);
    await page.keyboard.press('ArrowDown');
    assert.match(await page.evaluate(() => document.activeElement.className), /curl/);
    await page.keyboard.press('Escape');
    assert.equal(await cardOf('req_a').locator('.req-more-panel').isVisible(), false);
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('request-more')), true);
    await more.click();
    await page.locator('.zone-title').click();
    assert.equal(await cardOf('req_a').locator('.req-more-panel').isVisible(), false, 'a click outside closes it');
    await more.click();
    await cardOf('req_a').locator('.request-move-down').click();
    assert.deepEqual(await order(), ['req_c', 'req_d', 'req_a', 'req_b'], 'Move down keeps the group as it is');
    assert.equal(await cardOf('req_a').locator('.req-more-panel').isVisible(), true, 'the panel stays open to move again');
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('request-move-down')), true);
    await page.keyboard.press('Escape');

    // One method list: picking gRPC sets the protocol; picking a method sets HTTP back.
    await cardOf('req_a').locator('.req-card-head').click();
    const kind = cardOf('req_a').locator('.request-kind');
    assert.equal(await kind.inputValue(), 'POST');
    await kind.selectOption('grpc');
    assert.equal(await cardOf('req_a').locator('.protocol').inputValue(), 'grpc');
    assert.equal(await cardOf('req_a').locator('.grpc-row').isVisible(), true);
    await kind.selectOption('PATCH');
    assert.equal(await cardOf('req_a').locator('.protocol').inputValue(), 'http');
    assert.equal(await cardOf('req_a').locator('.method').inputValue(), 'PATCH');
    assert.equal(await cardOf('req_a').locator('.request-method-preview').textContent(), 'PATCH');

    // The switch is the same checkbox: off skips the request.
    await cardOf('req_d').locator('.request-enabled').uncheck();
    assert.equal(await cardOf('req_d').evaluate(card => card.classList.contains('request-disabled')), true);
    await cardOf('req_d').locator('.request-enabled').check();
  }
  checks.push('Request cards: drag into a group band joins it, outside leaves it, announced; ⋯ panel keyboard/click-outside, Move keeps it open; one method list drives protocol + method; switch = the enabled checkbox');

  assert.deepEqual(forbidden, []);
  assert.deepEqual(errors, []);
  const result = { checks, layouts, generated, errors, forbidden, nativeZoomTested: false, realRunTested: false };
  console.log(JSON.stringify(result, null, 2));
  await writeFile(resolve(output, 'verification.json'), JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
}
