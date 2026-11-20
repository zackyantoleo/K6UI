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
  // Categories that are one block of a shared page (stage 5): Simple shows the page, Advanced the block.
  const PAGE_OF = { vars: 'data', headers: 'data', datafiles: 'data', sla: 'load' };
  const BLOCK_OF = { vars: 'vars', headers: 'headers', datafiles: 'datafiles', sla: 'sla', load: 'load' };
  async function active(mode, view, current) {
    assert.equal(await page.locator('html').getAttribute('data-ui-mode'), mode);
    const pageView = `#view-${PAGE_OF[view] || view}`;
    assert.equal(await page.locator(pageView).isVisible(), true);
    if (mode === 'advanced' && BLOCK_OF[view]) {
      assert.equal(await page.locator(`${pageView} > .view-block[data-block="${BLOCK_OF[view]}"]`).isVisible(), true);
      assert.equal(await page.locator(`${pageView} > .view-block:visible`).count(), 1);
    }
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
  await page.locator('.req-card .request-kind').selectOption('POST');
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
  assert.equal(await page.locator('.req-card .req-section-body').isVisible(), true, 'Body still shown');
  assert.equal(generated, 0, 'Switching/navigation do not collect or generate');
  checks.push('Raw unsaved inputs, DOM identity, Body section, lazy panels and stale store survive repeated switch/direct navigation');

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
    await active('simple', view, { vars: 'data', headers: 'data', sla: 'load' }[view] || view);
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
    const imported = page.locator('.req-card').last();
    await imported.locator('.req-add-btn').click();
    await imported.locator('.req-add-item[data-panel="extractions"]').click();
    assert.equal(await imported.locator('.req-section-extractions [data-help="extraction"]').getAttribute('aria-label'), 'About Extraction');
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

    // The first request opened with the project; its editor (Headers + Body) is taller than a
    // 900 px window leaves for dragging the last card above it, so close it first.
    await cardOf('req_a').locator('.request-expand').click();
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

  // Request editor: Headers and Body always, other parts from "+ Add to this request", "Wait after" below.
  {
    const project = {
      schemaVersion: 2,
      scenario: {
        groups: [],
        requests: [
          { id: 'req_e', name: 'Redeem', type: 'http', method: 'POST', url: 'https://fixture.test/redeem',
            assertions: [{ type: 'status-eq', value: '200', value2: '' }], sleepAfter: '0.5' },
          { id: 'req_f', name: 'Status', type: 'http', method: 'GET', url: 'https://fixture.test/status', checkStatus: false },
        ],
      },
      variables: [],
      load: { mode: 'simple', vus: '1', duration: '5s' },
      thresholds: { p95: '', errorRate: '' },
    };
    await page.evaluate(async config => (await import('/js/project-io.js')).applyConfig(config), project);
    const cardOf = id => page.locator(`#reqs-main > .req-card[data-request-id="${id}"]`);
    const parts = id => cardOf(id).locator('.req-extra-sections > .req-section:not([hidden]) .req-panel')
      .evaluateAll(nodes => nodes.map(node => node.dataset.panel));
    const focused = () => page.evaluate(() => ({ panel: document.activeElement?.dataset.panel || '', className: document.activeElement?.className || '' }));
    const redeem = cardOf('req_e');
    const menu = redeem.locator('.req-add-menu');
    const addButton = redeem.locator('.req-add-btn');
    assert.equal(await redeem.locator('.req-tab, [role="tab"]').count(), 0, 'no editor tabs');
    assert.deepEqual(await parts('req_e'), ['assertions'], 'a part the request uses is shown, the others are not');
    assert.equal(await redeem.locator('.req-section-headers').isVisible(), true);
    assert.equal(await redeem.locator('.req-section-body').isVisible(), true, 'POST shows Body');
    assert.equal(await redeem.locator('.req-editor-foot .sleep').inputValue(), '0.5', '"Wait after" holds the saved pause');
    assert.equal(await redeem.locator('.req-wait label [data-help]').count(), 0, 'help sits beside the label');
    assert.equal(await redeem.locator('.req-wait [data-help="pause"]').count(), 1);

    // The menu by keyboard: Arrow Down opens it on the first item, End goes to the last, Escape returns.
    await addButton.focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await menu.isVisible(), true);
    assert.equal(await addButton.getAttribute('aria-expanded'), 'true');
    assert.equal((await focused()).panel, 'assertions');
    assert.equal(await redeem.locator('.req-add-item[data-panel="assertions"] .req-add-added').isVisible(), true, 'a shown part says Added');
    assert.equal(await redeem.locator('.req-add-item[data-panel="extractions"] .req-add-added').isVisible(), false);
    await page.keyboard.press('End');
    assert.equal((await focused()).panel, 'scripts');
    assert.match(await redeem.locator('.req-add-item[data-panel="scripts"]').innerText(), /Advanced/i);
    await page.keyboard.press('Escape');
    assert.equal(await menu.isVisible(), false);
    assert.match((await focused()).className, /req-add-btn/);
    await addButton.click();
    await page.locator('.zone-title').click();
    assert.equal(await menu.isVisible(), false, 'a click outside closes it');

    // Enter on an item adds that part and puts the cursor in it.
    await addButton.focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    assert.match((await focused()).className, /ext-name/);
    assert.deepEqual(await parts('req_e'), ['assertions', 'extractions']);
    // Choosing a part that is already there takes the cursor to it.
    await addButton.click();
    await redeem.locator('.req-add-item[data-panel="assertions"]').click();
    assert.match((await focused()).className, /check-template-btn/);

    // Removing an empty part asks nothing; one that holds something asks first.
    await redeem.locator('.req-section-extractions .req-section-remove').click();
    assert.deepEqual(await parts('req_e'), ['assertions']);
    assert.match((await focused()).className, /req-add-btn/, 'focus goes back to the menu button');
    let asked = '';
    page.once('dialog', dialog => { asked = dialog.message(); return dialog.dismiss(); });
    await redeem.locator('.req-section-assertions .req-section-remove').click();
    assert.match(asked, /^Remove "Check the response" from this request\?/);
    assert.deepEqual(await parts('req_e'), ['assertions'], 'Cancel keeps it');
    page.once('dialog', dialog => dialog.accept());
    await redeem.locator('.req-section-assertions .req-section-remove').click();
    assert.deepEqual(await parts('req_e'), []);
    const removed = await page.evaluate(async () => (await import('/js/config.js')).collectConfig());
    assert.deepEqual(removed.scenario.requests[0].assertions, [], 'the checks are gone from the project');

    // A request with the automatic status check off opens with "Success statuses"; a GET with no body has no Body.
    await cardOf('req_f').locator('.req-card-head').click();
    assert.deepEqual(await parts('req_f'), ['statuses']);
    assert.equal(await cardOf('req_f').locator('.check-status').isChecked(), false);
    assert.equal(await cardOf('req_f').locator('.req-section-body').isVisible(), false);
  }
  checks.push('Request editor: no tabs; Headers + Body (by method) + the parts in use; "+ Add to this request" by keyboard (Arrow Down, End, Escape, Enter) and click-outside, marks added parts, puts the cursor in the part; removing an empty part asks nothing, a filled one asks (Cancel keeps it); "Wait after" beside its help');

  // Variables: the panel, {{ suggestions and the "not available yet" warnings.
  {
    await page.setViewportSize({ width: 1440, height: 900 });
    await radio('simple').check();
    await page.locator('#simple-nav [data-view="flow"]').click();
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    const project = {
      schemaVersion: 2,
      scenario: {
        groups: [],
        requests: [
          { id: 'req_pay', name: 'Pay order', type: 'http', method: 'POST', url: '{{base_url}}/orders/{{order_id}}/pay',
            body: '{"t":"{{ token }}"}' },
          { id: 'req_login', name: 'Log in', type: 'http', method: 'POST', url: '{{base_url}}/login', body: '{"email":"{{email}}"}',
            extractions: [{ varName: 'token', source: 'json', selector: 'token' }] },
          { id: 'req_create', name: 'Create order', type: 'http', method: 'POST', url: '{{base_url}}/orders',
            headers: [{ key: 'Authorization', value: 'Bearer {{token}}' }],
            extractions: [{ varName: 'order_id', source: 'json', selector: 'id' }] },
        ],
      },
      variables: [{ key: 'base_url', value: 'https://fixture.test' }],
      dataSets: [{ id: 'ds_users', name: 'Users', fileName: 'users.csv', delimiter: ',', skipHeader: true, columns: [],
        content: 'email,password\nuser1@example.test,pass1\n', share: 'next-row', onEnd: 'recycle' }],
      load: { mode: 'simple', vus: '1', duration: '5s' },
      thresholds: { p95: '', errorRate: '' },
    };
    await page.evaluate(async config => (await import('/js/project-io.js')).applyConfig(config), project);
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => setTimeout(done, 0))));
    const cardOf = id => page.locator(`#reqs-main > .req-card[data-request-id="${id}"]`);
    const panel = page.locator('#flow-vars');
    const chips = () => panel.locator('.var-chip').evaluateAll(nodes => nodes.map(node => node.textContent.replace(/\s+/g, ' ').trim()));
    const warnings = id => cardOf(id).locator('.var-warning-text').allTextContents();
    const list = page.locator('#var-suggest');
    const options = () => list.locator('[role="option"]').evaluateAll(nodes => nodes.map(node => ({
      name: node.querySelector('.var-suggest-name').textContent,
      later: node.classList.contains('is-later'),
      selected: node.getAttribute('aria-selected') === 'true',
    })));

    // The panel: every source, beside the list on a wide Simple screen.
    assert.equal(await panel.isVisible(), true);
    assert.deepEqual(await chips(), ['{{base_url}}', '{{email}}', '{{password}}', '{{token}} after #2', '{{order_id}} after #3']);
    assert.deepEqual(await panel.locator('.flow-vars-group-title').allTextContents(),
      ['Global variables', 'Each row of Users', 'From responses']);
    assert.equal(await panel.locator('.flow-vars-count').textContent(), '5');
    const panelBox = await panel.boundingBox();
    const zoneBox = await page.locator('#zone-main').boundingBox();
    assert.ok(panelBox.x > zoneBox.x + zoneBox.width - 1, 'wide Simple screen: the panel is beside the list');

    // Warnings: a value a later request takes, and spaces inside the braces.
    assert.deepEqual(await warnings('req_pay'), ['{{order_id}} not available yet', '{{ token }} has spaces']);
    assert.match(await cardOf('req_pay').locator('.var-warning').first().getAttribute('title'),
      /^Request #3 \(Create order\) gives \{\{order_id\}\}, but it runs after this one\./);
    assert.deepEqual(await warnings('req_login'), []);
    assert.equal(await cardOf('req_login').locator('.req-var-warnings').isVisible(), false);

    // {{ in a URL: the list opens under the caret, what this request can use first.
    await cardOf('req_create').locator('.req-card-head').click();
    const url = cardOf('req_create').locator('.url');
    await url.click();
    await url.press('End');
    await url.pressSequentially('?u={{');
    assert.equal(await list.isVisible(), true);
    assert.equal(await url.getAttribute('aria-controls'), 'var-suggest');
    assert.deepEqual((await options()).map(item => [item.name, item.later]), [
      ['{{base_url}}', false], ['{{email}}', false], ['{{password}}', false], ['{{token}}', false], ['{{order_id}}', true],
    ], 'a value this request takes itself is offered, marked "not available here yet"');
    assert.equal(await url.getAttribute('aria-activedescendant'), 'var-suggest-0');
    await url.pressSequentially('pa');
    assert.deepEqual((await options()).map(item => item.name), ['{{password}}']);
    await url.press('Backspace');
    await url.press('Backspace');
    await url.press('ArrowDown');
    assert.equal((await options()).findIndex(item => item.selected), 1);
    await url.press('ArrowUp');
    await url.press('ArrowUp');
    assert.equal((await options()).findIndex(item => item.selected), 4, 'Arrow Up from the first wraps to the last');
    await url.press('ArrowDown');
    await url.press('ArrowDown');
    await url.press('Enter');
    assert.equal(await url.inputValue(), '{{base_url}}/orders?u={{email}}');
    assert.equal(await list.isVisible(), false);
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('url')), true, 'focus stays in the field');
    assert.equal(await url.getAttribute('aria-activedescendant'), null);
    // Escape closes the list only: the editor stays open and nothing is inserted.
    await url.pressSequentially('&p={{');
    await url.press('Escape');
    assert.equal(await list.isVisible(), false);
    assert.equal(await url.inputValue(), '{{base_url}}/orders?u={{email}}&p={{');
    assert.equal(await cardOf('req_create').evaluate(card => card.classList.contains('expanded')), true);
    // A click on an option inserts it and finishes the braces typed after the caret.
    await url.press('Backspace');
    await url.press('Backspace');
    await url.pressSequentially('{{pa}}');
    for (let i = 0; i < 2; i++) await url.press('ArrowLeft');
    await url.press('ArrowRight');
    await url.press('ArrowLeft');
    assert.equal(await list.isVisible(), true, 'a caret inside "{{pa" shows the list again');
    await list.locator('[role="option"]').first().click();
    assert.equal(await url.inputValue(), '{{base_url}}/orders?u={{email}}&p={{password}}');
    // The body of a request whose token comes from an earlier request: available.
    const body = cardOf('req_create').locator('textarea.body');
    await body.click();
    await body.pressSequentially('{"t":"{{to');
    assert.deepEqual(await options(), [{ name: '{{token}}', later: false, selected: true }]);
    await body.press('Tab');
    assert.equal(await body.inputValue(), '{"t":"{{token}}');
    // A global header goes with every request: offered without marks.
    await page.locator('#simple-nav [data-view="data"]').click();
    if (!(await page.locator('#global-headers-list .h-val').count())) await page.locator('#add-global-header').click();
    const shared = page.locator('#global-headers-list .h-val').first();
    await shared.fill('');
    await shared.pressSequentially('Bearer {{');
    assert.deepEqual((await options()).map(item => [item.name, item.later]),
      [['{{base_url}}', false], ['{{email}}', false], ['{{password}}', false], ['{{token}}', false], ['{{order_id}}', false]]);
    await shared.press('Escape');
    await shared.fill('');
    await page.locator('#simple-nav [data-view="flow"]').click();

    // Moving "Pay order" below "Create order" clears its warning; turning "Create order" off brings one back.
    const more = cardOf('req_pay').locator('.request-more');
    await more.click();
    await cardOf('req_pay').locator('.request-move-down').click();
    await cardOf('req_pay').locator('.request-move-down').click();
    await page.keyboard.press('Escape');
    assert.deepEqual(await warnings('req_pay'), ['{{ token }} has spaces']);
    await cardOf('req_create').locator('.request-enabled').uncheck();
    assert.deepEqual(await warnings('req_pay'), ['{{order_id}} not available', '{{ token }} has spaces']);
    assert.match(await cardOf('req_pay').locator('.var-warning').first().getAttribute('title'), /and it is turned off\./);
    assert.deepEqual(await chips(), ['{{base_url}}', '{{email}}', '{{password}}', '{{token}} after #1'],
      'a request that does not run gives nothing');
    await cardOf('req_create').locator('.request-enabled').check();
    // An open card writes the reason out.
    await cardOf('req_pay').locator('.request-expand').click();
    assert.match(await cardOf('req_pay').locator('.var-warning-detail').first().innerText(), /^Write it without spaces, as \{\{token\}\}/);

    // Chips: one Tab stop, arrows move, a click copies, a drag inserts into a field.
    const chip = name => panel.locator(`.var-chip[data-var="${name}"]`);
    assert.equal(await panel.locator('.var-chip[tabindex="0"]').count(), 1);
    await chip('base_url').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.var), 'email');
    await page.keyboard.press('End');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.var), 'order_id');
    assert.equal(await chip('order_id').getAttribute('tabindex'), '0');
    await chip('email').click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '{{email}}');
    assert.match(await panel.locator('.flow-vars-status').textContent(), /^Copied \{\{email\}\}\./);
    const payUrl = cardOf('req_pay').locator('.url');
    await payUrl.fill('');
    await chip('base_url').dragTo(payUrl);
    assert.equal(await payUrl.inputValue(), '{{base_url}}');
    // The panel folds away.
    const toggle = panel.locator('.flow-vars-toggle');
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await panel.locator('.flow-vars-body').isVisible(), false);
    await toggle.click();
    assert.equal(await panel.locator('.flow-vars-body').isVisible(), true);

    // Advanced: the same panel above the selected editor; the warnings are on the card.
    await radio('advanced').check();
    await page.locator('#flow-outline .outline-item[data-id="req_pay"]').click();
    assert.equal(await panel.isVisible(), true);
    const advancedPanel = await panel.boundingBox();
    const editor = await cardOf('req_pay').boundingBox();
    assert.ok(advancedPanel.y + advancedPanel.height <= editor.y, 'Advanced: the panel is above the editor');
    assert.deepEqual(await warnings('req_pay'), ['{{ token }} has spaces']);
    // Narrow Simple screen: above the list.
    await radio('simple').check();
    await page.setViewportSize({ width: 375, height: 812 });
    const narrowPanel = await panel.boundingBox();
    const narrowZone = await page.locator('#zone-main').boundingBox();
    assert.ok(narrowPanel.y + narrowPanel.height <= narrowZone.y, 'narrow screen: the panel is above the list');
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  checks.push('Variables: panel lists globals, data file columns and extracted values (beside the list in wide Simple, above it when narrow, above the editor in Advanced, folds away); chips one Tab stop with arrows, click copies, drag inserts; {{ in a URL, body or global header opens suggestions (aria-controls/activedescendant), filter, arrows wrap, Enter/Tab/click insert and close, Escape closes only that list, a value the request takes itself is marked; warnings for a later value and spaces, cleared by moving the request, "not available" when its source is off, reason written out in an open card');

  // Test data page, goals in Load & goals, step summaries (stage 5).
  {
    await page.setViewportSize({ width: 1440, height: 900 });
    await radio('simple').check();
    const project = {
      schemaVersion: 2,
      scenario: {
        groups: [{ id: 'grp_a', name: 'Checkout', enabled: true }],
        requests: [
          { id: 'req_login', name: 'Log in', type: 'http', method: 'POST', url: '{{base_url}}/login', body: '{"e":"{{email}}"}' },
          { id: 'req_buy', name: 'Buy', type: 'http', method: 'GET', url: '{{base_url}}/buy', groupId: 'grp_a' },
          { id: 'req_off', name: 'Off', type: 'http', method: 'GET', url: '{{base_url}}/off', enabled: false },
        ],
      },
      variables: [{ key: 'base_url', value: 'https://fixture.test' }, { key: 'unused', value: 'x' }],
      globalHeaders: [{ key: 'Accept', value: 'application/json' }],
      dataSets: [],
      load: { mode: 'simple', vus: '3', duration: '20s' },
      thresholds: { p95: '500', errorRate: '' },
    };
    await page.evaluate(async config => (await import('/js/project-io.js')).applyConfig(config), project);
    const summaries = () => page.locator('#simple-nav .nav-link small').allTextContents();
    await page.waitForFunction(() => document.querySelector('#step-summary-flow').textContent.startsWith('3 requests'));
    assert.deepEqual(await summaries(), [
      '3 requests · 1 group · 1 off', '2 variables · 1 shared header', '3 users · 20s · 1 goal', 'Not run yet',
    ]);
    assert.equal(await page.locator('#simple-nav [data-view="data"] .step-optional').textContent(), 'Optional');

    // One page, three folding blocks; "Used in" counts requests that run.
    await page.locator('#simple-nav [data-view="data"]').click();
    assert.equal(await page.locator('#page-title').textContent(), 'Test data');
    for (const id of ['#data-block-vars', '#data-block-headers', '#data-block-datafiles']) {
      assert.equal(await page.locator(id).isVisible(), true, id);
    }
    assert.deepEqual(await page.locator('#global-vars-list .var-used').allTextContents(), ['Used in 2 requests', 'Not used yet']);
    assert.deepEqual(await page.locator('#view-data .view-block-sum').allTextContents(),
      ['2 variables', '1 header, sent with every request', 'None yet']);
    const foldVars = page.locator('#data-block-vars .view-block-toggle');
    await foldVars.click();
    assert.equal(await foldVars.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#data-block-vars-body').isVisible(), false);
    await page.locator('#global-headers-list .h-key').first().focus();
    assert.equal(await page.locator('#data-block-headers-body').isVisible(), true, 'folding one block leaves the others');

    // Advanced: one block per category, always open; a folded Simple block stays folded.
    await radio('advanced').check();
    await nav('vars').click();
    assert.equal(await page.locator('#data-block-vars-body').isVisible(), true, 'Advanced never shows a folded block');
    assert.equal(await page.locator('#view-data > .view-block:visible').count(), 1);
    assert.equal(await page.locator('#data-block-vars .view-block-toggle').isVisible(), false);
    await nav('sla').click();
    assert.equal(await page.locator('#page-title').textContent(), 'Thresholds / SLA');
    assert.equal(await page.locator('#load-block-goals').isVisible(), true);
    assert.equal(await page.locator('#load-block-load').isVisible(), false);
    await nav('load').click();
    assert.equal(await page.locator('#load-block-goals').isVisible(), false);
    await radio('simple').check();
    assert.equal(await page.locator('#page-title').textContent(), 'Load & goals');
    assert.equal(await page.locator('#load-block-load').isVisible(), true);
    assert.equal(await page.locator('#load-block-goals').isVisible(), true, 'Simple: load and goals on one page');
    assert.equal(await page.locator('#load-goals-sum').textContent(), '1 goal');
    await page.locator('#errorRate').fill('1');
    // An opened project's load counts as custom: the preset asks before replacing it.
    page.once('dialog', dialog => dialog.accept());
    await page.locator('.preset-btn[data-preset="smoke"]').click();
    await page.waitForFunction(() => document.querySelector('#step-summary-load').textContent === 'Smoke · 1 user · 30s · 2 goals');

    // A link to one block opens the page there and unfolds it.
    await page.locator('#simple-nav [data-view="flow"]').click();
    await page.locator('.flow-vars-link', { hasText: 'Variables' }).click();
    assert.equal(await foldVars.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('#data-block-vars-body').isVisible(), true);

    // CSV files: dropped on the zone (one card each, a non-CSV refused), on a card (asks first),
    // chosen with the picker; share and end of rows as sentences, File options folded.
    const drop = async (selector, files) => page.locator(selector).evaluate((zone, list) => {
      const transfer = new DataTransfer();
      for (const { name, type, text } of list) transfer.items.add(new File([text], name, { type }));
      for (const type of ['dragenter', 'dragover', 'drop']) {
        zone.dispatchEvent(new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }));
      }
    }, files);
    await drop('#data-files-drop', [
      { name: 'users.csv', type: 'text/csv', text: 'email,password\nu1@x.test,p1\nu2@x.test,p2\n' },
      { name: 'photo.png', type: 'image/png', text: 'x' },
    ]);
    const firstCard = page.locator('#data-files-list .data-file-card').first();
    await page.waitForFunction(() => document.querySelectorAll('#data-files-list .data-file-card').length === 1
      && document.querySelector('.data-file-card .df-status').textContent.startsWith('2 rows'));
    assert.match(await page.locator('#data-files-drop-status').textContent(), /Added "users\.csv"\. "photo\.png" is not a CSV file/);
    assert.equal(await page.locator('#data-files-drop-title').textContent(), 'Drag another .csv file here');
    assert.equal(await firstCard.locator('.df-options').getAttribute('open'), null, 'File options start folded');
    assert.equal(await firstCard.locator('.df-share option:checked').textContent(), 'the next row (no two iterations share one)');
    assert.equal(await firstCard.locator('.df-pick').textContent(), 'Replace file…');
    assert.equal(await firstCard.locator('.help-btn[data-help="dataFileShare"]').count(), 1);
    assert.equal(await page.locator('#data-block-datafiles-sum').textContent(), '1 file · one row per iteration');
    assert.deepEqual(await page.locator('#global-vars-list .var-used').allTextContents(), ['Used in 2 requests', 'Not used yet']);
    let asked = '';
    page.once('dialog', dialog => { asked = dialog.message(); dialog.dismiss(); });
    await drop('#data-files-list .data-file-card', [{ name: 'other.csv', type: 'text/csv', text: 'a\n1\n' }]);
    assert.match(asked, /Replace the rows of "users\.csv" with "other\.csv"\?/);
    assert.match(await firstCard.locator('.df-status').textContent(), /^2 rows/, 'Cancel keeps the rows');
    // A file without a header row: no column, so File options open themselves.
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#choose-data-file').click()]);
    await chooser.setFiles({ name: 'ids.csv', mimeType: 'text/csv', buffer: Buffer.from('1\n2\n') });
    const second = page.locator('#data-files-list .data-file-card').nth(1);
    await second.locator('.df-skip-header').waitFor({ state: 'attached' });
    await second.locator('.df-skip-header').uncheck();
    assert.equal(await second.locator('.df-options').getAttribute('open'), '', 'rows without a usable column open File options');
    // A file dropped outside a drop zone does not leave the page.
    const prevented = await page.locator('#view-data').evaluate(view => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['x'], 'stray.csv', { type: 'text/csv' }));
      const event = new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true });
      view.dispatchEvent(event);
      return event.defaultPrevented;
    });
    assert.equal(prevented, true);
    assert.equal(await page.locator('#data-files-list .data-file-card').count(), 2);
    assert.match((await summaries())[1], /2 CSV files/);
    await page.screenshot({ path: resolve(output, 'stage5-test-data-1440.png'), fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({ path: resolve(output, 'stage5-test-data-375.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  checks.push('Test data: one page with Variables, Shared headers and CSV data files (folding in Simple, one open block per category in Advanced); "Used in" per variable; CSV dropped on the zone (one card each, non-CSV refused with a reason), on a card (asks first, Cancel keeps rows), or chosen; share and end of rows as sentences, File options folded until a file has no usable column; a stray file drop is caught. Pass/fail goals inside Load & goals (Thresholds / SLA in Advanced). Each Simple step says what it holds and updates as values change');

  assert.deepEqual(forbidden, []);
  assert.deepEqual(errors, []);
  const result = { checks, layouts, generated, errors, forbidden, nativeZoomTested: false, realRunTested: false };
  console.log(JSON.stringify(result, null, 2));
  await writeFile(resolve(output, 'verification.json'), JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
}
