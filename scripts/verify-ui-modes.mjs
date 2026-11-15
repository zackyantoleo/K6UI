// Stage 5: one runnable browser check for the Simple/Advanced acceptance
// matrix (plan §10, A1–A11). It runs its own checks — rich-project parity,
// save/open across modes, listener duplication, focus after delete, result
// safety in a real local run, layout/contrast/focus audits — and then the
// stage 2–4 browser checks as child processes, so one command covers it all.
//
//   PLAYWRIGHT_MODULE=file:///path/to/playwright/index.mjs node scripts/verify-ui-modes.mjs
//
// Every executed URL is a synthetic HTTP server on 127.0.0.1 owned by this
// script; `.test` fixtures are generation-only and never contacted.
// K6UI_VERIFY_SECTIONS=parity,layout,... runs a subset (handy while fixing);
// K6UI_VERIFY_SKIP_STAGE_CHECKS=1 skips the three older scripts.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { createServer } from '../server/index.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = resolve(process.env.K6UI_VERIFY_OUTPUT || '.hermes/plans/k6ui-ui-revamp-preview/stage5');
await mkdir(output, { recursive: true });
const sections = new Set((process.env.K6UI_VERIFY_SECTIONS
  || 'parity,files,listeners,focus,results,layout,keyboard,storage,perf').split(','));

const LONG_PATH = `/catalog/${'segment-'.repeat(30)}end?page=1&sort=price`;
// Rich generation-only fixture: interleaved Auth–Checkout–Auth, a collapsed
// group (its request is hidden in Simple), a disabled request, a gRPC request
// in a turned-off group, lazy scripts/extractions/checks, before/after,
// header precedence global < group < request, staged load and thresholds.
const RICH = {
  schemaVersion: 2,
  scenario: {
    groups: [
      { id: 'grp_auth', name: 'Auth', enabled: true, collapsed: false, headers: [{ key: 'X-Trace', value: 'group-auth' }] },
      { id: 'grp_checkout', name: 'Checkout', enabled: true, collapsed: true, headers: [{ key: 'X-Trace', value: 'group-checkout' }] },
      { id: 'grp_admin', name: 'Admin', enabled: false, collapsed: false, headers: [] },
    ],
    requests: [
      {
        id: 'req_login', name: 'Login', groupId: 'grp_auth', type: 'http', method: 'POST', url: '{{base_url}}/session',
        headers: [{ key: 'Content-Type', value: 'application/json' }], body: '{"user":"{{user}}"}',
        extractions: [{ varName: 'token', source: 'json', selector: 'data.token' }],
        assertions: [{ type: 'status-eq', value: '200', value2: '' }],
        preScript: 'vars.started = Date.now();', postScript: '', checkStatus: true, sleepAfter: '0.5',
        pre: {
          method: 'GET', url: '{{base_url}}/csrf', headers: [{ key: 'X-Pre', value: '1' }], body: '',
          extractions: [{ varName: 'csrf', source: 'header', selector: 'X-CSRF' }],
        },
      },
      {
        id: 'req_cart', name: 'Cart', groupId: 'grp_checkout', type: 'http', method: 'PUT', url: `{{base_url}}${LONG_PATH}`,
        headers: [{ key: 'x-trace', value: 'request-cart' }, { key: 'Authorization', value: 'Bearer {{token}}' }],
        body: '{"sku":"A1","qty":2}', assertions: [{ type: 'body-contains', value: 'ok', value2: '' }],
        checkStatus: false, sleepAfter: '0',
        post: { method: 'DELETE', url: '{{base_url}}/cart/tmp', headers: [], body: '', extractions: [] },
      },
      {
        id: 'req_profile', name: 'Profile', groupId: 'grp_auth', type: 'http', method: 'GET', url: '{{base_url}}/profile',
        postScript: 'vars.profileSeen = true;', sleepAfter: '1',
      },
      { id: 'req_legacy', name: 'Legacy report', groupId: '', type: 'http', method: 'GET', url: '{{base_url}}/legacy', enabled: false },
      {
        id: 'req_stock', name: 'Stock', groupId: 'grp_admin', type: 'grpc', method: 'GET', url: 'grpc.example.test:443',
        grpcMethod: 'stock.Stock/Get', grpcPlaintext: false, body: '{"sku":"A1"}', headers: [{ key: 'x-tenant', value: 'demo' }],
      },
    ],
  },
  variables: [{ key: 'base_url', value: 'https://api.example.test' }, { key: 'user', value: 'demo' }],
  globalHeaders: [{ key: 'Accept', value: 'application/json' }, { key: 'X-Trace', value: 'global' }],
  load: { mode: 'stages', stages: [{ duration: '10s', target: '2' }, { duration: '20s', target: '5' }, { duration: '5s', target: '0' }] },
  thresholds: { p95: '800', errorRate: '2' },
  options: { logRequests: true },
};

const manyRequests = count => ({
  schemaVersion: 2,
  scenario: {
    groups: ['A', 'B', 'C'].map(name => ({ id: `grp_${name}`, name, enabled: true, collapsed: false, headers: [] })),
    requests: Array.from({ length: count }, (_, index) => ({
      id: `req_${index}`, name: `Request ${index + 1}`, groupId: `grp_${'ABC'[index % 3]}`, type: 'http',
      method: index % 4 ? 'GET' : 'POST', url: `https://api.example.test/items/${index}`,
      headers: [{ key: 'X-Index', value: String(index) }], body: index % 4 ? '' : `{"i":${index}}`,
      extractions: index % 10 ? [] : [{ varName: `v${index}`, source: 'json', selector: 'id' }],
    })),
  },
  variables: [], globalHeaders: [], load: { mode: 'simple', vus: '1', duration: '10s' }, thresholds: {}, options: {},
});

const EMPTY = {
  schemaVersion: 2, scenario: { groups: [], requests: [] }, variables: [], globalHeaders: [],
  load: { mode: 'simple', vus: '1', duration: '10s' }, thresholds: {}, options: {},
};

// Runs inside the page: problems in what is visible right now.
function auditPage() {
  const problems = [];
  const viewportWidth = document.documentElement.clientWidth;
  const describe = element => {
    const id = element.id ? `#${element.id}` : '';
    const classes = typeof element.className === 'string' && element.className.trim()
      ? `.${element.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
    const text = (element.getAttribute('aria-label') || element.textContent || element.value || '')
      .trim().replace(/\s+/g, ' ').slice(0, 32);
    return `${element.tagName.toLowerCase()}${id}${classes}${text ? ` "${text}"` : ''}`;
  };
  const shown = element => {
    if (!element.getClientRects().length) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== 'hidden' && rect.width * rect.height > 4;
  };
  const ids = [...document.querySelectorAll('[id]')].map(node => node.id);
  const overflow = document.documentElement.scrollWidth > document.documentElement.clientWidth;
  if (overflow) problems.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${viewportWidth})`);
  if (ids.length !== new Set(ids).size) problems.push('duplicate IDs');

  const controls = [...document.querySelectorAll(
    'button, input:not([type="hidden"]), select, textarea, a[href], label')].filter(shown)
    .filter(element => !element.closest('.ui-mode-switch') || element.matches('label'));
  const scrollsSideways = element => {
    for (let node = element.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowX) && node.scrollWidth > node.clientWidth) return true;
    }
    return false;
  };
  for (const control of controls) {
    const rect = control.getBoundingClientRect();
    if ((rect.left < -1 || rect.right > viewportWidth + 1) && !scrollsSideways(control)) {
      problems.push(`off screen: ${describe(control)}`);
    }
    const box = control.closest('.req-card, .request-group, .flow-outline');
    if (box && box !== control) {
      const outer = box.getBoundingClientRect();
      if (rect.right > outer.right + 1 || rect.left < outer.left - 1) problems.push(`sticks out of its card: ${describe(control)}`);
    }
  }
  // Overlap between controls that are not nested in each other. Only the part
  // a scroll container leaves visible counts, and content scrolled under a
  // sticky/fixed bar (another layer) is by design.
  const visibleRect = element => {
    let { left, top, right, bottom } = element.getBoundingClientRect();
    for (let node = element.parentElement; node && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const box = node.getBoundingClientRect();
      left = Math.max(left, box.left); right = Math.min(right, box.right);
      top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom);
    }
    return { left, top, right, bottom };
  };
  const layer = element => {
    for (let node = element; node; node = node.parentElement) {
      if (/^(fixed|sticky)$/.test(getComputedStyle(node).position)) return node;
    }
    return null;
  };
  const layers = new Map(controls.map(control => [control, layer(control)]));
  for (let i = 0; i < controls.length; i += 1) {
    const a = visibleRect(controls[i]);
    for (let j = i + 1; j < controls.length; j += 1) {
      if (controls[i].contains(controls[j]) || controls[j].contains(controls[i])) continue;
      if (layers.get(controls[i]) !== layers.get(controls[j])) continue;
      const b = visibleRect(controls[j]);
      const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (width > 2 && height > 2) problems.push(`overlap: ${describe(controls[i])} × ${describe(controls[j])}`);
    }
  }
  // Browser-default buttons mean a class name has no matching CSS rule.
  for (const button of controls.filter(element => element.matches('button'))) {
    const style = getComputedStyle(button);
    if (['rgb(239, 239, 239)', 'rgb(240, 240, 240)', 'rgb(233, 233, 237)'].includes(style.backgroundColor)
      || style.borderTopStyle === 'outset') problems.push(`unstyled button: ${describe(button)}`);
  }
  // The endpoint field of an open request editor keeps a usable width.
  for (const url of document.querySelectorAll('.req-card.expanded .req-card-head .url')) {
    if (!shown(url)) continue;
    const card = url.closest('.req-card').getBoundingClientRect().width;
    if (url.getBoundingClientRect().width < Math.min(240, card - 48)) problems.push(`URL field squeezed: ${Math.round(url.getBoundingClientRect().width)}px`);
  }

  // Text contrast (WCAG 2.x): 4.5:1, or 3:1 for large text.
  const parse = value => {
    const match = /^rgba?\(([^)]+)\)$/.exec(value);
    if (!match) return null;
    const [r, g, b, a = 1] = match[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { r, g, b, a };
  };
  const over = (top, bottom) => {
    const a = top.a + bottom.a * (1 - top.a);
    const mix = key => (top[key] * top.a + bottom[key] * bottom.a * (1 - top.a)) / a;
    return { r: mix('r'), g: mix('g'), b: mix('b'), a };
  };
  const luminance = ({ r, g, b }) => {
    const channel = value => {
      const v = value / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const ratio = (x, y) => {
    const [light, dark] = [luminance(x), luminance(y)].sort((p, q) => q - p);
    return (light + 0.05) / (dark + 0.05);
  };
  const backdrop = element => {
    const layers = [];
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.backgroundImage !== 'none') return null;
      const color = parse(style.backgroundColor);
      if (color && color.a > 0) {
        layers.push(color);
        if (color.a >= 1) break;
      }
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (let index = layers.length - 1; index >= 0; index -= 1) base = over(layers[index], base);
    return base;
  };
  const hex = ({ r, g, b }) => `#${[r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  let measured = 0, exempt = 0, unmeasurable = 0;
  for (const element of document.querySelectorAll('body *')) {
    const ownText = [...element.childNodes].some(node => node.nodeType === 3 && node.textContent.trim());
    const formText = element.matches('input:not([type="checkbox"]):not([type="radio"]):not([type="file"]), select, textarea')
      && String(element.value || '').trim();
    if ((!ownText && !formText) || !shown(element) || element.closest('[aria-hidden="true"]')) continue;
    // Inactive UI is exempt: disabled controls, switched-off requests/groups.
    if (element.closest(':disabled, .request-disabled, .request-group-disabled')) { exempt += 1; continue; }
    const style = getComputedStyle(element);
    const color = parse(style.color);
    const background = backdrop(element);
    if (!color || !background) { unmeasurable += 1; continue; }
    let fade = 1;
    for (let node = element; node; node = node.parentElement) fade *= Number(getComputedStyle(node).opacity);
    const text = over({ ...color, a: color.a * fade }, background);
    const size = parseFloat(style.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
    const needed = large ? 3 : 4.5;
    const value = ratio(text, background);
    measured += 1;
    if (value < needed) problems.push(`contrast ${value.toFixed(2)} < ${needed}: ${describe(element)} (${hex(text)} on ${hex(background)})`);
  }
  return { overflow, problems: [...new Set(problems)], contrast: { measured, exempt, unmeasurable } };
}

const appServer = createServer({ port: 0, host: '127.0.0.1' });
let browser;
const pages = [];
const errors = [], forbidden = [], checks = [], audits = [], measurements = {};
try {
  await once(appServer, 'listening');
  assert.equal(appServer.address().address, '127.0.0.1');
  const origin = `http://127.0.0.1:${appServer.address().port}`;
  browser = await chromium.launch({ headless: true });

  // A fresh, network-fenced page. Dialogs are failures unless a section expects one.
  const expectedDialogs = [];
  async function openPage(contextOptions = {}) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, ...contextOptions });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) {
        forbidden.push(`${route.request().method()} ${url.origin}${url.pathname}`);
        return route.abort();
      }
      if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
      return route.continue();
    });
    const page = await context.newPage();
    pages.push(page);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('dialog', dialog => {
      const expected = expectedDialogs.shift();
      if (!expected || !expected.test(dialog.message())) errors.push(`Unexpected dialog: ${dialog.message()}`);
      return dialog.dismiss();
    });
    await page.goto(origin);
    await page.waitForFunction(() => document.querySelector('#reqs-main') && document.querySelector('#flow-outline'));
    return page;
  }

  const page = await openPage();
  const radio = (mode, target = page) => target.locator(`input[name="ui-mode"][value="${mode}"]`);
  const settle = (target = page) => target.evaluate(() => new Promise(done => requestAnimationFrame(() => setTimeout(done, 0))));
  const collect = (target = page) => target.evaluate(async () => structuredClone((await import('/js/config.js')).collectConfig()));
  const openProject = (fixture, target = page) => target.evaluate(async project =>
    (await import('/js/project-io.js')).applyConfig(project), fixture);
  const navigate = (view, target = page) => target.evaluate(async name => (await import('/js/nav.js')).navigate(name), view);
  const generate = (config, target = page) => target.evaluate(async body => (await (await fetch('/api/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })).json()).script, config);
  const outlineItem = id => page.locator(`#flow-outline .outline-item[data-id="${id}"]`);
  const audit = async (label, target = page) => {
    await settle(target);
    const result = await target.evaluate(auditPage);
    audits.push({ label, problems: result.problems.length, contrast: result.contrast });
    assert.deepEqual(result.problems, [], `${label}: layout/accessibility problems`);
    return result;
  };
  const generateBodies = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/generate') generateBodies.push(request.postData() || '');
  });

  // 1. Rich project parity (A3, A4, A6): no edit + switches + selections → identical config and script.
  if (sections.has('parity')) {
    await radio('simple').check();
    await openProject(RICH);
    await settle();
    const baseline = await collect();
    const baselineScript = await generate(baseline);
    assert.equal(baseline.scenario.requests.length, 5, 'Hidden (collapsed-group) and disabled requests stay in the payload');
    assert.deepEqual(baseline.scenario.requests.map(request => request.id), ['req_login', 'req_cart', 'req_profile', 'req_legacy', 'req_stock']);
    assert.equal(await page.locator('#reqs-main > .req-card[data-request-id="req_cart"]').isVisible(), false, 'Simple hides the collapsed group member');
    for (const mode of ['advanced', 'simple', 'advanced']) {
      await radio(mode).check();
      if (mode === 'advanced') {
        for (const id of ['req_cart', 'grp_checkout', 'req_stock', 'req_login']) await outlineItem(id).click();
      }
      await settle();
      assert.deepEqual(await collect(), baseline, `collectConfig changed after switching to ${mode}`);
    }
    assert.equal(await generate(await collect()), baselineScript, 'Generated script identical across switches/selections');
    // Header precedence global < group < request (case-insensitive) in the generated code.
    // Sub-requests inherit global + group headers only, so check the main Cart call.
    const cartCall = baselineScript.split('\n').find(line => line.includes('http.request("PUT"'));
    assert.match(cartCall, /"x-trace": "request-cart"/);
    assert.doesNotMatch(cartCall, /group-checkout|"global"/, 'Request header overrides group and global (case-insensitive)');
    assert.match(baselineScript, /"X-Trace": "group-auth"/, 'Group overrides global');
    // Disabled request and turned-off group: kept in the project, skipped in the script.
    assert.equal(baseline.scenario.requests[4].grpcMethod, 'stock.Stock/Get', 'gRPC fields kept');
    assert.ok(!baselineScript.includes('stock.Stock/Get') && !baselineScript.includes('/legacy'), 'Skipped requests not generated');
    // Raw unsaved text typed without blur survives switches and reaches the payload.
    await radio('advanced').check();
    await outlineItem('req_cart').click();
    const cart = page.locator('#reqs-main > .req-card[data-request-id="req_cart"]');
    await cart.locator('.req-tab[data-tab="body"]').click();
    const body = cart.locator('.req-tab-panel textarea').first();
    await body.click();
    await page.keyboard.type(' \n  ');
    const raw = await body.inputValue();
    for (const mode of ['simple', 'advanced']) await radio(mode).check();
    assert.equal(await body.inputValue(), raw, 'Unsaved textarea text (incl. whitespace) kept');
    assert.equal((await collect()).scenario.requests[1].body, raw);
    assert.ok(generateBodies.length >= 2 && generateBodies.every(text => !text.includes('uiMode')), 'No uiMode in generate payloads');
    checks.push('A3/A4/A6 rich project (interleaved groups, collapsed/disabled, gRPC, before/after, lazy scripts, stages, thresholds): collectConfig + script identical across 3 switches and 4 selections; hidden requests kept; header precedence global < group < request; unsaved textarea kept; no uiMode in payloads');
  }

  // 2. Save in Simple → open in Advanced → save → open in Simple; v1 migration; bad version (A5).
  if (sections.has('files')) {
    const save = async name => {
      const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#save-project-btn').click()]);
      const path = resolve(output, name);
      await download.saveAs(path);
      return { path, text: await readFile(path, 'utf8') };
    };
    // The real Open button (it clears the input first, so the same file can be reopened).
    const open = async path => {
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#open-project-btn').click()]);
      await chooser.setFiles(path);
    };
    await radio('simple').check();
    await openProject(RICH);
    const before = await collect();
    const first = await save('roundtrip-simple.json');
    await radio('advanced').check();
    await openProject(EMPTY);
    await open(first.path);
    await page.waitForFunction(() => document.querySelectorAll('#reqs-main > .req-card').length === 5);
    assert.deepEqual(await collect(), before, 'Simple save → Advanced open: identical config');
    const second = await save('roundtrip-advanced.json');
    assert.equal(second.text, first.text, 'Saving again in Advanced writes the same file');
    await radio('simple').check();
    await openProject(EMPTY);
    await open(second.path);
    await page.waitForFunction(() => document.querySelectorAll('#reqs-main > .req-card').length === 5);
    assert.deepEqual(await collect(), before, 'Advanced save → Simple open: identical config');
    const saved = JSON.parse(first.text);
    assert.equal(saved.schemaVersion, 2);
    assert.ok(!/uiMode|ui-mode|k6ui\.uiMode/.test(first.text), 'No UI mode in the project file');

    // v1 file (no version, no IDs) migrates in both modes.
    const v1Path = resolve(output, 'legacy-v1.json');
    await writeFile(v1Path, JSON.stringify({
      scenario: { requests: [{ method: 'GET', url: 'https://api.example.test/a' }, { method: 'POST', url: 'https://api.example.test/b', body: '{}' }] },
      variables: [], load: { mode: 'simple', vus: '1', duration: '5s' }, thresholds: {}, options: {},
    }));
    for (const mode of ['advanced', 'simple']) {
      await radio(mode).check();
      await openProject(EMPTY);
      await open(v1Path);
      await page.waitForFunction(() => document.querySelectorAll('#reqs-main > .req-card').length === 2);
      const migrated = await collect();
      assert.ok(migrated.scenario.requests.every(request => /^req_/.test(request.id)), `${mode}: v1 requests get stable IDs`);
      assert.equal(await page.locator('#flow-outline .outline-request').count(), 2);
    }
    // Unknown version: actionable error, nothing applied partially (both modes).
    const badPath = resolve(output, 'unknown-version.json');
    await writeFile(badPath, JSON.stringify({ ...RICH, schemaVersion: 99 }));
    for (const mode of ['simple', 'advanced']) {
      await radio(mode).check();
      await openProject(RICH);
      const kept = await collect();
      expectedDialogs.push(/version/i);
      await open(badPath);
      await page.waitForTimeout(300);
      assert.equal(expectedDialogs.length, 0, `${mode}: unknown version shows an error`);
      assert.deepEqual(await collect(), kept, `${mode}: unknown version leaves the open project untouched`);
    }
    checks.push('A5 Save in Simple → Open in Advanced → Save → Open in Simple: identical config and byte-identical file, schemaVersion 2, no UI-mode key; v1 file migrates with req_* IDs in both modes; schemaVersion 99 shows an error and changes nothing in both modes');
  }

  // 3. Listener duplication: after many switches each action still happens once.
  if (sections.has('listeners')) {
    await openProject(RICH);
    for (let index = 0; index < 12; index += 1) await radio(index % 2 ? 'simple' : 'advanced').check();
    await radio('simple').check();
    let cards = await page.locator('#reqs-main > .req-card').count();
    await page.locator('#view-flow .add-req-btn').click();
    assert.equal(await page.locator('#reqs-main > .req-card').count(), cards + 1, 'Simple + Add Request adds exactly one');
    await radio('advanced').check();
    cards += 1;
    await page.locator('#outline-add-request').click();
    assert.equal(await page.locator('#reqs-main > .req-card').count(), cards + 1, 'Advanced + Request adds exactly one');
    const generatesBefore = generateBodies.length;
    await page.locator('#advanced-nav [data-view="script"]').click();
    await page.waitForFunction(() => !/Click "Refresh"/.test(document.querySelector('#script-preview').textContent));
    await page.waitForTimeout(300);
    assert.equal(generateBodies.length - generatesBefore, 1, 'k6 Script category generates once');
    let downloads = 0;
    const countDownload = () => { downloads += 1; };
    page.on('download', countDownload);
    await page.locator('#save-project-btn').click();
    await page.waitForTimeout(500);
    page.off('download', countDownload);
    assert.equal(downloads, 1, 'Save downloads once');
    checks.push('Listener review: after 13 switches, Add Request (both modes), k6 Script and Save each act exactly once');
  }

  // 4. Focus after delete (keyboard users keep their place) in both modes.
  if (sections.has('focus')) {
    const active = () => page.evaluate(() => {
      const element = document.activeElement;
      return {
        tag: element?.tagName, id: element?.dataset?.id || element?.closest?.('.req-card')?.dataset.requestId
          || element?.closest?.('.request-group')?.dataset.groupId || element?.id || '',
        className: element?.className || '',
      };
    });
    await radio('advanced').check();
    await openProject(RICH);
    await outlineItem('req_cart').click();
    await page.locator('#reqs-main > .req-card[data-request-id="req_cart"] .req-action-btn.del').focus();
    await page.keyboard.press('Enter');
    let focused = await active();
    assert.equal(focused.id, 'req_profile', 'Advanced: focus moves to the outline entry now selected');
    assert.match(focused.className, /outline-item/);
    await outlineItem('grp_admin').click();
    await page.locator('#request-groups > .request-group[data-group-id="grp_admin"] .request-group-remove').focus();
    await page.keyboard.press('Enter');
    focused = await active();
    assert.match(focused.className, /outline-item/, 'Advanced: focus stays in the outline after removing a group');
    await radio('simple').check();
    await openProject(RICH);
    await page.locator('#reqs-main > .req-card[data-request-id="req_login"] .req-action-btn.del').focus();
    await page.keyboard.press('Enter');
    focused = await active();
    assert.equal(focused.id, 'req_profile', 'Simple: focus skips the hidden (collapsed-group) Cart and lands on the next visible request');
    assert.match(focused.className, /request-expand/);
    await page.locator('#request-groups > .request-group[data-group-id="grp_auth"] .request-group-remove').focus();
    await page.keyboard.press('Enter');
    focused = await active();
    assert.equal(focused.id, 'grp_checkout', 'Simple: focus moves to the next group');
    await openProject({ ...EMPTY, scenario: { groups: [], requests: [RICH.scenario.requests[2]] } });
    await page.locator('#reqs-main > .req-card .req-action-btn.del').focus();
    await page.keyboard.press('Enter');
    assert.match((await active()).className, /add-req-btn/, 'Simple: last request removed → Add Request');
    checks.push('Focus after delete: Advanced → selected outline entry (request and group); Simple → next visible request (skips cards hidden in a collapsed group) / next group, or + Add Request when none is left');
  }

  // 5. Results safety in a real local run (A8, A9): markup stays text, redaction, caps, log opt-in.
  if (sections.has('results')) {
    const target = createHttpServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ token: 'tok-secret-123', note: '<img src=x onerror="window.__k6uiXss=1">' }));
    });
    target.listen(0, '127.0.0.1');
    await once(target, 'listening');
    try {
      assert.equal(target.address().address, '127.0.0.1');
      const url = `http://127.0.0.1:${target.address().port}/xss?api_key=abc-secret-key`;
      const runFixture = (logRequests, duration) => ({
        schemaVersion: 2,
        scenario: { groups: [], requests: [{
          id: 'req_local', name: '<img src=x onerror="window.__k6uiXss=2">', type: 'http', method: 'GET', url,
          preScript: 'for (let line = 0; line < 3; line += 1) console.log("tick " + __ITER + "." + line);',
          sleepAfter: '0', checkStatus: true,
        }] },
        variables: [], globalHeaders: [], load: { mode: 'simple', vus: '2', duration }, thresholds: {}, options: { logRequests },
      });
      const runPosts = [];
      page.on('request', request => { if (new URL(request.url()).pathname === '/api/run') runPosts.push(1); });
      await page.waitForFunction(() => document.querySelector('#k6-status').textContent.includes('installed ✓'));
      await radio('advanced').check();
      await openProject(runFixture(true, '5s'));
      assert.ok((await collect()).scenario.requests.every(request => request.url.startsWith('http://127.0.0.1:')));
      await page.locator('#run-btn').click();
      await page.waitForFunction(() => document.querySelectorAll('#req-log-tbody .req-log-row').length > 0, null, { timeout: 15000 });
      await radio('simple').check();
      await page.waitForFunction(() => document.querySelector('#run-state').textContent === 'PASSED', null, { timeout: 30000 });
      await page.locator('#results-tab-requests').click();
      await page.locator('#req-log-tbody .req-log-row').first().click();
      const results = await page.evaluate(() => ({
        rows: document.querySelectorAll('#req-log-tbody .req-log-row').length,
        count: document.querySelector('#req-log-count').textContent,
        urls: [...document.querySelectorAll('#req-log-tbody .req-url-cell')].map(cell => cell.textContent),
        detail: document.querySelector('#req-log-tbody .req-detail-body')?.textContent || '',
        log: document.querySelector('#log-output').textContent,
        images: document.querySelectorAll('img').length,
        xss: window.__k6uiXss,
        verdict: document.querySelector('#run-verdict').className,
      }));
      assert.equal(results.rows, 500, 'Request detail rows are capped at 500');
      assert.equal(results.count, '500');
      assert.ok(results.urls.every(text => text.includes('[REDACTED]') && !text.includes('abc-secret-key')), 'Query secrets redacted');
      assert.match(results.detail, /\[REDACTED\]/);
      assert.ok(!results.detail.includes('tok-secret-123'), 'Response token redacted');
      assert.ok(results.detail.includes('<img src=x'), 'Response markup shown as text');
      assert.equal(results.images, 0, 'No markup became an element');
      assert.equal(results.xss, undefined, 'No script ran');
      const logLines = results.log.split('\n').filter(Boolean);
      assert.ok(logLines.length <= 1501 && /older lines hidden/.test(results.log), `Live log capped at 1500 lines (${logLines.length})`);
      assert.match(results.verdict, /\bpassed\b/);
      await radio('advanced').check();
      await audit('results populated 1440 advanced');
      await page.setViewportSize({ width: 375, height: 812 });
      await audit('results populated 375 advanced');
      await page.screenshot({ path: resolve(output, 'advanced-results-populated-375.png'), fullPage: true });
      await page.setViewportSize({ width: 1440, height: 900 });

      await openProject(runFixture(false, '1s'));
      await page.locator('#run-btn').click();
      await page.waitForFunction(() => document.querySelector('#run-state').textContent === 'PASSED', null, { timeout: 30000 });
      assert.equal(await page.locator('#req-log-count').textContent(), '0', 'Request details are opt-in');
      assert.equal(runPosts.length, 2, 'One POST /api/run per run');
      checks.push(`A8/A9 real local run (127.0.0.1 only, switch mid-run): request rows capped at 500, live log capped at 1500 lines with notice; query/response secrets [REDACTED]; response and request-name markup stays text (0 <img>, no script ran); PASSED verdict; request details off → 0 rows`);
    } finally {
      target.closeAllConnections?.();
      await new Promise(done => target.close(done));
    }
  }

  // 6. Layout, contrast and clipping at every viewport and zoom 200% (A10).
  if (sections.has('layout')) {
    const viewsFor = mode => mode === 'simple'
      ? ['flow', 'data', 'vars', 'headers', 'sla', 'load', 'script', 'results']
      : ['flow', 'vars', 'headers', 'load', 'sla', 'script', 'results'];
    const sweep = async (target, label) => {
      await openProject(RICH, target);
      for (const mode of ['simple', 'advanced']) {
        await radio(mode, target).check();
        for (const view of viewsFor(mode)) {
          const button = target.locator(`#${mode}-nav [data-view="${view}"]`);
          if (await button.count()) await button.click();
          else await navigate(view, target);
          await audit(`${label} ${mode} ${view}`, target);
        }
        await navigate('flow', target);
        if (mode === 'advanced') {
          for (const id of ['req_cart', 'grp_auth', 'req_stock']) {
            await target.locator(`#flow-outline .outline-item[data-id="${id}"]`).click();
            await audit(`${label} advanced flow ${id}`, target);
          }
          await target.locator('#flow-outline .outline-item[data-id="req_login"]').click();
        } else {
          await target.locator('#reqs-main > .req-card[data-request-id="req_login"] .subreq-pre .subreq-expand').click();
          await audit(`${label} simple flow before-details open`, target);
        }
        await settle(target);
        await target.screenshot({ path: resolve(output, `${mode}-flow-${label}.png`), fullPage: true });
      }
    };
    for (const [width, height] of [[1440, 900], [1024, 768], [768, 1024], [375, 812]]) {
      await page.setViewportSize({ width, height });
      await sweep(page, String(width));
    }
    // Chrome at 200% zoom on a 1440×900 window lays out a 720×450 CSS viewport at 2 device pixels per CSS pixel.
    const zoomed = await openPage({ viewport: { width: 720, height: 450 }, deviceScaleFactor: 2 });
    assert.equal(await zoomed.evaluate(() => [innerWidth, devicePixelRatio].join('x')), '720x2');
    await sweep(zoomed, 'zoom200');
    await zoomed.context().close();
    // Empty and long (100 requests) projects in both modes.
    for (const [width, height] of [[1440, 900], [375, 812]]) {
      await page.setViewportSize({ width, height });
      for (const [name, fixture] of [['empty', EMPTY], ['100-requests', manyRequests(100)]]) {
        await openProject(fixture);
        for (const mode of ['simple', 'advanced']) {
          await radio(mode).check();
          await navigate('flow');
          await audit(`${width} ${mode} ${name}`);
        }
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    checks.push(`A10 layout audit (${audits.length} states): Simple + Advanced × every view at 1440×900, 1024×768, 768×1024, 375×812 and zoom 200% (720×450 CSS px at 2× device pixels), plus Advanced request/group/gRPC selections, long URL, empty and 100-request projects — no sideways scroll, duplicate IDs, clipped/overlapping controls, squeezed URL field, unstyled buttons, or text contrast below WCAG AA`);
  }

  // 7. Keyboard: every Tab stop is visible and shows a focus indicator (A1, A10).
  if (sections.has('keyboard')) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openProject(RICH);
    for (const mode of ['simple', 'advanced']) {
      await radio(mode).check();
      for (const view of ['flow', 'results']) {
        await navigate(view);
        await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
        await page.locator('body').focus();
        const seen = new Set();
        const problems = [];
        let stops = 0, wrapped = false;
        for (; stops < 250; stops += 1) {
          await page.keyboard.press('Tab');
          const stop = await page.evaluate(() => {
            const element = document.activeElement;
            if (!element || element === document.body) return null;
            const path = [];
            for (let node = element; node && node !== document.body; node = node.parentElement) {
              path.unshift(`${node.tagName}${node.id ? `#${node.id}` : ''}:${[...(node.parentElement?.children || [])].indexOf(node)}`);
            }
            const indicator = element.matches('.ui-mode-switch input') ? element.nextElementSibling : element;
            const style = getComputedStyle(indicator);
            const rect = indicator.getBoundingClientRect();
            return {
              key: path.join('/'),
              name: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''} "${(element.getAttribute('aria-label') || element.textContent || element.value || '').trim().slice(0, 30)}"`,
              visible: rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden',
              indicator: (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== 'none',
            };
          });
          // Tab passes <body> once when it wraps from the end back to the top.
          if (!stop) {
            if (wrapped) break;
            wrapped = true;
            continue;
          }
          if (seen.has(stop.key)) break;
          seen.add(stop.key);
          if (!stop.visible) problems.push(`invisible focus: ${stop.name}`);
          if (!stop.indicator) problems.push(`no focus indicator: ${stop.name}`);
        }
        assert.ok(stops > 10 && stops < 250, `${mode} ${view}: Tab cycle length ${stops}`);
        assert.deepEqual(problems, [], `${mode} ${view}: keyboard focus problems`);
        checks.push(`Keyboard ${mode} ${view}: ${seen.size} Tab stops, all visible with a focus indicator`);
      }
    }
  }

  // 8. Storage hygiene (A7): only the UI-mode enum is stored by the browser.
  if (sections.has('storage')) {
    const stored = await page.evaluate(() => ({
      local: Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])),
      session: Object.keys(sessionStorage),
      cookies: document.cookie,
    }));
    assert.deepEqual(Object.keys(stored.local), ['k6ui.uiMode']);
    assert.match(stored.local['k6ui.uiMode'], /^(simple|advanced)$/);
    assert.deepEqual(stored.session, []);
    assert.equal(stored.cookies, '');
    checks.push('A7 storage after the whole session: localStorage holds only k6ui.uiMode (enum); no sessionStorage or cookies');
  }

  // 9. Measurements (A11): recorded, not enforced — host timing is noisy.
  if (sections.has('perf')) {
    await page.setViewportSize({ width: 1440, height: 900 });
    const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const restore = [], toSimple = [], toAdvanced = [];
    for (let run = 0; run < 5; run += 1) {
      await radio('advanced').check();
      restore.push(await page.evaluate(async project => {
        const { applyConfig } = await import('/js/project-io.js');
        const started = performance.now();
        applyConfig(project);
        await new Promise(done => requestAnimationFrame(() => setTimeout(done, 0)));
        return performance.now() - started;
      }, manyRequests(100)));
      for (const [mode, list] of [['simple', toSimple], ['advanced', toAdvanced]]) {
        list.push(await page.evaluate(async value => {
          const started = performance.now();
          document.querySelector(`input[name="ui-mode"][value="${value}"]`).click();
          await new Promise(done => requestAnimationFrame(() => setTimeout(done, 0)));
          return performance.now() - started;
        }, mode));
      }
    }
    assert.equal(await page.locator('#reqs-main > .req-card').count(), 100);
    Object.assign(measurements, {
      restore100MedianMs: Number(median(restore).toFixed(1)),
      switchToSimple100MedianMs: Number(median(toSimple).toFixed(1)),
      switchToAdvanced100MedianMs: Number(median(toAdvanced).toFixed(1)),
      runs: 5,
    });
    checks.push(`A11 100 requests (5 runs, recorded only): restore median ${measurements.restore100MedianMs} ms; switch to Simple ${measurements.switchToSimple100MedianMs} ms; to Advanced ${measurements.switchToAdvanced100MedianMs} ms`);
  }

  assert.deepEqual(forbidden, [], 'No request left 127.0.0.1');
  assert.deepEqual(errors, [], 'No page/console errors or unexpected dialogs');
} catch (error) {
  for (const [index, page] of pages.entries()) {
    await page.screenshot({ path: resolve(output, `failure-${index}.png`), fullPage: true }).catch(() => {});
  }
  console.error('page errors:', JSON.stringify(errors), 'forbidden:', JSON.stringify(forbidden));
  throw error;
} finally {
  await browser?.close();
  await new Promise((done, reject) => appServer.close(error => error ? reject(error) : done()));
}

// 10. The stage 2–4 checks (A1, A2, A6, A7, A8) as child processes, same environment.
const stageChecks = [];
if (!process.env.K6UI_VERIFY_SKIP_STAGE_CHECKS) {
  for (const script of ['verify-ui-mode-shell.mjs', 'verify-advanced-flow.mjs', 'verify-mode-lifecycle.mjs']) {
    const started = Date.now();
    await promisify(execFile)(process.execPath, [resolve('scripts', script)], { env: process.env, maxBuffer: 16 * 1024 * 1024 });
    stageChecks.push(`${script} passed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  }
}

const result = {
  checks, stageChecks, measurements, errors, forbidden,
  audits: { states: audits.length, contrastMeasured: audits.reduce((sum, item) => sum + item.contrast.measured, 0) },
  notVerified: [
    'Real gRPC execution (no gRPC server fixture; config and generated code only)',
    'The browser zoom control itself (zoom 200% is emulated by its CSS viewport and device scale)',
    'Placeholder text contrast and text over gradients/images (not measured)',
    'Screen readers (semantics checked through roles/labels only)',
  ],
};
console.log(JSON.stringify(result, null, 2));
await writeFile(resolve(output, 'verification.json'), JSON.stringify(result, null, 2));
