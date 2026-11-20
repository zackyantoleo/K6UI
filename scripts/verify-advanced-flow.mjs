// Stage 3: real browser checks for the Advanced flow outline + shared editor.
// Generation-only: k6 is never run and fixture targets are never contacted.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from '../server/index.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = resolve('.hermes/plans/k6ui-ui-revamp-preview/stage3');
await mkdir(output, { recursive: true });

const FIXTURE = {
  schemaVersion: 2,
  scenario: {
    groups: [
      { id: 'grp_auth', name: 'Auth', enabled: true, collapsed: true, headers: [{ key: 'X-Service', value: 'auth' }] },
      { id: 'grp_checkout', name: 'Checkout', enabled: true, collapsed: false, headers: [] },
      { id: 'grp_admin', name: 'Admin', enabled: false, collapsed: false, headers: [] },
    ],
    requests: [
      {
        id: 'req_login', name: 'Login', groupId: 'grp_auth', type: 'http', method: 'POST',
        url: 'https://api.example.test/session', headers: [{ key: 'Content-Type', value: 'application/json' }],
        body: '{"user":"{{user}}"}', extractions: [{ varName: 'token', source: 'json', selector: 'data.token' }],
        assertions: [{ type: 'status-eq', value: '200', value2: '' }], preScript: 'vars.ts = Date.now();',
        postScript: '', checkStatus: true, sleepAfter: '0.5',
      },
      { id: 'req_cart', name: 'Cart', groupId: 'grp_checkout', type: 'http', method: 'GET', url: 'https://api.example.test/cart' },
      { id: 'req_profile', name: 'Profile', groupId: 'grp_auth', type: 'http', method: 'GET', url: 'https://api.example.test/profile', enabled: false },
      {
        id: 'req_stock', name: 'Stock', groupId: 'grp_admin', type: 'grpc', method: 'GET', url: 'localhost:50051',
        grpcMethod: 'stock.Stock/Get', grpcPlaintext: true, body: '{"sku":"A1"}',
      },
    ],
  },
  variables: [{ key: 'user', value: 'demo' }],
  globalHeaders: [{ key: 'Accept', value: 'application/json' }],
  load: { mode: 'stages', stages: [{ duration: '10s', target: '2' }] },
  thresholds: { p95: '500', errorRate: '1' },
  options: { logRequests: false },
};

const server = createServer({ port: 0, host: '127.0.0.1' });
let browser, page;
const errors = [], forbidden = [], checks = [], layouts = [];
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
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('dialog', dialog => { errors.push(`Unexpected dialog: ${dialog.message()}`); dialog.dismiss(); });

  const radio = mode => page.locator(`input[name="ui-mode"][value="${mode}"]`);
  const card = id => page.locator(`#reqs-main > .req-card[data-request-id="${id}"]`);
  const group = id => page.locator(`#request-groups > .request-group[data-group-id="${id}"]`);
  const outlineRequest = id => page.locator(`#flow-outline .outline-request[data-id="${id}"]`);
  // A group split by other requests has one head per part; the first selects it too.
  const outlineGroup = id => page.locator(`#flow-outline .outline-group[data-id="${id}"]`).first();
  const outlineToggle = id => page.locator(`#flow-outline .outline-toggle[data-group-id="${id}"]`).first();
  const sectionOf = id => page.$eval(`#flow-outline .outline-request[data-id="${id}"]`,
    node => node.closest('.outline-section')?.dataset.groupId || '');
  const shownRows = async () => {
    await settle();
    return page.$$eval('#flow-outline .outline-request', nodes =>
      nodes.filter(node => node.getClientRects().length > 0).map(node => node.dataset.id));
  };
  const folded = id => group(id).evaluate(node => node.classList.contains('collapsed'));
  const settle = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => setTimeout(done, 0))));
  const rows = async () => {
    await settle();
    return page.$$eval('#flow-outline .outline-request', nodes => nodes.map(node => ({
      id: node.dataset.id, text: node.textContent.replace(/\s+/g, ' ').trim(), current: node.getAttribute('aria-current'),
    })));
  };
  const visibleCards = () => page.$$eval('#reqs-main > .req-card', cards =>
    cards.filter(card => card.getClientRects().length > 0).map(card => card.dataset.requestId));
  const cardOrder = () => page.$$eval('#reqs-main > .req-card', cards => cards.map(card => card.dataset.requestId));
  const collect = () => page.evaluate(async () => structuredClone((await import('/js/config.js')).collectConfig()));
  const generate = config => page.evaluate(async body => (await (await fetch('/api/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })).json()).script, config);
  const selectedIds = async () => (await rows()).filter(row => row.current === 'true').map(row => row.id);
  const openProject = fixture => page.evaluate(async project =>
    (await import('/js/project-io.js')).applyConfig(project), fixture);

  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('#reqs-main'));
  // A first visit is Simple; this check is about the Advanced layout.
  await page.locator('input[name="ui-mode"][value="advanced"]').check();
  assert.equal(await page.locator('#flow-outline').isVisible(), true, 'Advanced shows the outline');
  assert.equal(await page.locator('#flow-outline .outline-request').count(), 0);
  assert.equal(await page.locator('#flow-outline .outline-empty').isVisible(), true);
  await openProject(FIXTURE);

  // 1. Outline mirrors stable IDs and global order; requests sit inside their
  // group, one head per run of that group (as the script runs it).
  let list = await rows();
  assert.deepEqual(list.map(row => row.id), ['req_login', 'req_cart', 'req_profile', 'req_stock']);
  for (const [index, expected] of [['#1', 'POST', 'Login'], ['#2', 'GET', 'Cart'],
    ['#3', 'GET', 'Profile', 'Disabled'], ['#4', 'gRPC', 'Stock', 'Group off']].entries()) {
    for (const text of expected) assert.ok(list[index].text.includes(text), `${list[index].text} includes ${text}`);
  }
  assert.deepEqual(await Promise.all(list.map(row => sectionOf(row.id))), ['grp_auth', 'grp_checkout', 'grp_auth', 'grp_admin']);
  assert.deepEqual(await selectedIds(), ['req_login'], 'Opening a project selects its first request');
  assert.deepEqual(await visibleCards(), ['req_login'], 'Selected card shows although its group is collapsed');
  assert.deepEqual(await page.$$eval('#flow-outline .outline-group', nodes => nodes.map(node => [node.dataset.id, node.textContent.replace(/\s+/g, ' ').trim()])), [
    ['grp_auth', 'Auth Part 1 of 2 1'], ['grp_checkout', 'Checkout 1'], ['grp_auth', 'Auth Part 2 of 2 1'], ['grp_admin', 'Admin Off 1'],
  ]);
  await radio('simple').check();
  assert.equal(await page.locator('#flow-outline').isVisible(), false, 'Simple hides the outline');
  assert.deepEqual(await visibleCards(), ['req_cart', 'req_stock'], 'Simple keeps the collapsed-group presentation');
  await radio('advanced').check();
  assert.deepEqual(await visibleCards(), ['req_login']);
  checks.push('Outline mirrors stable IDs and global order inside group heads (Auth split in two parts), honest skipped labels; Simple presentation unchanged');

  // 1b. Each group folds in the outline with its saved collapsed flag (shared with Simple).
  assert.deepEqual(await shownRows(), ['req_cart', 'req_stock'], 'A collapsed group starts folded in the outline');
  assert.deepEqual(await page.$$eval('#flow-outline .outline-toggle[data-group-id="grp_auth"]', nodes => nodes.map(node => node.getAttribute('aria-expanded'))), ['false', 'false']);
  assert.equal(await outlineGroup('grp_auth').evaluate(node => node.classList.contains('outline-holds-current')), true, 'The folded head marks the selected request inside it');
  assert.match(await outlineGroup('grp_auth').getAttribute('aria-label'), /holds the selected request/);
  assert.equal(await page.locator('#flow-outline .outline-toggle[data-group-id="grp_checkout"]').getAttribute('aria-expanded'), 'true');
  await outlineToggle('grp_auth').click();
  assert.deepEqual(await shownRows(), ['req_login', 'req_cart', 'req_profile', 'req_stock'], 'Unfolding shows both parts of the group');
  assert.equal(await folded('grp_auth'), false, 'The outline unfolds the group itself');
  assert.equal(await outlineGroup('grp_auth').evaluate(node => node.classList.contains('outline-holds-current')), false);
  assert.deepEqual(await selectedIds(), ['req_login'], 'Folding never changes the selection');
  await radio('simple').check();
  assert.deepEqual(await visibleCards(), ['req_login', 'req_cart', 'req_profile', 'req_stock'], 'Simple follows the same flag');
  await radio('advanced').check();
  checks.push('Groups fold in the outline (aria-expanded, folded head marks the selection), one flag shared with Simple');

  // 2. Selecting a summary shows the same canonical card without reparenting.
  await page.evaluate(() => { window.cardsBefore = [...document.querySelector('#reqs-main').children]; });
  await outlineRequest('req_profile').click();
  assert.deepEqual(await selectedIds(), ['req_profile']);
  assert.deepEqual(await visibleCards(), ['req_profile']);
  assert.equal(await page.evaluate(() => {
    const now = [...document.querySelector('#reqs-main').children];
    return now.length === window.cardsBefore.length && now.every((node, index) => node === window.cardsBefore[index]);
  }), true, 'Same card elements in the same order and container');
  assert.equal(await card('req_profile').evaluate(node => node.classList.contains('expanded')), true);
  assert.equal(await card('req_profile').locator('.request-expand').isVisible(), false, 'Advanced editor cannot be collapsed away');
  checks.push('Summary click selects the same card element; no reparent, clone, or reorder');

  // 3. Unsaved values in every lazy part survive selection changes and two switches.
  // The editor shows Headers (and Body when the method sends one); every other part
  // is added from "+ Add to this request".
  await outlineRequest('req_cart').click();
  const cart = card('req_cart');
  const addPart = async id => {
    await cart.locator('.req-add-btn').click();
    await cart.locator(`.req-add-item[data-panel="${id}"]`).click();
  };
  const shownParts = () => cart.locator('.req-extra-sections > .req-section:not([hidden]) .req-panel')
    .evaluateAll(nodes => nodes.map(node => node.dataset.panel));
  assert.equal(await cart.locator('.req-section-headers').isVisible(), true, 'Headers always shown');
  assert.equal(await cart.locator('.req-section-body').isVisible(), false, 'A GET request with no body shows no Body section');
  assert.deepEqual(await shownParts(), [], 'No other part until one is added');
  await cart.locator('.req-panel[data-panel="headers"] .add-row-btn').click();
  await cart.locator('.headers-list .h-key').fill('X-Unsaved');
  await cart.locator('.headers-list .h-val').fill('  header value  ');
  await cart.locator('.request-kind').selectOption('POST');
  assert.equal(await cart.locator('.req-section-body').isVisible(), true, 'POST shows Body');
  await cart.locator('textarea.body').fill('  {"draft": true}  ');
  await cart.locator('.request-kind').selectOption('GET');
  assert.equal(await cart.locator('.req-section-body').isVisible(), true, 'Typed body text stays in sight on GET');
  assert.match(await cart.locator('.req-body-note').innerText(), /A GET request sends no body/);
  await addPart('extractions');
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('ext-name')), true, 'Adding a part puts the cursor in it');
  await cart.locator('.extractions-list .ext-name').fill('cart_id');
  await cart.locator('.extractions-list .ext-selector').fill('data.id');
  await addPart('assertions');
  await cart.locator('.req-panel[data-panel="assertions"] .add-row-btn').click();
  await addPart('scripts');
  await cart.locator('.pre-script').fill('vars.cart = 1;');
  await cart.locator('.post-script').fill('   ');
  await cart.locator('.req-editor-foot .sleep').fill('2.5');
  await addPart('statuses');
  await cart.locator('.check-status').uncheck();
  assert.deepEqual(await cart.locator('.req-add-item:has(.req-add-added:not([hidden]))').evaluateAll(nodes => nodes.map(node => node.dataset.panel)),
    ['assertions', 'extractions', 'statuses', 'scripts'], 'The menu marks the parts already added');
  const unsaved = await collect();
  await outlineRequest('req_login').click();
  await outlineGroup('grp_checkout').click();
  for (let i = 0; i < 2; i++) {
    await radio('simple').check();
    await radio('advanced').check();
  }
  await outlineRequest('req_cart').click();
  assert.deepEqual(await shownParts(), ['assertions', 'extractions', 'statuses', 'scripts'], 'Added parts stay shown, in menu order');
  assert.equal(await cart.locator('textarea.body').inputValue(), '  {"draft": true}  ');
  assert.equal(await cart.locator('.post-script').inputValue(), '   ');
  assert.deepEqual(await collect(), unsaved);
  const cartConfig = unsaved.scenario.requests.find(request => request.id === 'req_cart');
  assert.deepEqual(cartConfig.headers, [{ key: 'X-Unsaved', value: '  header value  ' }]);
  assert.equal(cartConfig.sleepAfter, '2.5');
  assert.equal(cartConfig.checkStatus, false);
  assert.equal(cartConfig.assertions.length, 1);
  checks.push('Editor shows Headers (+ Body by method, or while it holds text); parts added from "+ Add to this request" get the cursor and stay; unsaved Headers/Body/Extract/Checks/Scripts/Wait after/Success statuses survive selection and two switches');

  // 4. Existing request handlers keep the outline and selection in sync.
  await cart.locator('.request-name').fill('Cart <renamed>');
  await cart.locator('.request-kind').selectOption('PUT');
  assert.equal(await cart.locator('.method').inputValue(), 'PUT', 'The one method list sets the method the app reads');
  list = await rows();
  assert.ok(list[1].text.includes('Cart <renamed>') && list[1].text.includes('PUT'));
  await cart.locator('.request-enabled').uncheck();
  assert.ok((await rows())[1].text.includes('Disabled'));
  await cart.locator('.request-enabled').check();
  // Occasional actions live in the request's ⋯ panel; it stays open while moving.
  await cart.locator('.request-more').click();
  assert.equal(await cart.locator('.req-more-panel').isVisible(), true);
  await cart.locator('.request-move-up').click();
  assert.deepEqual((await rows()).map(row => row.id), ['req_cart', 'req_login', 'req_profile', 'req_stock']);
  assert.deepEqual(await selectedIds(), ['req_cart']);
  assert.ok((await rows())[0].text.includes('#1'));
  await cart.locator('.request-move-down').click();
  assert.deepEqual(await cardOrder(), ['req_login', 'req_cart', 'req_profile', 'req_stock']);
  // Folding the group of the selected request, then duplicating it, unfolds the group.
  await outlineToggle('grp_checkout').click();
  assert.equal(await outlineRequest('req_cart').isVisible(), false, 'Folding hides the requests of the group');
  assert.equal(await folded('grp_checkout'), true);
  if (!(await cart.locator('.req-more-panel').isVisible())) await cart.locator('.request-more').click();
  await cart.locator('.request-duplicate').click();
  list = await rows();
  const cloneId = list[2].id;
  assert.equal(await folded('grp_checkout'), false, 'Duplicating into a folded group unfolds it');
  assert.equal(await outlineRequest(cloneId).isVisible(), true);
  assert.equal(list.length, 5);
  assert.ok(!['req_login', 'req_cart', 'req_profile', 'req_stock'].includes(cloneId));
  assert.deepEqual(await selectedIds(), [cloneId], 'Duplicate selects the clone');
  assert.deepEqual(await visibleCards(), [cloneId]);
  await card(cloneId).locator('.request-more').click();
  await card(cloneId).locator('.curl').click();
  assert.equal(await card(cloneId).locator('.req-more-panel').isVisible(), false, 'Choosing an action closes the panel');
  await page.locator('#curl-input').fill(`curl -X POST 'http://127.0.0.1:9/imported' -H 'X-Imported: yes'`);
  await page.locator('#curl-apply').click();
  list = await rows();
  assert.ok(list[2].text.includes('http://127.0.0.1:9/imported') && list[2].text.includes('POST'), 'cURL import refreshes the outline');
  await card(cloneId).locator('.request-more').click();
  await card(cloneId).locator('.del').click();
  assert.deepEqual(await selectedIds(), ['req_profile'], 'Delete selects the next survivor');
  await page.locator('#outline-add-request').click();
  list = await rows();
  const addedId = list[4].id;
  assert.deepEqual(await selectedIds(), [addedId], 'Add selects the new request');
  assert.equal(await card(addedId).locator('.url').evaluate(node => node === document.activeElement), true);
  await card(addedId).locator('.request-more').click();
  await card(addedId).locator('.del').click();
  assert.deepEqual(await selectedIds(), ['req_stock'], 'Deleting the last request selects the previous one');
  checks.push('Rename, method, enable, move, duplicate, cURL, add, and delete update the outline; selection follows deterministic rules');

  // 5. Group editor reuses the existing group DOM; collapse stays presentation only.
  await outlineGroup('grp_checkout').click();
  assert.equal(await page.locator('#view-flow').getAttribute('data-flow-selection'), 'group');
  assert.equal(await group('grp_checkout').isVisible(), true);
  assert.equal(await group('grp_auth').isVisible(), false);
  assert.deepEqual(await visibleCards(), []);
  assert.equal(await outlineGroup('grp_checkout').getAttribute('aria-current'), 'true');
  await group('grp_checkout').locator('.request-group-name').fill('Payments');
  assert.ok((await outlineGroup('grp_checkout').textContent()).includes('Payments'));
  assert.equal(await sectionOf('req_cart'), 'grp_checkout');
  assert.equal(await card('req_cart').locator('.request-group-select option:checked').textContent(), 'Payments');
  await group('grp_checkout').locator('.add-group-header').click();
  await group('grp_checkout').locator('.group-headers-list .h-key').fill('X-Group');
  await group('grp_checkout').locator('.request-group-enabled').uncheck();
  assert.ok((await rows())[1].text.includes('Group off'));
  await group('grp_checkout').locator('.request-group-enabled').check();
  await page.locator('#outline-add-group').click();
  await settle();
  const newGroupId = await page.$eval('#flow-outline .outline-group[aria-current="true"]', node => node.dataset.id);
  assert.equal(await group(newGroupId).locator('.request-group-name').evaluate(node => node === document.activeElement), true);
  await group(newGroupId).locator('.request-group-name').fill('Extra');
  await outlineRequest('req_stock').click();
  await card('req_stock').locator('.request-more').click();
  await card('req_stock').locator('.request-group-select').selectOption(newGroupId);
  await page.keyboard.press('Escape');
  assert.equal(await card('req_stock').locator('.req-more-panel').isVisible(), false, 'Escape closes the panel');
  assert.equal(await sectionOf('req_stock'), newGroupId, 'A changed group moves the request under its head');
  assert.ok((await outlineGroup(newGroupId).textContent()).includes('Extra'));
  assert.ok(!(await rows())[3].text.includes('Group off'));
  await outlineGroup(newGroupId).click();
  await group(newGroupId).locator('.request-group-remove').click();
  await settle();
  assert.equal(await page.$eval('#flow-outline .outline-group[aria-current="true"]', node => node.dataset.id), 'grp_admin', 'Removed last group selects the previous group');
  const grouped = await collect();
  assert.equal(grouped.scenario.requests.find(request => request.id === 'req_stock').groupId, '');
  assert.deepEqual(grouped.scenario.groups.map(item => [item.id, item.name, item.collapsed, item.enabled]), [
    ['grp_auth', 'Auth', false, true], ['grp_checkout', 'Payments', false, true], ['grp_admin', 'Admin', false, false],
  ]);
  assert.deepEqual(grouped.scenario.groups[1].headers, [{ key: 'X-Group', value: '' }]);
  assert.deepEqual(grouped.scenario.requests.map(request => request.id), ['req_login', 'req_cart', 'req_profile', 'req_stock']);
  checks.push('Group select/rename/header/disable/add/membership/remove use existing group DOM; collapsed flags (unfolded from the outline) and order round-trip');

  // 6. Project text is rendered as text, never markup.
  await outlineRequest('req_login').click();
  await card('req_login').locator('.request-name').fill('<img src=x onerror="window.__xss=1">');
  assert.ok((await rows())[0].text.includes('<img src=x onerror="window.__xss=1">'));
  assert.equal(await page.locator('#flow-outline img').count(), 0);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  checks.push('Malicious request names render as text in the outline');

  // 7. Config/script parity across switch and selection; Save → Open in Simple → Advanced.
  const before = await collect();
  const scriptBefore = await generate(before);
  await outlineGroup('grp_auth').click();
  await radio('simple').check();
  await radio('advanced').check();
  await outlineRequest('req_profile').click();
  const after = await collect();
  assert.deepEqual(after, before);
  assert.equal(await generate(after), scriptBefore);
  assert.equal('uiMode' in after, false);
  const saved = await page.evaluate(async () => (await import('/js/project-store.js')).serializeProject(
    (await import('/js/config.js')).collectConfig()));
  await radio('simple').check();
  await openProject(JSON.parse(saved));
  const reopenedSimple = await collect();
  await radio('advanced').check();
  assert.deepEqual(await selectedIds(), ['req_login'], 'Opening a project resets selection to its first request');
  assert.deepEqual(await collect(), reopenedSimple);
  assert.deepEqual(reopenedSimple, JSON.parse(saved));
  checks.push('collectConfig and generated script identical across switch/selection; Save → Open (Simple) → Advanced round-trip identical, no uiMode');

  // 8. Keyboard: ordered lists of buttons; Tab reaches each group's fold toggle,
  // its head, then its requests; Enter folds or selects and focus stays put.
  await outlineRequest('req_login').focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.groupId), 'grp_checkout');
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains('outline-toggle')), true);
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-expanded')), 'false', 'Enter folds the group');
  assert.equal(await outlineRequest('req_cart').isVisible(), false);
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-expanded')), 'true', 'Focus stays on the toggle');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.id), 'grp_checkout');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.id), 'req_cart');
  await page.keyboard.press('Enter');
  assert.deepEqual(await selectedIds(), ['req_cart']);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.id), 'req_cart', 'Focus survives the outline refresh');
  assert.equal(await page.locator('#flow-outline ol.outline-list > li > button.outline-request').count(), 4);
  checks.push('Outline is ordered lists of buttons; Tab reaches fold toggle, group head and requests; Enter folds/selects and keeps focus');

  // 9. Layout in both modes, long URL included.
  await card('req_cart').locator('.url').fill(`https://api.example.test/${'long-path/'.repeat(20)}`);
  for (const [width, height] of [[1440, 900], [1024, 768], [768, 1024], [375, 812], [720, 450]]) {
    await page.setViewportSize({ width, height });
    for (const mode of ['simple', 'advanced']) {
      await radio(mode).check();
      await page.locator(`#${mode}-nav [data-view="flow"]`).click();
      await settle();
      const layout = await page.evaluate(() => {
        const ids = [...document.querySelectorAll('[id]')].map(node => node.id);
        const url = document.querySelector('#reqs-main > .req-card[data-request-id="req_cart"] .url').getBoundingClientRect();
        return {
          overflow: document.documentElement.scrollWidth > innerWidth,
          duplicateIds: ids.length !== new Set(ids).size,
          endpointWidth: url.width,
        };
      });
      assert.equal(layout.overflow, false, `${mode} ${width}: page overflow`);
      assert.equal(layout.duplicateIds, false);
      if (mode === 'advanced') assert.ok(layout.endpointWidth >= Math.min(200, width / 2), 'Long endpoint has usable space');
      layouts.push({ mode, width, height, ...layout });
      if (width === 1440 || width === 375) await page.screenshot({ path: resolve(output, `${mode}-${width}.png`), fullPage: true });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await outlineGroup('grp_checkout').click();
  await page.screenshot({ path: resolve(output, 'advanced-group-1440.png'), fullPage: true });
  checks.push('Both modes at four requested viewports plus 720x450 reflow equivalent (not native zoom)');

  assert.deepEqual(forbidden, []);
  assert.deepEqual(errors, []);
  const result = { checks, layouts, errors, forbidden, nativeZoomTested: false, realRunTested: false };
  console.log(JSON.stringify(result, null, 2));
  await writeFile(resolve(output, 'verification.json'), JSON.stringify(result, null, 2));
} catch (error) {
  await page?.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {});
  const state = await page?.evaluate(() => ({
    selection: document.querySelector('#view-flow')?.dataset.flowSelection,
    selected: [...document.querySelectorAll('.advanced-selected')].map(node => node.dataset.requestId || node.dataset.groupId),
    current: [...document.querySelectorAll('#flow-outline [aria-current]')].map(node => node.dataset.id),
  })).catch(() => null);
  console.error('Failure state:', JSON.stringify(state), 'page errors:', JSON.stringify(errors));
  throw error;
} finally {
  await browser?.close();
  await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
}
