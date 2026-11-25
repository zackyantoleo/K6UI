// Stage 4: real browser checks for the Simple notice, Load and Results across
// modes, and real local k6 runs (normal + mid-stream switches, threshold
// failure, Stop). Every executed URL is a synthetic HTTP server on 127.0.0.1;
// `.test` fixtures are generation-only and never contacted.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { resolve } from 'node:path';
import { createServer } from '../server/index.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = resolve('.hermes/plans/k6ui-ui-revamp-preview/stage4');
await mkdir(output, { recursive: true });

// Generation-only fixture: lazy (never-opened) panels carry advanced settings.
const NOTICE_FIXTURE = {
  schemaVersion: 2,
  scenario: {
    groups: [
      { id: 'grp_auth', name: 'Auth', enabled: true, collapsed: false, headers: [{ key: 'X-Service', value: 'auth-secret-header' }] },
      { id: 'grp_admin', name: 'Admin', enabled: false, collapsed: false, headers: [{ key: 'X-Admin', value: 'admin-secret' }] },
    ],
    requests: [
      {
        id: 'req_login', name: 'Login', groupId: 'grp_auth', type: 'http', method: 'POST',
        url: 'https://api.example.test/session', body: '{"user":"{{user}}"}',
        extractions: [{ varName: 'token', source: 'json', selector: 'data.token' }],
        assertions: [{ type: 'status-eq', value: '200', value2: '' }],
        preScript: 'vars.ts = "pre-secret";', postScript: '', checkStatus: true, sleepAfter: '0.5',
      },
      { id: 'req_cart', name: 'Cart', groupId: '', type: 'http', method: 'GET', url: 'https://api.example.test/cart' },
      {
        id: 'req_profile', name: 'Profile', groupId: 'grp_auth', type: 'http', method: 'GET',
        url: 'https://api.example.test/profile', enabled: false, postScript: 'vars.p = "off-secret";',
      },
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
const NOTICE_SECRETS = ['pre-secret', 'off-secret', 'auth-secret-header', 'admin-secret', 'api.example.test',
  'data.token', 'token', 'X-Service', 'X-Admin', 'stock.Stock', 'Login', 'Profile', 'Stock', 'Auth', 'Admin', '{{user}}'];

const appServer = createServer({ port: 0, host: '127.0.0.1' });
let browser, page;
const errors = [], forbidden = [], checks = [], layouts = [];
try {
  await once(appServer, 'listening');
  assert.equal(appServer.address().address, '127.0.0.1');
  const origin = `http://127.0.0.1:${appServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      forbidden.push(`${route.request().method()} ${url.origin}${url.pathname}`);
      return route.abort();
    }
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
    return route.continue();
  });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  // Sections that expect a confirm() swap this handler; anything else is a failure.
  let onDialog = dialog => { errors.push(`Unexpected dialog: ${dialog.message()}`); return dialog.dismiss(); };
  page.on('dialog', dialog => onDialog(dialog));

  const radio = mode => page.locator(`input[name="ui-mode"][value="${mode}"]`);
  const card = id => page.locator(`#reqs-main > .req-card[data-request-id="${id}"]`);
  const group = id => page.locator(`#request-groups > .request-group[data-group-id="${id}"]`);
  const settle = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => setTimeout(done, 0))));
  const collect = () => page.evaluate(async () => structuredClone((await import('/js/config.js')).collectConfig()));
  const generate = config => page.evaluate(async body => (await (await fetch('/api/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })).json()).script, config);
  const openProject = fixture => page.evaluate(async project =>
    (await import('/js/project-io.js')).applyConfig(project), fixture);
  const hydratedPanels = () => page.$$eval('.req-panel[data-panel-ready="true"]', nodes => nodes.length);
  const notice = () => page.locator('#advanced-notice');
  const noticeState = async () => {
    await settle();
    return page.evaluate(() => {
      const element = document.querySelector('#advanced-notice');
      return {
        visible: Boolean(element && element.getClientRects().length),
        items: Object.fromEntries([...(element?.querySelectorAll('li[data-category]') || [])]
          .map(item => [item.dataset.category, item.textContent.trim()])),
        skipped: element?.querySelector('.advanced-notice-skipped')?.hidden === false
          ? element.querySelector('.advanced-notice-skipped').textContent.trim() : '',
        text: element?.textContent.replace(/\s+/g, ' ').trim() || '',
      };
    });
  };

  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('#reqs-main'));

  // 1. Notice: lazy/imported settings, live edits beat the snapshot, no values, Simple only.
  await radio('advanced').check();
  await openProject(NOTICE_FIXTURE);
  await settle();
  const hydratedBefore = await hydratedPanels();
  assert.equal((await noticeState()).visible, false, 'Advanced does not show the Simple notice');
  await radio('simple').check();
  let state = await noticeState();
  assert.equal(state.visible, true, 'Simple shows the notice for imported settings');
  assert.equal(await hydratedPanels(), hydratedBefore, 'Notice reads requestState; it never hydrates lazy panels');
  assert.deepEqual(state.items, {
    extractions: 'Response extraction: 1 request',
    checks: 'Custom checks: 1 request',
    scripts: 'Pre/post scripts: 1 request',
    pacing: 'Custom wait after request: 1 request',
    groupHeaders: 'Group header defaults: 1 group',
  });
  assert.match(state.skipped, /2 skipped requests and 1 turned-off group/);
  assert.match(state.text, /changes only the layout, never what runs/i);
  for (const secret of NOTICE_SECRETS) assert.ok(!state.text.includes(secret), `notice leaks ${secret}`);

  const login = card('req_login');
  const storeBefore = await page.evaluate(async () => {
    window.storeBeforeTyping = (await import('/js/project-store.js')).projectStore.getState();
    return true;
  });
  assert.ok(storeBefore);
  assert.equal(await login.evaluate(node => node.classList.contains('expanded')), true, 'Opening a project expands the first card');
  assert.equal(await login.locator('.req-tab[data-tab="scripts"] .section-count').innerText(), '1', 'A part the request uses marks its tab');
  await login.locator('.req-tab[data-tab="scripts"]').click();
  assert.equal(await login.locator('.pre-script').inputValue(), 'vars.ts = "pre-secret";');
  await login.locator('.pre-script').fill('  \n\t ');
  state = await noticeState();
  assert.equal(state.items.scripts, undefined, 'Live whitespace-only script beats the saved snapshot');
  await login.locator('.pre-script').fill('vars.ts = 2;');
  assert.equal((await noticeState()).items.scripts, 'Pre/post scripts: 1 request');
  await login.locator('.req-tab[data-tab="settings"]').click();
  await login.locator('.sleep').fill('1');
  assert.equal((await noticeState()).items.pacing, undefined, 'Live default pause beats the saved 0.5 s');
  await login.locator('.req-tab[data-tab="checks"]').click();
  await login.locator('.assertions-list .row-remove').click();
  assert.equal((await noticeState()).items.checks, undefined, 'Removing the only check (a click) refreshes the notice');
  assert.equal(await page.evaluate(async () => window.storeBeforeTyping
    === (await import('/js/project-store.js')).projectStore.getState()), true, 'No collectConfig() per keystroke');

  await login.locator('.request-enabled').uncheck();
  state = await noticeState();
  assert.deepEqual(Object.keys(state.items), ['groupHeaders'], 'Disabled request is not reported as active');
  assert.match(state.skipped, /3 skipped requests and 1 turned-off group/);
  await login.locator('.request-enabled').check();
  await group('grp_auth').locator('.request-group-enabled').uncheck();
  state = await noticeState();
  assert.deepEqual(state.items, {}, 'Group off: its requests and header defaults are skipped');
  assert.match(state.text, /None of these settings run right now/);
  assert.match(state.skipped, /3 skipped requests and 2 turned-off groups/);
  await group('grp_auth').locator('.request-group-enabled').check();
  await radio('advanced').check();
  assert.equal((await noticeState()).visible, false);
  await radio('simple').check();
  assert.equal((await noticeState()).items.scripts, 'Pre/post scripts: 1 request', 'Re-entering Simple recomputes');
  await page.screenshot({ path: resolve(output, 'simple-notice-1440.png'), fullPage: true });
  await openProject({ schemaVersion: 2, scenario: { groups: [], requests: [{ id: 'req_plain', url: 'https://api.example.test/' }] } });
  assert.equal((await noticeState()).visible, false, 'A plain project shows no notice');
  checks.push('Simple notice: lazy/imported settings counted without hydrating; live edits (incl. whitespace script, removals) beat the snapshot; disabled request/group reported as skipped; no values; no collectConfig per keystroke; hidden in Advanced');

  // 2. Load: Advanced shows the custom editor (the kind of load) as presentation only.
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#reqs-main'));
  const loadState = () => page.evaluate(() => ({
    kind: document.querySelector('#load-kind').value,
    vus: document.querySelector('#vus').value,
    duration: document.querySelector('#duration').value,
    stages: [...document.querySelectorAll('#stages .stage-row')].map(row =>
      [row.querySelector('.stage-dur').value, row.querySelector('.stage-target').value]),
    goal: document.querySelector('.load-goal[aria-pressed="true"]')?.dataset.goal,
  }));
  const kindVisible = () => page.locator('#load-kind').isVisible();
  await radio('simple').check();
  await page.locator('#simple-nav [data-view="load"]').click();
  assert.equal(await page.locator('#load-settings').isVisible(), true, 'Simple shows the settings of the chosen goal');
  const initialLoad = await loadState();
  assert.equal(initialLoad.goal, 'custom', 'a fresh page keeps its fixed VUs, shown as Custom');
  await radio('advanced').check();
  assert.equal(await page.locator('#page-title').textContent(), 'Load Profile');
  assert.equal(await kindVisible(), true);
  assert.equal(await page.locator('[data-ui-only="advanced"].view-hint').isVisible(), true);
  assert.deepEqual(await loadState(), initialLoad, 'Switching changes no load value or goal');
  await page.locator('#load-kind').selectOption('stages');
  await page.locator('#stages .stage-row').first().locator('.stage-target').fill('3');
  const editedLoad = await loadState();
  assert.deepEqual(editedLoad.stages[0], ['30s', '3']);
  const editedConfig = (await collect()).load;
  await radio('simple').check();
  assert.deepEqual(await loadState(), editedLoad, 'Returning to Simple does not overwrite the load');
  assert.deepEqual((await collect()).load, editedConfig);
  await radio('advanced').check();
  const dialogs = [];
  onDialog = dialog => { dialogs.push(dialog.message()); return dialog.dismiss(); };
  await page.locator('.load-goal[data-goal="smoke"]').click();
  assert.equal(dialogs.length, 1, 'Custom values still need confirmation before a preset replaces them');
  assert.match(dialogs[0], /keep your custom load values/i);
  assert.deepEqual(await loadState(), editedLoad, 'Cancel keeps custom values');
  onDialog = dialog => { dialogs.push(dialog.message()); return dialog.accept(); };
  await page.locator('.load-goal[data-goal="smoke"]').click();
  onDialog = dialog => { errors.push(`Unexpected dialog: ${dialog.message()}`); return dialog.dismiss(); };
  assert.equal(dialogs.length, 2);
  const smoke = await loadState();
  assert.deepEqual([smoke.kind, smoke.stages, smoke.goal], ['stages', [['30s', '1']], 'smoke']);
  assert.equal(await kindVisible(), true, 'Advanced shows the kind of load under a preset too');
  await page.screenshot({ path: resolve(output, 'advanced-load-1440.png'), fullPage: true });
  await radio('simple').check();
  assert.deepEqual(await loadState(), smoke, 'Preset chosen in Advanced survives the switch');
  assert.equal(await kindVisible(), false, 'Simple hides the kind of load under a preset');
  checks.push('Load: Advanced shows the kind of load (the custom editor) without changing values or the goal; a preset asks before replacing custom values in Advanced too; the goal chosen in Advanced survives the switch');

  // 3. gRPC: config + generated code parity across switches (generation only; never executed).
  await openProject({
    schemaVersion: 2,
    scenario: { groups: [], requests: [{
      id: 'req_grpc', name: 'Stock', type: 'grpc', url: 'localhost:50051', grpcMethod: 'stock.Stock/Get',
      grpcPlaintext: true, body: '{"sku":"A1"}', extractions: [{ varName: 'qty', source: 'json', selector: 'qty' }],
      assertions: [{ type: 'status-eq', value: '0', value2: '' }], postScript: 'vars.seen = 1;',
    }] },
  });
  const grpcConfig = await collect();
  const grpcScript = await generate(grpcConfig);
  assert.match(grpcScript, /k6\/net\/grpc/);
  for (const mode of ['advanced', 'simple', 'advanced']) await radio(mode).check();
  assert.deepEqual(await collect(), grpcConfig);
  assert.equal(await generate(await collect()), grpcScript);
  checks.push('gRPC request: collectConfig and generated script identical across switches (generation only; real gRPC execution NOT verified)');

  // 4. Real local runs: one POST /api/run per click, SSE survives switches, results persist.
  const hits = new Map();
  const target = createHttpServer((request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    hits.set(path, (hits.get(path) || 0) + 1);
    const reply = () => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"ok":true}');
    };
    if (path === '/slow') setTimeout(reply, 60);
    else reply();
  });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  try {
    assert.equal(target.address().address, '127.0.0.1');
    const targetOrigin = `http://127.0.0.1:${target.address().port}`;
    const runFixture = ({ path = '/ok', duration = '4s', p95 = '' } = {}) => ({
      schemaVersion: 2,
      scenario: { groups: [], requests: [{
        id: 'req_local', name: 'Local target', type: 'http', method: 'GET',
        url: `${targetOrigin}${path}`, sleepAfter: '0.2', checkStatus: true,
      }] },
      variables: [], globalHeaders: [],
      load: { mode: 'simple', vus: '1', duration },
      thresholds: { p95, errorRate: '' },
      options: { logRequests: true },
    });
    const runPosts = [], runFailures = [];
    page.on('request', request => {
      if (new URL(request.url()).pathname === '/api/run') runPosts.push(request.method());
    });
    page.on('requestfailed', request => {
      if (new URL(request.url()).pathname === '/api/run') runFailures.push(request.failure()?.errorText || 'failed');
    });
    const results = () => page.evaluate(() => ({
      tab: document.querySelector('.results-tab[aria-selected="true"]')?.dataset.tab,
      filter: document.querySelector('#filter-url').value,
      rows: document.querySelectorAll('#req-log-tbody .req-log-row').length,
      visibleRows: document.querySelectorAll('#req-log-tbody .req-log-row:not(.hidden)').length,
      elapsed: document.querySelector('#run-elapsed').textContent,
      state: document.querySelector('#run-state').textContent,
      verdict: document.querySelector('#run-verdict').className,
      stopVisible: Boolean(document.querySelector('#stop-btn').getClientRects().length),
      runVisible: Boolean(document.querySelector('#run-btn').getClientRects().length),
      dotNav: document.querySelector('#nav-run-dot')?.closest('[data-ui-nav]')?.dataset.uiNav,
      dotVisible: Boolean(document.querySelector('#nav-run-dot')?.getClientRects().length),
    }));
    const executedUrls = async () => (await collect()).scenario.requests.map(request => request.url);
    const waitState = (text, timeout = 30000) => page.waitForFunction(
      expected => document.querySelector('#run-state').textContent === expected, text, { timeout });
    const waitRows = (count, timeout = 15000) => page.waitForFunction(
      expected => document.querySelectorAll('#req-log-tbody .req-log-row').length >= expected, count, { timeout });
    await page.waitForFunction(() => document.querySelector('#k6-status').textContent.includes('installed ✓'));

    // 4a. Normal run with switches mid-stream.
    await radio('advanced').check();
    await openProject(runFixture());
    assert.ok((await executedUrls()).every(url => url.startsWith('http://127.0.0.1:')), 'Executed URLs are loopback only');
    await page.locator('#run-btn').click();
    await waitRows(3);
    await page.locator('#results-tab-requests').click();
    await page.locator('#filter-url').fill('/ok');
    let during = await results();
    assert.deepEqual([during.tab, during.filter, during.state, during.stopVisible, during.runVisible, during.dotNav, during.dotVisible],
      ['requests', '/ok', 'RUNNING', true, false, 'advanced', true]);
    await radio('simple').check();
    let afterSwitch = await results();
    assert.equal(afterSwitch.tab, 'requests', 'Selected tab survives the switch');
    assert.equal(afterSwitch.filter, '/ok');
    assert.ok(afterSwitch.rows >= during.rows, 'Rows are kept, not cleared');
    assert.deepEqual([afterSwitch.state, afterSwitch.stopVisible, afterSwitch.dotNav, afterSwitch.dotVisible], ['RUNNING', true, 'simple', true]);
    assert.equal(await page.locator('#page-title').textContent(), 'Run & Results');
    await page.screenshot({ path: resolve(output, 'simple-running-1440.png'), fullPage: true });
    await page.waitForFunction(previous => document.querySelector('#run-elapsed').textContent !== previous,
      afterSwitch.elapsed, { timeout: 3000 });
    for (const mode of ['advanced', 'simple', 'advanced']) await radio(mode).check();
    await waitState('PASSED');
    const done = await results();
    assert.deepEqual([done.tab, done.filter, done.stopVisible, done.runVisible], ['requests', '/ok', false, true]);
    assert.match(done.verdict, /\bpassed\b/);
    assert.ok(done.rows >= afterSwitch.rows && done.visibleRows === done.rows);
    assert.deepEqual(runPosts, ['POST'], 'Exactly one POST /api/run for one click across five switches');
    assert.deepEqual(runFailures, [], 'The SSE stream was never aborted');
    await page.waitForTimeout(600);
    assert.equal((await results()).elapsed, done.elapsed, 'Elapsed stops when the run finishes');
    await radio('simple').check();
    const doneSimple = await results();
    assert.deepEqual({ ...doneSimple, dotNav: undefined }, { ...done, dotNav: undefined }, 'Completed results unchanged by the switch');
    checks.push(`Normal run: switched 5x mid-stream; 1 POST /api/run, 0 aborted; PASSED; tab/filter/rows (${done.rows})/elapsed (${done.elapsed})/verdict kept; Stop shown only while running`);

    // 4b. Advanced result shortcuts open the shared tabs; Simple hides them.
    await page.locator('#results-tab-overview').click();
    assert.equal(await page.locator('#tab-overview .result-shortcuts').isVisible(), false, 'Simple hides the shortcuts');
    await radio('advanced').check();
    await page.locator('#tab-overview .result-shortcuts [data-results-tab="errors"]').click();
    assert.equal((await results()).tab, 'errors');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'results-tab-errors');
    await radio('simple').check();
    assert.equal((await results()).tab, 'errors', 'The last tab is never reset by a mode switch');
    await page.locator('#results-tab-overview').click();
    await radio('advanced').check();
    await page.screenshot({ path: resolve(output, 'advanced-results-1440.png'), fullPage: true });
    checks.push('Advanced Overview shortcuts open the shared Requests/Errors/Raw k6 output tabs; hidden in Simple; tab not reset by switches');

    // 4c. Threshold failure (k6 exit 99) with a switch mid-run.
    await openProject(runFixture({ path: '/slow', duration: '2s', p95: '1' }));
    await page.locator('#run-btn').click();
    await waitRows(1);
    await radio('simple').check();
    await waitState('TARGETS NOT MET');
    const failed = await results();
    assert.match(failed.verdict, /\bthreshold-failed\b/);
    assert.equal(await page.locator('#run-verdict-title').textContent(), 'Failed: a goal was missed');
    await radio('advanced').check();
    assert.match((await results()).verdict, /\bthreshold-failed\b/);
    assert.deepEqual(runPosts, ['POST', 'POST']);
    assert.deepEqual(runFailures, []);
    checks.push('Threshold run (p95 < 1 ms against a 60 ms local endpoint): TARGETS NOT MET (exit 99) kept across switches; one POST');

    // 4d. Stop mid-run after a switch: aborted verdict, k6 stops hitting the target.
    await openProject(runFixture({ duration: '30s' }));
    await page.locator('#run-btn').click();
    await waitRows(2);
    await radio('simple').check();
    await page.locator('#stop-btn').click();
    const stopped = await results();
    assert.deepEqual([stopped.state, stopped.stopVisible, stopped.runVisible], ['STOPPED', false, true]);
    assert.match(stopped.verdict, /\baborted\b/);
    assert.equal(runPosts.length, 3);
    // The browser reports the aborted request a moment after the click.
    for (let wait = 0; wait < 40 && runFailures.length < 1; wait += 1) await page.waitForTimeout(50);
    assert.equal(runFailures.length, 1, 'Only the user Stop aborts the stream');
    await page.waitForTimeout(1500);
    const hitsAfterStop = hits.get('/ok');
    await page.waitForTimeout(2000);
    assert.equal(hits.get('/ok'), hitsAfterStop, 'k6 stops hitting the target after Stop');
    await radio('advanced').check();
    const stoppedAdvanced = await results();
    assert.equal(stoppedAdvanced.state, 'STOPPED');
    assert.equal(stoppedAdvanced.elapsed, stopped.elapsed, 'Elapsed frozen at Stop');
    assert.equal(stoppedAdvanced.rows, stopped.rows);
    checks.push(`Stop after a mid-run switch: STOPPED, Run restored, elapsed frozen, k6 stopped hitting the local target (hits frozen at ${hitsAfterStop}); results kept across switches`);
  } finally {
    target.closeAllConnections?.();
    await new Promise(done => target.close(done));
  }

  // 5. Layout: notice, Advanced load editor, and result shortcuts at every viewport.
  await openProject(NOTICE_FIXTURE);
  for (const [width, height] of [[1440, 900], [1024, 768], [768, 1024], [375, 812], [720, 450]]) {
    await page.setViewportSize({ width, height });
    for (const mode of ['simple', 'advanced']) {
      await radio(mode).check();
      for (const view of ['flow', 'load', 'results']) {
        await page.locator(`#${mode}-nav [data-view="${view}"]`).click();
        await settle();
        const layout = await page.evaluate(() => {
          const ids = [...document.querySelectorAll('[id]')].map(node => node.id);
          return { overflow: document.documentElement.scrollWidth > innerWidth, duplicateIds: ids.length !== new Set(ids).size };
        });
        assert.equal(layout.overflow, false, `${mode} ${view} ${width}: page overflow`);
        assert.equal(layout.duplicateIds, false, `${mode} ${view} ${width}: duplicate IDs`);
        if (view === 'flow') assert.equal(await notice().isVisible(), mode === 'simple');
        if (view === 'load') assert.equal(await page.locator('#load-settings').isVisible(), true);
        if (view === 'results') assert.equal(await page.locator('#tab-overview .result-shortcuts').isVisible(), mode === 'advanced');
        layouts.push({ mode, view, width, height, ...layout });
        if (width === 375 && ((mode === 'simple' && view === 'flow') || mode === 'advanced' && view !== 'flow')) {
          await page.screenshot({ path: resolve(output, `${mode}-${view}-375.png`), fullPage: true });
        }
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  checks.push('Simple/Advanced × Flow/Load/Results at 1440×900, 1024×768, 768×1024, 375×812 and 720×450 (reflow equivalent, not native zoom): no page overflow or duplicate IDs');

  assert.deepEqual(forbidden, []);
  assert.deepEqual(errors, []);
  const result = { checks, layouts, errors, forbidden, nativeZoomTested: false, realGrpcRunTested: false };
  console.log(JSON.stringify(result, null, 2));
  await writeFile(resolve(output, 'verification.json'), JSON.stringify(result, null, 2));
} catch (error) {
  await page?.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error('page errors:', JSON.stringify(errors), 'forbidden:', JSON.stringify(forbidden));
  throw error;
} finally {
  await browser?.close();
  await new Promise((done, reject) => appServer.close(error => error ? reject(error) : done()));
}
