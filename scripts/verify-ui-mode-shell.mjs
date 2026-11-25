// Real browser shell checks. Nothing leaves 127.0.0.1: the page may only reach K6UI,
// and the only k6 this runs is stage 8's Send once, whose request must resolve to the
// local target started below (any other host is refused before it reaches the server).
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from '../server/index.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = resolve('.hermes/plans/k6ui-ui-revamp-preview/stage2');
await mkdir(output, { recursive: true });
const server = createServer({ port: 0, host: '127.0.0.1' });
let browser;
const errors = [], forbidden = [], checks = [], layouts = [], sendOnceTargets = [];
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
    // Send once: the request it sends must resolve to 127.0.0.1 (stage 8).
    if (url.pathname === '/api/send-once') {
      const { config, requestId } = route.request().postDataJSON();
      const request = config.scenario.requests.find(item => item.id === requestId);
      const values = Object.fromEntries((config.variables || []).map(variable => [variable.key, variable.value]));
      const target = String(request?.url || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => values[name] ?? match);
      let host = '';
      try { host = new URL(target).hostname; } catch { /* not a URL */ }
      sendOnceTargets.push(target);
      if (host !== '127.0.0.1') {
        forbidden.push(`Send once to ${target}`);
        return route.abort();
      }
    }
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
  await page.locator('.req-card .req-tab[data-tab="body"]').click();
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
  // Advanced always shows the custom load editor: the kind of load and its fields.
  assert.equal(await page.locator('#load-kind').isVisible(), true);
  await page.locator('#vus').fill('7');
  await page.locator('#duration').fill('17s');
  await radio('simple').check();
  await radio('advanced').check();
  assert.equal(await page.locator('#vus').inputValue(), '7');
  assert.equal(await page.locator('#duration').inputValue(), '17s');
  assert.equal(await page.locator('#load-kind').inputValue(), 'simple');
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
  // The project as typed is the browser draft (draft.js), kept apart from the mode.
  await radio('simple').check();
  const cardsBefore = await page.locator('.req-card').count();
  assert.ok(cardsBefore > 0);
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('k6ui.draft') || 'null')?.project?.scenario?.requests
    ?.some(request => request.url === 'https://fixture.test/changed'));
  assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).sort()), ['k6ui.draft', 'k6ui.uiMode']);
  assert.equal(await page.evaluate(() => localStorage.getItem('k6ui.uiMode')), 'simple');
  assert.equal(await page.evaluate(() => 'uiMode' in JSON.parse(localStorage.getItem('k6ui.draft')).project), false, 'The mode is not part of the draft project');
  // A refresh brings the project back; the k6 Script view (open before the refresh) reopens on Build Flow.
  await page.reload(); await ready(); await active('simple', 'flow', 'flow');
  assert.equal(await page.locator('.req-card').count(), cardsBefore, 'Refresh restores the project from the browser draft');
  assert.equal(await page.locator('#reqs-main .req-card .url').first().inputValue(), 'https://fixture.test/changed');
  assert.equal(await page.locator('#draft-status').textContent(), 'Restored from your last visit');
  // New: asks first, then a fresh page with no draft.
  let newAsked = '';
  page.once('dialog', dialog => { newAsked = dialog.message(); return dialog.accept(); });
  await Promise.all([page.waitForEvent('load'), page.locator('#new-project-btn').click()]);
  await ready(); await active('simple', 'flow', 'flow');
  assert.match(newAsked, /Start a new, empty project\?/);
  assert.equal(await page.locator('.req-card').count(), 0, 'New starts an empty project');
  assert.deepEqual(await page.evaluate(() => Object.entries(localStorage)), [['k6ui.uiMode', 'simple']]);
  assert.equal(await page.locator('#draft-status').isHidden(), true);
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
  checks.push('Mode enum and project draft stored apart; refresh restores the project, New clears it; invalid/get/read/write failures remain usable');

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
    const smokeHelp = page.locator('.load-goal-item [data-help="smoke"]');
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
    assert.equal(await page.locator('.load-goal[data-goal="smoke"]').getAttribute('aria-pressed'), 'false', 'A help click does not pick the goal');
    assert.equal(await page.locator('.load-goal[aria-pressed="true"]').getAttribute('data-goal'), 'custom');
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
    await imported.locator('.req-tab[data-tab="extractions"]').click();
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

  // Request editor: a Postman-style tab bar, one part at a time, "Wait after" in Settings.
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
    const shownTab = id => cardOf(id).locator('.req-section:not([hidden])').evaluateAll(nodes => nodes.map(node => node.dataset.tab));
    const marked = id => cardOf(id).locator('.req-tab:is(:has(.section-count.visible), :has(.req-tab-dot:not([hidden])))')
      .evaluateAll(nodes => nodes.map(node => node.dataset.tab));
    const focusedTab = () => page.evaluate(() => document.activeElement?.dataset.tab || '');
    const redeem = cardOf('req_e');
    assert.equal(await redeem.locator('[role="tablist"]').count(), 1, 'one tab bar');
    assert.deepEqual(await redeem.locator('[role="tab"]').evaluateAll(nodes => nodes.map(node => node.textContent.trim())),
      ['Headers', 'Body', 'Checks1', 'Extract', 'Save CSV', 'Outcomes', 'Scripts', 'Settings']);
    assert.deepEqual(await shownTab('req_e'), ['body'], 'a POST opens on Body');
    assert.ok((await marked('req_e')).includes('checks'), 'a part the request uses marks its tab');
    assert.equal(await redeem.locator('[role="tab"][aria-selected="true"]').getAttribute('data-tab'), 'body');
    assert.equal(await redeem.locator('.req-tab[data-tab="body"]').getAttribute('aria-controls'),
      await redeem.locator('.req-section-body').getAttribute('id'), 'tab and panel point at each other');

    // Tabs by keyboard: Arrow Right / Left, Home and End move and select (roving tabindex).
    await redeem.locator('.req-tab[data-tab="body"]').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await focusedTab(), 'checks');
    assert.deepEqual(await shownTab('req_e'), ['checks']);
    assert.equal(await redeem.locator('.req-tab[tabindex="0"]').count(), 1);
    await page.keyboard.press('End');
    assert.equal(await focusedTab(), 'settings');
    assert.equal(await redeem.locator('.sleep').inputValue(), '0.5', '"Wait after" holds the saved pause');
    assert.equal(await redeem.locator('.req-wait label [data-help]').count(), 0, 'help sits beside the label, not inside');
    assert.equal(await redeem.locator('.req-section-settings [data-help="pause"]').count(), 1);
    await page.keyboard.press('Home');
    assert.equal(await focusedTab(), 'headers');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await focusedTab(), 'settings', 'Arrow Left wraps to the last tab');

    // Checks: Success statuses above the response checks; no status templates.
    await redeem.locator('.req-tab[data-tab="checks"]').click();
    assert.deepEqual(await redeem.locator('.req-section-checks .req-part-title').allInnerTexts(), ['Success statuses', 'Response checks']);
    assert.deepEqual(await redeem.locator('.req-panel[data-panel="assertions"] .check-template-btn strong').allInnerTexts(), ['Response contains', 'Response time']);
    assert.match(await redeem.locator('.req-section-scripts .tag-advanced').textContent(), /Advanced/i);

    // A GET with the automatic status check off: opens on Headers, the Checks tab has a dot.
    await cardOf('req_f').locator('.req-card-head').click();
    assert.deepEqual(await shownTab('req_f'), ['headers']);
    assert.ok((await marked('req_f')).includes('checks'));
    await cardOf('req_f').locator('.req-tab[data-tab="checks"]').click();
    assert.equal(await cardOf('req_f').locator('.check-status').isChecked(), false);
    await cardOf('req_f').locator('.req-tab[data-tab="body"]').click();
    assert.match(await cardOf('req_f').locator('.req-body-note').innerText(), /A GET request sends no body/);
  }
  checks.push('Request editor: one tab bar (tab/tabpanel roles linked), POST opens on Body and GET on Headers, Arrow/Home/End by keyboard with a roving tabindex, tabs in use show a count or a dot, Checks holds Success statuses then the response checks (no status templates), "Wait after" in Settings beside its help');

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
    await page.locator('#goal-error-on').check();
    // An opened project's load counts as custom: the preset asks before replacing it.
    page.once('dialog', dialog => dialog.accept());
    await page.locator('.load-goal[data-goal="smoke"]').click();
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

  // Load & goals: a question with five goals, a sentence, a short race burst, goals as sentences (stage 6).
  {
    await page.setViewportSize({ width: 1440, height: 900 });
    await radio('simple').check();
    const project = {
      schemaVersion: 2,
      scenario: {
        groups: [],
        requests: [
          { id: 'req_login', name: 'Log in', type: 'http', method: 'POST', url: 'https://fixture.test/login' },
          {
            id: 'req_redeem', name: 'Redeem', type: 'http', method: 'POST', url: 'https://fixture.test/redeem',
            outcomes: { rules: [{ label: 'success', status: '200', source: 'none' }], fallback: 'other' },
          },
        ],
      },
      variables: [], globalHeaders: [], dataSets: [],
      load: { mode: 'iterations', vus: '4', iterations: '2', maxDuration: '10m' },
      thresholds: { p95: '', errorRate: '' },
    };
    const open = config => page.evaluate(async value => (await import('/js/project-io.js')).applyConfig(value), config);
    const collect = () => page.evaluate(async () => structuredClone((await import('/js/config.js')).collectConfig()));
    const script = async config => (await (await page.request.post(`${origin}/api/generate`, { data: config })).json()).script;
    const pressed = () => page.locator('.load-goal[aria-pressed="true"]').getAttribute('data-goal');
    const sentence = () => page.locator('#load-shape-summary').textContent();
    await open(project);
    const opened = await collect();
    await page.locator('#simple-nav [data-view="load"]').click();
    assert.equal(await page.locator('#load-goal-title').textContent(), 'What do you want to find out?');
    assert.deepEqual(await page.locator('.load-goal').evaluateAll(cards => cards.map(card => card.dataset.goal)),
      ['smoke', 'load', 'stress', 'race', 'custom']);
    assert.equal(await page.locator('.load-goal[data-goal="smoke"] .load-goal-badge').textContent(), 'Start here');
    // An opened project counts as Custom; its kind of load and its sentence are shown.
    assert.equal(await pressed(), 'custom');
    assert.equal(await page.locator('#load-settings-title').textContent(), 'Custom settings');
    assert.equal(await page.locator('#load-kind').inputValue(), 'iterations');
    assert.equal(await page.locator('#load-kind').isVisible(), true);
    await page.waitForFunction(() => document.querySelector('#load-shape-summary').textContent.startsWith('4 users'));
    assert.equal(await sentence(), '4 users each run your 2 requests 2 times (8 runs in total), then stop.');
    assert.deepEqual(await page.locator('.load-stats dt').allTextContents(), ['Most users at once', 'Length', 'Kind']);
    assert.equal(await page.locator('#load-mode-name').textContent(), 'Iterations');
    // Threshold switches: an empty project goal is off, the input is disabled with a common value.
    assert.equal(await page.locator('#goal-p95-on').isChecked(), false);
    assert.equal(await page.locator('#p95').isDisabled(), true);
    assert.equal(await page.locator('#p95').inputValue(), '500');
    assert.equal(await page.locator('#errorRate').inputValue(), '1');
    assert.deepEqual(opened.thresholds, { p95: '', errorRate: '' }, 'off = "" (not used)');
    assert.equal(await page.locator('#load-goals-sum').textContent(), 'None yet');
    // Nothing changed by showing the page: the same config and the same script.
    const openedScript = await script(opened);
    assert.deepEqual(await collect(), opened);
    assert.equal(await script(await collect()), openedScript, 'opening the page changes nothing that runs');
    const saved = (load, keys) => Object.fromEntries(keys.map(key => [key, load[key]]));
    assert.deepEqual(saved(opened.load, Object.keys(project.load)), project.load, 'the load as saved');

    // A preset asks first (opened values count as custom); Cancel keeps everything.
    let asked = 0;
    page.once('dialog', dialog => { asked += 1; dialog.dismiss(); });
    await page.locator('.load-goal[data-goal="smoke"]').click();
    assert.equal(asked, 1);
    assert.equal(await pressed(), 'custom');
    assert.deepEqual(await collect(), opened, 'Cancel keeps the opened load');
    page.once('dialog', dialog => { asked += 1; dialog.accept(); });
    await page.locator('.load-goal[data-goal="smoke"]').click();
    assert.equal(asked, 2);
    assert.equal(await pressed(), 'smoke');
    assert.equal(await page.locator('#load-settings-title').textContent(), 'Smoke settings');
    assert.equal(await page.locator('#load-kind').isVisible(), false, 'Simple: a preset hides the kind of load');
    assert.equal(await page.locator('#stages').isVisible(), true);
    assert.deepEqual(saved((await collect()).load, ['mode', 'stages']), { mode: 'stages', stages: [{ duration: '30s', target: '1' }] }, 'the same Smoke preset as before');
    await page.waitForFunction(() => document.querySelector('#load-shape-summary').textContent.startsWith('1 user runs'));
    assert.equal(await sentence(), '1 user runs your 2 requests over and over for 30s. If anything fails here, fix it before adding load.');
    assert.equal(await page.locator('#step-summary-load').textContent(), 'Smoke · 1 user · 30s · no goals');
    // Preset to preset: no question (nothing typed since).
    await page.locator('.load-goal[data-goal="load"]').click();
    assert.equal(asked, 2);
    assert.equal(await pressed(), 'load');
    await page.waitForFunction(() => document.querySelector('#load-shape-summary').textContent.startsWith('Starts with'));
    assert.equal(await sentence(), 'Starts with 1 user, climbs to 10 users, then comes back down to 0. The whole test takes 5m.');
    await page.locator('#view-load').scrollIntoViewIfNeeded();
    await page.locator('#load-goal-title').evaluate(node => node.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: resolve(output, 'stage6-load-preset-1440.png') });
    const chartBefore = await page.locator('#load-chart').innerHTML();
    // Typing in a preset makes it Custom with the same values; the chart follows at once.
    await page.locator('#stages .stage-target').nth(1).fill('30');
    assert.equal(await pressed(), 'custom');
    assert.equal(await page.locator('#load-kind').inputValue(), 'stages');
    assert.equal(await page.locator('#load-kind').isVisible(), true);
    await page.waitForFunction(() => document.querySelector('#load-shape-summary').textContent.includes('30 users'));
    assert.notEqual(await page.locator('#load-chart').innerHTML(), chartBefore);
    assert.match(await page.locator('#step-summary-load').textContent(), /^up to 30 users · 5m/);
    // The kind of load inside Custom.
    await page.locator('#load-kind').selectOption('simple');
    assert.equal(await page.locator('#vus').isVisible(), true);
    assert.equal(await page.locator('#stages').isVisible(), false);
    await page.waitForFunction(() => document.querySelector('#load-shape-summary').textContent.includes('all starting at once'));

    // Race burst: request, users and timing in view; the rest under Advanced timing.
    await page.locator('.load-goal[data-goal="race"]').click();
    assert.equal(asked, 2, 'Race burst switches the mode, it does not replace values');
    assert.equal(await page.locator('#load-kind').isVisible(), false);
    for (const id of ['#race-request', '#race-vus', '#race-timing']) assert.equal(await page.locator(id).isVisible(), true, id);
    for (const id of ['#race-lead', '#race-warmup', '#race-warmup-path', '#race-fail-late', '#race-max-duration']) {
      assert.equal(await page.locator(id).isVisible(), false, `${id} folded`);
    }
    assert.equal(await page.locator('#race-advanced-sum').textContent(), '2000 ms lead time · warm-up on · a late VU is a warning · stops after 1h');
    assert.equal((await collect()).load.mode, 'race');
    await page.locator('#race-request').selectOption('req_redeem');
    await page.waitForFunction(() => document.querySelector('#load-shape-summary').textContent.includes('Redeem'));
    assert.match(await sentence(), /^10 users each run the requests before "Request 2 · .*Redeem.*" once, then send it at the same moment\.$/);
    await page.locator('#race-advanced-toggle').click();
    assert.equal(await page.locator('#race-advanced-toggle').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('#race-lead').isVisible(), true);
    assert.equal(await page.locator('#race-advanced-sum').isVisible(), false);
    await page.locator('#race-fail-late').check();
    await page.locator('#race-advanced-toggle').click();
    assert.equal(await page.locator('#race-lead').isVisible(), false);
    assert.match(await page.locator('#race-advanced-sum').textContent(), /a late VU fails the run/);
    assert.equal((await collect()).load.race.failIfLate, true);
    await page.screenshot({ path: resolve(output, 'stage6-load-race-1440.png'), fullPage: true });
    // Advanced: the custom editor is always open, Advanced timing included.
    await radio('advanced').check();
    await nav('load').click();
    assert.equal(await page.locator('#race-lead').isVisible(), true, 'Advanced shows the timing without a click');
    assert.equal(await page.locator('#race-advanced-toggle').isVisible(), false);
    await radio('simple').check();
    assert.equal(await page.locator('#race-lead').isVisible(), false, 'Simple keeps its own folded state');

    // Goals as sentences: a switch turns a goal on; off writes "" again.
    await page.locator('#goal-p95-on').check();
    assert.equal(await page.locator('#p95').isDisabled(), false);
    assert.equal((await collect()).thresholds.p95, '500');
    await page.locator('#p95').fill('300');
    await page.locator('#goal-error-on').check();
    assert.deepEqual((await collect()).thresholds, { p95: '300', errorRate: '1' });
    await page.waitForFunction(() => document.querySelector('#load-goals-sum').textContent === '2 goals');
    await page.locator('#goal-error-on').uncheck();
    assert.equal((await collect()).thresholds.errorRate, '', 'a goal switched off is not used');
    assert.equal(await page.locator('#errorRate').inputValue(), '1', 'its number stays as a suggestion');
    // Advanced shows the k6 expression of each goal.
    assert.equal(await page.locator('#goal-p95-tech').isVisible(), false);
    await radio('advanced').check();
    await nav('sla').click();
    assert.equal(await page.locator('#goal-p95-tech').textContent(), 'p(95)<300');
    assert.equal(await page.locator('#goal-error-tech').textContent(), 'not used');
    await radio('simple').check();
    // "+ Add goal" → a count of a response label (outcome target).
    assert.equal(await page.locator('#outcome-targets').isVisible(), false, 'no target, no list');
    await page.locator('#add-goal-btn').click();
    assert.equal(await page.locator('#add-goal-menu').isVisible(), true);
    assert.equal(await page.locator('#outcome-targets-empty').isVisible(), false, 'a request has labels');
    await page.locator('#add-outcome-target').click();
    assert.equal(await page.locator('#add-goal-menu').isVisible(), false);
    assert.equal(await page.locator('#outcome-targets').isVisible(), true);
    assert.equal(await page.locator('#outcome-targets-list .outcome-target-row').count(), 1);
    assert.equal(await page.locator('.outcome-target-request').inputValue(), 'req_redeem', 'one request with labels is chosen for you');
    await page.locator('.outcome-target-label').selectOption('success');
    await page.locator('.outcome-target-value').fill('1');
    assert.deepEqual((await collect()).thresholds.outcomes, [{ request: 'req_redeem', label: 'success', op: '<=', value: '1' }]);
    await page.locator('#outcome-targets-list .row-remove').click();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'add-goal-btn', 'removing the last target returns to Add goal');
    // Keyboard: the menu opens on its item, Escape closes it.
    await page.locator('#add-goal-btn').press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'add-outcome-target');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#add-goal-menu').isVisible(), false);

    // A saved project with goals opens with the switches on, the same values, the same script.
    const withGoals = { ...project, load: { mode: 'stages', stages: [{ duration: '10s', target: '2' }] }, thresholds: { p95: '800', errorRate: '2' } };
    await open(withGoals);
    await page.locator('#simple-nav [data-view="load"]').click();
    assert.equal(await page.locator('#goal-p95-on').isChecked(), true);
    assert.equal(await page.locator('#p95').inputValue(), '800');
    assert.equal(await page.locator('#goal-error-on').isChecked(), true);
    assert.equal(await pressed(), 'custom');
    assert.deepEqual((await collect()).thresholds, withGoals.thresholds, 'the goals as saved');
    assert.deepEqual(saved((await collect()).load, ['mode', 'stages']), withGoals.load);
    const race = { ...project, load: { mode: 'race', vus: '3', maxDuration: '1h', race: { request: 'req_redeem', timing: 'together', spreadMs: '100', offsets: '', leadMs: '3000', warmup: true, warmupPath: '/', failIfLate: false } } };
    await open(race);
    assert.equal(await pressed(), 'race', 'a race project opens on Race burst');
    assert.match(await page.locator('#race-advanced-sum').textContent(), /^3000 ms lead time/);
    assert.deepEqual(saved((await collect()).load, Object.keys(race.load)), race.load, 'the race as saved');
    assert.match(await script(await collect()), /"?leadMs"?:\s*3000\b/);
    await page.locator('#simple-nav [data-view="load"]').click();
    await page.screenshot({ path: resolve(output, 'stage6-load-1440.png'), fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, '375 px: no sideways scroll');
    await page.screenshot({ path: resolve(output, 'stage6-load-375.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  checks.push('Load & goals: "What do you want to find out?" with five goals (Smoke marked Start here); an opened project is Custom (Race burst for a race) and a preset asks first, Cancel keeps it; presets write the same staged loads; typing in a preset makes it Custom; the kind of load sits in Custom (always shown in Advanced); a plain sentence and the chart change at once; race burst shows request, users and timing, the rest folded under Advanced timing with a summary (always open in Advanced); goals as sentences with switches, off = "", common values as suggestions, k6 expression in Advanced; outcome targets from Add goal (mouse and keyboard); opened projects give the same script');

  // Run & Results: the check before a run, the recording options there, the run in plain words (stage 7).
  // /api/run never reaches the server: this page answers it with a recorded SSE stream (no k6 runs).
  {
    await page.setViewportSize({ width: 1440, height: 900 });
    await radio('simple').check();
    const open = config => page.evaluate(async value => (await import('/js/project-io.js')).applyConfig(value), config);
    const collect = () => page.evaluate(async () => structuredClone((await import('/js/config.js')).collectConfig()));
    const results = () => page.locator('#simple-nav [data-view="results"]').click();
    const requests = [
      { id: 'req_me', name: 'Profile', type: 'http', method: 'GET', url: '{{base_url}}/me', headers: [{ key: 'Authorization', value: 'Bearer {{token}}' }] },
      { id: 'req_login', name: 'Log in', type: 'http', method: 'POST', url: '{{base_url}}/login', body: '{}', extractions: [{ varName: 'token', source: 'json', selector: 'token' }] },
      { id: 'req_pay', name: 'Pay', type: 'http', method: 'POST', url: '{{base_url}}/pay', body: '{}' },
    ];
    const risky = {
      schemaVersion: 2, scenario: { groups: [], requests },
      variables: [{ key: 'base_url', value: 'https://api.shop.example' }], globalHeaders: [], dataSets: [],
      load: { mode: 'simple', vus: '10', duration: '30s' }, thresholds: { p95: '', errorRate: '' },
    };
    const checklist = () => page.locator('#prerun-checklist > li').evaluateAll(items => items.map(item => `${item.dataset.check}:${item.className.split(' ').pop()}`));
    await open(risky);
    await results();
    assert.equal(await page.locator('#prerun').evaluate(details => details.open), true, 'Before you run is open before a run');
    assert.deepEqual(await checklist(), ['variables:bad', 'target:warn', 'goals:warn']);
    assert.equal(await page.locator('#prerun-headline').textContent(), '3 things to look at');
    assert.match(await page.locator('#prerun-checklist [data-check="variables"]').textContent(), /\{\{token\}\} not available yet in "Profile"/);
    assert.match(await page.locator('#prerun-checklist [data-check="target"]').textContent(), /api\.shop\.example.*not production/);
    assert.equal(await page.locator('#prerun-requests').textContent(), '3 will run');
    assert.equal(await page.locator('#prerun-target').textContent(), 'api.shop.example');
    assert.equal(await page.locator('#prerun-goals').textContent(), 'None');
    assert.match(await page.locator('#prerun-load').textContent(), /^10 users run your 3 requests over and over for 30s/);
    // Each open item leads to the place that fixes it.
    await page.locator('#prerun-checklist [data-check="variables"] button').click();
    assert.equal(await page.locator('#page-title').textContent(), 'Build Flow');
    assert.equal(await page.locator('#reqs-main > .req-card[data-request-id="req_me"]').evaluate(card => card.classList.contains('expanded')), true, 'the request opens');
    await results();
    await page.locator('#prerun-checklist [data-check="target"] button').click();
    assert.equal(await page.locator('#page-title').textContent(), 'Test data');
    assert.equal(await page.locator('#data-block-vars').isVisible(), true);
    await results();
    await page.locator('#prerun-checklist [data-check="goals"] button').click();
    assert.equal(await page.locator('#load-block-goals').isVisible(), true);
    assert.equal(await page.locator('#load-block-goals').evaluate(block => block.getBoundingClientRect().top < innerHeight), true, 'the goals are in view');
    checks.push('Before you run: what will happen (requests, target, goals, the load sentence) and a checklist: {{token}} used before the request that takes it, a production-looking target, no goal (no smoke test item); each button opens the place that fixes it (the request, Test data → Variables, the goals)');

    // Fixed: order, a test host, goals on. Looking at the results view changes nothing that is sent.
    const fixed = { ...risky, scenario: { groups: [], requests: [requests[1], requests[0], requests[2]] },
      variables: [{ key: 'base_url', value: 'https://staging.shop.example' }], thresholds: { p95: '500', errorRate: '1' } };
    await open(fixed);
    const before = await collect();
    await results();
    assert.deepEqual(await checklist(), ['variables:ok', 'target:ok', 'goals:ok']);
    assert.equal(await page.locator('#prerun-goals').textContent(), '95% within 500 ms, less than 1% fail');
    // Recording options: before the run, no longer in the Requests tab.
    assert.equal(await page.locator('#prerun #log-requests').count(), 1);
    assert.equal(await page.locator('#tab-requests #log-requests').count(), 0);
    assert.deepEqual((await page.locator('.results-tab').allTextContents()).map(text => text.replace(/\s*\d+$/, '').trim()),
      ['Overview', 'Requests', 'Errors', 'Raw k6 output']);
    await page.locator('#results-tab-requests').click();
    await page.locator('#prerun').evaluate(details => { details.open = false; });
    await page.locator('#req-log-options').click();
    assert.equal(await page.locator('#prerun').evaluate(details => details.open), true, 'Recording options opens Before you run');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'log-requests');
    assert.deepEqual(await collect(), before, 'the results view never changes the project');
    await page.locator('#log-requests').check();
    await page.locator('#log-filter').selectOption('sample');
    assert.equal(await page.locator('#log-sample-every-field').isVisible(), true);
    const recorded = await collect();
    assert.deepEqual([recorded.options.logRequests, recorded.options.logFilter], [true, 'sample']);
    assert.deepEqual({ ...recorded, options: before.options }, before, 'only the recording options changed');
    await page.locator('#log-filter').selectOption('all');
    await page.locator('#results-tab-overview').click();
    checks.push('Recording options (record, filter, sample, hide secrets) live in Before you run, not the Requests tab; "Recording options" there opens and focuses them; the tabs are Overview, Requests, Errors, Raw k6 output (no Metrics); viewing the results never changes the project');

    // A recorded stream: one without `done` shows the live figures, one with `done` the reading.
    const sse = events => events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
    const record = (i, d, ok = true) => ({ vu: 1, it: 0, i, m: 'GET', url: `https://staging.shop.example/${i}`, s: ok ? 200 : 502, d, ok });
    const live = ['metrics', { vus: 4, requests: 120, requestRate: 12, durationAvg: 300, durationP95: 610, failedRate: 0.05 }];
    const summary = {
      metrics: {
        http_req_duration: { avg: 161, min: 41, med: 148, max: 902, 'p(90)': 271, 'p(95)': 312, thresholds: { 'p(95)<500': false } },
        http_req_failed: { passes: 6, fails: 1440, value: 6 / 1446, thresholds: { 'rate<0.01': true } },
        http_reqs: { count: 1446, rate: 48.2 }, iterations: { count: 482 }, vus_max: { value: 10, min: 10, max: 10 },
      },
      root_group: { name: '', path: '', groups: {}, checks: {
        a: { name: 'status 2xx: request 1', passes: 482, fails: 0 },
        b: { name: 'status 2xx: request 2', passes: 482, fails: 0 },
        c: { name: 'status 2xx: request 3', passes: 476, fails: 6 },
      } },
    };
    let stream = sse([['status', { message: 'Starting k6…' }], ['log', { line: 'running (0m01.0s)\n' }], live]);
    await page.route('**/api/run', route => route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: stream }));
    const cards = () => page.locator('#overview-metrics .result-card').evaluateAll(items => items.map(item => ({
      label: item.querySelector('.result-card-name').textContent, value: item.querySelector('.result-card-value').textContent,
      goal: item.querySelector('.result-card-goal').textContent, tech: item.querySelector('.result-card-tech').textContent,
      help: item.querySelector('.result-card-label > .help-btn')?.dataset.help,
    })));
    await page.locator('#prerun-run-btn').click();
    await page.waitForFunction(() => document.querySelectorAll('#overview-metrics .result-card').length === 4);
    assert.equal(await page.locator('#prerun').evaluate(details => details.open), false, 'Before you run folds when a run starts');
    const liveCards = await cards();
    assert.deepEqual(liveCards.map(card => [card.label, card.value, card.goal]), [
      ['95% of requests finished within', '610 ms', 'Goal: under 500 ms · over the goal so far'],
      ['Failed requests', '5%', 'Goal: less than 1% · over the goal so far'],
      ['Requests per second', '12', 'Average so far'],
      ['Users now', '4', '120 requests so far'],
    ]);
    assert.deepEqual(liveCards.map(card => card.help), ['p95', 'errorRate', 'throughput', 'vu'], '"?" beside each label');
    await page.waitForFunction(() => !document.querySelector('#results-run-btn').disabled);

    stream = sse([
      ['status', { message: 'Starting k6…' }], live,
      ...[[0, 80], [0, 90], [1, 120], [1, 140], [2, 400], [2, 450, false]].map(([i, d, ok]) => ['req-log', record(i, d, ok)]),
      ['log', { line: 'done\n' }],
      ['done', { code: 99, outcome: 'threshold-failed', summary }],
    ]);
    await page.locator('#results-run-btn').click();
    await page.waitForFunction(() => document.querySelector('#run-state').textContent === 'TARGETS NOT MET');
    assert.equal(await page.locator('#run-verdict-title').textContent(), 'Failed: a goal was missed');
    assert.match(await page.locator('#run-verdict-detail').textContent(), /^✓ 95% within 500 ms · ✕ less than 1% failed · 1,446 requests/);
    assert.deepEqual((await cards()).map(card => [card.label, card.value, card.goal, card.tech]), [
      ['95% of requests finished within', '312 ms', 'Goal: under 500 ms · met', 'http_req_duration p(95)'],
      ['Failed requests', '0.41%', 'Goal: less than 1% · missed', 'http_req_failed'],
      ['Requests per second', '48.2', 'Average over the run', 'http_reqs rate'],
      ['Most users at once', '10', '1,446 requests in total', 'vus_max'],
    ]);
    const perRequest = await page.locator('#run-per-request-rows > tr').evaluateAll(rows => rows.map(row => [...row.cells].slice(0, 5).map(cell => cell.textContent)));
    assert.deepEqual(perRequest, [
      ['1', 'Log in', '482', '0', '90 ms'],
      ['2', 'Profile', '482', '0', '140 ms'],
      ['3', 'PaySlowest', '482', '6 (1.2%)', '450 ms'],
    ]);
    assert.equal(await page.locator('#run-per-request-rows .badge-slowest').count(), 1);
    const next = await page.locator('#run-next-list > li').allTextContents();
    assert.match(next[0], /^"Pay" failed 6 times, more than your goal allows/);
    assert.match(next.at(-1), /"Pay" is the slowest request/);
    assert.equal(await page.locator('#run-all-metrics').isVisible(), true);
    await page.locator('#run-all-metrics > summary').click();
    assert.match(await page.locator('#run-metrics').textContent(), /p95 response.*Iterations/s);
    await page.locator('#run-next-list > li').first().getByRole('button', { name: 'Errors' }).click();
    assert.equal(await page.locator('.results-tab[aria-selected="true"]').getAttribute('data-tab'), 'errors');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'results-tab-errors');
    await page.locator('#results-tab-overview').click();
    assert.equal(await page.locator('#tab-overview .result-shortcuts').isVisible(), false, 'Simple: no shortcuts');
    await page.screenshot({ path: resolve(output, 'stage7-results-1440.png'), fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, '375 px: no sideways scroll');
    await page.screenshot({ path: resolve(output, 'stage7-results-375.png'), fullPage: true });
    await page.locator('#prerun').evaluate(details => { details.open = true; });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, '375 px: Before you run open, no sideways scroll');
    await page.screenshot({ path: resolve(output, 'stage7-prerun-375.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await radio('advanced').check();
    assert.deepEqual(await page.locator('#tab-overview .result-shortcuts button').allTextContents(), ['Inspect requests', 'Review errors', 'Raw k6 output']);
    await page.locator('#tab-overview .result-shortcuts [data-results-tab="live"]').click();
    assert.equal(await page.locator('.results-tab[aria-selected="true"]').textContent(), 'Raw k6 output');
    assert.match(await page.locator('#log-output').textContent(), /done/);
    await page.locator('#results-tab-overview').click();
    await page.screenshot({ path: resolve(output, 'stage7-results-advanced-1440.png'), fullPage: true });
    await radio('simple').check();
    checks.push('A run in plain words (recorded SSE, no k6): live cards "so far" against the goals; the verdict is a sentence (Failed: a goal was missed, ✓/✕ per goal); four cards with a plain name, "?", the value, the goal and k6\'s name; each request with sent/failed from its status check, times from the records and the slowest marked; What to do next with buttons (Errors opens and focuses the tab); All k6 metrics folded under the Overview; Advanced shortcuts Inspect requests / Review errors / Raw k6 output; 1440 + 375 px without sideways scroll');

    // A passing smoke run suggests a load test next; the checklist has no smoke item; Clear results opens Before you run again.
    stream = sse([['done', { code: 0, outcome: 'passed', summary: { ...summary, metrics: { ...summary.metrics,
      http_req_failed: { passes: 0, fails: 1446, value: 0, thresholds: { 'rate<0.01': false } } } } }]]);
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#simple-nav [data-view="load"]').click();
    await page.locator('.load-goal[data-goal="smoke"]').click();
    await results();
    assert.equal(await page.locator('#prerun-checklist [data-check="smoke"]').count(), 0);
    await page.locator('#prerun-run-btn').click();
    await page.waitForFunction(() => document.querySelector('#run-state').textContent === 'PASSED');
    assert.equal(await page.locator('#run-verdict-title').textContent(), 'Passed: your service handled 10 users and met every goal');
    assert.match((await page.locator('#run-next-list > li').allTextContents()).join(' '), /Try a load test/);
    await page.locator('#clear-results').click();
    assert.equal(await page.locator('#prerun').evaluate(details => details.open), true);
    assert.equal(await page.locator('#overview-metrics .result-card').count(), 0);
    assert.equal(await page.locator('#run-per-request').isVisible(), false);
    await page.unroute('**/api/run');
    checks.push('Smoke test: a passing run suggests a load test next and adds no checklist item; Clear results opens Before you run again and empties the reading');
  }

  // First run and Send once (stage 8). Send once runs k6 once per click against a
  // target on 127.0.0.1 started here (the route above refuses any other host).
  {
    const seen = [];
    const target = createHttpServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization || '', body });
        if (req.url === '/login') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ token: 'tok-123', user: { id: 7, roles: ['buyer', 'admin'] }, note: '<img src=x onerror="window.__k6uiXss=1">' }));
        } else if (req.url === '/me') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad token', got: req.headers.authorization || '' }));
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<b>not json</b>');
        }
      });
    });
    target.listen(0, '127.0.0.1');
    await once(target, 'listening');
    const base = `http://127.0.0.1:${target.address().port}`;
    const first = await context.newPage();
    try {
      await first.setViewportSize({ width: 1440, height: 900 });
      await first.goto(origin);
      await first.waitForFunction(() => document.querySelector('#reqs-main'));
      await first.locator('input[name="ui-mode"][value="simple"]').check();
      const screen = first.locator('#flow-empty-state');
      assert.equal(await screen.isVisible(), true, 'an empty project shows the first-run screen');
      assert.equal(await first.locator('#flow-first-title').textContent(), 'Start from');
      assert.equal(await first.locator('.first-step').count(), 0, 'no three-step lecture');
      assert.deepEqual(await first.locator('.first-start strong').allTextContents(),
        ['One blank request', 'A cURL command', 'Template: log in, then use the token', 'A k6 or JMeter file']);
      await first.screenshot({ path: resolve(output, 'stage8-first-run-1440.png'), fullPage: true });
      await first.setViewportSize({ width: 375, height: 812 });
      assert.equal(await first.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, '375 px: first run without sideways scroll');
      await first.screenshot({ path: resolve(output, 'stage8-first-run-375.png'), fullPage: true });
      await first.setViewportSize({ width: 1440, height: 900 });
      // One DOM: the same screen in Advanced.
      const node = await screen.elementHandle();
      await first.locator('input[name="ui-mode"][value="advanced"]').check();
      assert.equal(await screen.isVisible(), true);
      assert.equal(await first.evaluate(element => element === document.querySelector('#flow-empty-state'), node), true);
      await first.locator('input[name="ui-mode"][value="simple"]').check();
      // A k6 or JMeter file: the import dialog; Cancel brings focus back.
      await first.locator('#empty-import-file').click();
      assert.equal(await first.locator('#k6-import-modal').isVisible(), true);
      await first.locator('#k6-import-cancel').click();
      assert.equal(await first.evaluate(() => document.activeElement?.id), 'empty-import-file');
      // The template: two requests, the token passed on, variables added, the screen gone.
      await first.locator('#empty-template-login').click();
      assert.equal(await screen.isVisible(), false);
      assert.deepEqual(await first.locator('#reqs-main .req-card .request-name').evaluateAll(fields => fields.map(field => field.value)), ['Log in', 'Use the token']);
      const templated = await first.evaluate(async () => structuredClone((await import('/js/config.js')).collectConfig()));
      assert.deepEqual(templated.variables.map(variable => variable.key), ['base_url', 'username', 'password']);
      assert.deepEqual(templated.scenario.requests[0].extractions, [{ varName: 'token', source: 'json', selector: 'token' }]);
      assert.deepEqual(templated.scenario.requests[1].headers, [{ key: 'Authorization', value: 'Bearer {{token}}' }]);
      assert.equal(await first.locator('#flow-announcer').textContent(), 'Added two requests: Log in, then Use the token. Change base_url, username and password under Test data.');
      checks.push('First run: an empty project offers four starts, the same screen in Advanced; the k6/JMeter start opens the import dialog; the template adds Log in + Use the token with {{token}} passed on and base_url/username/password in Test data; 1440 + 375 px without sideways scroll');

      // Point base_url at the local target, then Send once on "Log in".
      await first.evaluate(value => {
        const row = [...document.querySelectorAll('#global-vars-list .var-row')].find(item => item.querySelector('.var-key').value === 'base_url');
        row.querySelector('.var-val').value = value;
        row.querySelector('.var-val').dispatchEvent(new Event('input', { bubbles: true }));
      }, base);
      const login = first.locator('#reqs-main .req-card').nth(0);
      assert.equal(await login.evaluate(card => card.classList.contains('expanded')), true);
      const sendButton = login.locator('.req-send-once');
      assert.equal(await sendButton.isVisible(), true);
      assert.equal(await sendButton.evaluate(button => button.nextElementSibling?.matches('[data-help="sendOnce"], .help-btn')), true, '"?" beside Send once');
      const before = await first.evaluate(async () => structuredClone((await import('/js/config.js')).collectConfig()));
      await sendButton.click();
      await login.locator('.so-status.ok').waitFor({ timeout: 30_000 });
      assert.equal(await login.locator('.so-status').textContent(), '200');
      assert.equal(seen.length, 1, 'one request reached the target');
      assert.equal(seen[0].method, 'POST');
      assert.equal(seen[0].url, '/login');
      assert.deepEqual(JSON.parse(seen[0].body), { username: 'test_user', password: 'change_me' });
      // Markup in the response is text: no element, nothing ran.
      assert.match(await login.locator('.so-body').textContent(), /<img src=x onerror=/);
      assert.equal(await login.locator('.send-once img').count(), 0);
      assert.equal(await first.evaluate(() => window.__k6uiXss), undefined);
      assert.equal(await login.locator('.so-note').textContent(), 'Click a value to take it for later requests.');
      // Values are buttons with one Tab stop; arrows move between them.
      const values = login.locator('.so-take');
      assert.deepEqual(await values.allTextContents(), ['"tok-123"', '7', '"buyer"', '"admin"', '"<img src=x onerror=\\"window.__k6uiXss=1\\">"']);
      assert.deepEqual(await values.evaluateAll(buttons => buttons.map(button => button.tabIndex)), [0, -1, -1, -1, -1]);
      await values.nth(0).focus();
      await first.keyboard.press('ArrowDown');
      assert.equal(await values.nth(1).evaluate(button => button === document.activeElement), true);
      // The token is already taken by the template; user.id becomes {{id}}.
      await values.nth(0).click();
      assert.equal(await login.locator('.so-live').textContent(), '{{token}} already takes token.');
      await values.nth(1).click();
      assert.match(await login.locator('.so-live').textContent(), /^Took user\.id as \{\{id\}\}\./);
      await values.nth(2).click();
      assert.match(await login.locator('.so-live').textContent(), /^Took user\.roles\[0\] as \{\{roles\}\}\./);
      const after = await first.evaluate(async () => structuredClone((await import('/js/config.js')).collectConfig()));
      assert.deepEqual(after.scenario.requests[0].extractions, [
        { varName: 'token', source: 'json', selector: 'token' },
        { varName: 'id', source: 'json', selector: 'user.id' },
        { varName: 'roles', source: 'json', selector: 'user.roles[0]' },
      ]);
      after.scenario.requests[0].extractions = before.scenario.requests[0].extractions;
      assert.deepEqual(after, before, 'Send once and taking values change nothing else');
      assert.equal(await login.locator('.req-tab[data-tab="extractions"] .section-count').innerText(), '3', 'the Extract tab counts the taken values');
      assert.match(await first.locator('#flow-vars').textContent(), /\{\{id\}\}/, 'the variables panel lists the taken value');
      await login.screenshot({ path: resolve(output, 'stage8-send-once-1440.png') });
      await first.setViewportSize({ width: 375, height: 812 });
      assert.equal(await first.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, '375 px: Send once response without sideways scroll');
      await login.locator('.send-once').screenshot({ path: resolve(output, 'stage8-send-once-375.png') });
      await first.setViewportSize({ width: 1440, height: 900 });
      checks.push('Send once (real k6, local target only): the open request is sent once with Test data values, the response is shown as text (markup never becomes an element), JSON values are buttons with one Tab stop and arrow keys; clicking one adds rows in the Extract tab (an existing path is reused, names never clash), the variables panel follows, and nothing else in the project changes; 1440 + 375 px without sideways scroll');

      // The second request sends {{token}} as typed (no earlier request ran) and says so.
      const profile = first.locator('#reqs-main .req-card').nth(1);
      await profile.locator('.request-expand').click();
      await profile.locator('.req-send-once').click();
      await profile.locator('.so-status.bad').waitFor({ timeout: 30_000 });
      assert.equal(await profile.locator('.so-status').textContent(), '401');
      assert.equal(seen.at(-1).authorization, 'Bearer {{token}}');
      assert.equal(await profile.locator('.so-unresolved').textContent(), '{{token}} has no value before this request, so it was sent as typed. In a run, an earlier request or Test data gives the value.');
      assert.equal(await profile.locator('.so-verdict').textContent(), 'Counts as a failure in a run.');
      await profile.locator('.so-sent > summary').click();
      assert.match(await profile.locator('.so-sent').textContent(), new RegExp(`GET ${base.replace(/\./g, '\\.')}/me`));

      // Advanced: the same card and response; a body that is not JSON is text only.
      const panelNode = await profile.locator('.send-once').elementHandle();
      await first.locator('input[name="ui-mode"][value="advanced"]').check();
      assert.equal(await first.evaluate(element => element.isConnected && !element.hidden, panelNode), true);
      await first.locator('#flow-outline .outline-item').nth(1).click();
      assert.equal(await first.evaluate(element => element === document.querySelectorAll('#reqs-main .req-card')[1].querySelector('.send-once'), panelNode), true);
      await profile.locator('.url').fill('{{base_url}}/page');
      await profile.locator('.req-send-once').click();
      await first.waitForFunction(() => /not JSON/.test(document.querySelectorAll('#reqs-main .req-card')[1].querySelector('.so-note').textContent));
      assert.equal(await profile.locator('.so-take').count(), 0);
      assert.equal(await profile.locator('.so-body').textContent(), '<b>not json</b>');
      assert.equal(await profile.locator('.send-once b').count(), 0);
      // Nothing listening: the error, and no response.
      target.close();
      await profile.locator('.req-send-once').click();
      await first.waitForFunction(() => document.querySelectorAll('#reqs-main .req-card')[1].querySelector('.so-status').textContent === 'No response');
      assert.match(await profile.locator('.so-error').textContent(), /refused/);
      await profile.locator('.so-close').click();
      assert.equal(await profile.locator('.send-once').isVisible(), false);
      assert.equal(await profile.locator('.req-send-once').evaluate(button => button === document.activeElement), true);
      await first.locator('input[name="ui-mode"][value="simple"]').check();
      assert.ok(sendOnceTargets.length >= 4 && sendOnceTargets.every(url => url.startsWith(`${base}/`)), 'Send once only went to the local target');
      checks.push('Send once on a request that needs {{token}}: sent as typed and said so, the failing status counts as a failure, "What was sent" shows the request; Advanced keeps the same card and response; a body that is not JSON stays text, a closed port gives the error; × closes the response and focus returns to Send once');
    } finally {
      target.close();
      await first.close();
    }
  }

  assert.deepEqual(forbidden, []);
  assert.deepEqual(errors, []);
  const result = { checks, layouts, generated, errors, forbidden, nativeZoomTested: false, realRunTested: false };
  console.log(JSON.stringify(result, null, 2));
  await writeFile(resolve(output, 'verification.json'), JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
}
