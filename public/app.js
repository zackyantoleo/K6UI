'use strict';

// ── Utils ──────────────────────────────────────────────────────
const $ = (s, ctx = document) => ctx.querySelector(s);
const $$ = (s, ctx = document) => Array.from(ctx.querySelectorAll(s));

// ── Navigation ─────────────────────────────────────────────────
const NAV_TITLES = {
  flow:      'Alur Request',
  load:      'Profil Beban',
  sla:       'Threshold / SLA',
  script:    'Script k6',
  results:   'Jalankan & Monitor',
  vars:      'Variabel Global',
  headers:   'Headers Global',
  csv:       'Data CSV',
  cookies:   'Cookies',
  asserts:   'Assertions',
  timers:    'Timer',
  multiscen: 'Multi Skenario',
};

function navigate(viewId) {
  $$('.view').forEach(v => v.classList.toggle('hidden', v.id !== `view-${viewId}`));
  $$('.nav-link[data-view]').forEach(l => l.classList.toggle('active', l.dataset.view === viewId));
  $('#page-title').textContent = NAV_TITLES[viewId] || viewId;
}

$$('.nav-link[data-view]').forEach(link => {
  link.addEventListener('click', e => { e.preventDefault(); navigate(link.dataset.view); });
});

// Coming-soon: shake animation on click
$$('.nav-link.soon').forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    link.classList.remove('shake');
    void link.offsetWidth;
    link.classList.add('shake');
    setTimeout(() => link.classList.remove('shake'), 350);
  });
});

// ── Shared row builders ────────────────────────────────────────
function headerRow(key = '', val = '') {
  const row = document.createElement('div');
  row.className = 'header-row';
  row.innerHTML = `
    <input class="h-key" placeholder="Header (mis. Authorization)" />
    <input class="h-val" placeholder="Nilai (mis. Bearer {{token}})" />
    <button class="row-remove" title="Hapus">&times;</button>`;
  row.querySelector('.h-key').value = key;
  row.querySelector('.h-val').value = val;
  row.querySelector('.row-remove').addEventListener('click', () => row.remove());
  return row;
}

function extractionRow() {
  const row = document.createElement('div');
  row.className = 'extraction-row';
  row.innerHTML = `
    <input  class="ext-name"     placeholder="nama_variabel" />
    <select class="ext-source">
      <option value="json">Body JSON</option>
      <option value="header">Header</option>
      <option value="regex">Regex</option>
    </select>
    <input class="ext-selector" placeholder="mis. data.token" />
    <button class="row-remove" title="Hapus">&times;</button>`;

  const selInput = row.querySelector('.ext-selector');
  row.querySelector('.ext-source').addEventListener('change', e => {
    const ph = { json: 'mis. data.token  atau  items[0].id', header: 'mis. X-Auth-Token', regex: 'mis. "token":"(.+?)"' };
    selInput.placeholder = ph[e.target.value] || '';
  });
  row.querySelector('.row-remove').addEventListener('click', () => {
    const card = row.closest('.req-card');
    const ctx  = card?.dataset.context;
    row.remove();
    if (card) updateExtCount(card);
    if (ctx === 'pre') refreshConnVars();
  });
  return row;
}

// ── Request card ───────────────────────────────────────────────
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function activateTab(card, tabId) {
  $$('.req-tab',       card).forEach(t => t.classList.toggle('active', t.dataset.tab === tabId));
  $$('.req-tab-panel', card).forEach(p => p.classList.toggle('hidden', p.dataset.panel !== tabId));
}

function updateExtCount(card) {
  const n = $$('.ext-name', card).filter(i => i.value.trim()).length;
  const badge = card.querySelector('.tab-count');
  if (!badge) return;
  badge.textContent = n || '';
  badge.classList.toggle('visible', n > 0);
}

function reqCard(index, context) {
  const card = document.createElement('div');
  card.className = 'req-card';
  card.dataset.context = context;

  // ── Head (always visible) ─────────────────────────────────
  const head = document.createElement('div');
  head.className = 'req-card-head';

  const numEl = document.createElement('span');
  numEl.className = 'req-num';
  numEl.textContent = context === 'main' ? `#${index + 1}` : `${index + 1}`;

  const methodSel = document.createElement('select');
  methodSel.className = 'method';
  METHODS.forEach(m => {
    const o = document.createElement('option');
    o.value = o.textContent = m;
    methodSel.appendChild(o);
  });

  const urlInput = document.createElement('input');
  urlInput.type        = 'text';
  urlInput.className   = 'url';
  urlInput.placeholder = 'https://api.contoh.com/endpoint';

  const actions  = document.createElement('div');
  actions.className = 'req-card-actions';

  const colBtn = document.createElement('button');
  colBtn.className = 'req-action-btn';
  colBtn.title     = 'Expand / Collapse';
  colBtn.innerHTML = '<span class="chevron">▾</span>';

  const delBtn = document.createElement('button');
  delBtn.className = 'req-action-btn del';
  delBtn.title     = 'Hapus request';
  delBtn.textContent = '✕';

  actions.append(colBtn, delBtn);
  head.append(numEl, methodSel, urlInput, actions);

  // ── Body (tabs) ───────────────────────────────────────────
  const body = document.createElement('div');
  body.className = 'req-card-body';

  // Tab bar
  const tabs = document.createElement('div');
  tabs.className = 'req-tabs';
  [
    { id: 'headers',     label: 'Headers' },
    { id: 'body',        label: 'Body' },
    { id: 'extractions', label: 'Ekstraksi', badge: true },
    { id: 'options',     label: 'Opsi' },
  ].forEach((def, i) => {
    const btn = document.createElement('button');
    btn.className = 'req-tab' + (i === 0 ? ' active' : '');
    btn.dataset.tab = def.id;
    btn.textContent = def.label;
    if (def.badge) {
      const cnt = document.createElement('span');
      cnt.className = 'tab-count';
      btn.append(' ', cnt);
    }
    btn.addEventListener('click', () => activateTab(card, def.id));
    tabs.appendChild(btn);
  });

  // Panel: Headers
  const pHeaders = document.createElement('div');
  pHeaders.className   = 'req-tab-panel';
  pHeaders.dataset.panel = 'headers';
  const hList   = document.createElement('div');
  hList.className = 'headers-list';
  const addHBtn = document.createElement('button');
  addHBtn.className   = 'add-row-btn';
  addHBtn.textContent = '+ Header';
  addHBtn.addEventListener('click', () => hList.appendChild(headerRow()));
  pHeaders.append(hList, addHBtn);

  // Panel: Body
  const pBody = document.createElement('div');
  pBody.className    = 'req-tab-panel hidden';
  pBody.dataset.panel = 'body';
  const bodyTA = document.createElement('textarea');
  bodyTA.className   = 'body';
  bodyTA.placeholder = '{"key":"value"}\n\nUntuk POST/PUT/PATCH/DELETE. Gunakan {{nama_variabel}} untuk menyisipkan nilai.';
  pBody.appendChild(bodyTA);

  // Panel: Extractions
  const pExt = document.createElement('div');
  pExt.className    = 'req-tab-panel hidden';
  pExt.dataset.panel = 'extractions';
  const extHintEl = document.createElement('p');
  extHintEl.className = 'ext-hint';
  extHintEl.innerHTML = 'Ekstrak nilai dari respons, lalu gunakan <code>{{nama_variabel}}</code> di request berikutnya.';
  const extList   = document.createElement('div');
  extList.className   = 'extractions-list';
  const addExtBtn = document.createElement('button');
  addExtBtn.className   = 'add-row-btn';
  addExtBtn.textContent = '+ Ekstrak Variabel';
  addExtBtn.addEventListener('click', () => {
    extList.appendChild(extractionRow());
    updateExtCount(card);
    if (context === 'pre') refreshConnVars();
  });
  extList.addEventListener('input', e => {
    if (e.target.classList.contains('ext-name')) {
      updateExtCount(card);
      if (context === 'pre') refreshConnVars();
    }
  });
  pExt.append(extHintEl, extList, addExtBtn);

  // Panel: Options
  const pOpts = document.createElement('div');
  pOpts.className    = 'req-tab-panel hidden';
  pOpts.dataset.panel = 'options';
  const defSleep = context === 'main' ? 1 : 0;
  pOpts.innerHTML = `
    <div class="options-row">
      <label class="opt-label">
        <input type="checkbox" class="check-status" checked />
        Cek status sukses (2xx)
      </label>
      <label class="opt-label">
        Jeda setelah request (detik):
        <input type="number" class="sleep" min="0" step="0.5" value="${defSleep}" />
      </label>
    </div>`;

  body.append(tabs, pHeaders, pBody, pExt, pOpts);
  card.append(head, body);

  // ── Card events ───────────────────────────────────────────
  colBtn.addEventListener('click', e => {
    e.stopPropagation();
    card.classList.toggle('collapsed');
  });
  delBtn.addEventListener('click', () => {
    card.remove();
    if (context === 'main') renumberMain();
    if (context === 'pre')  refreshConnVars();
  });

  return card;
}

// ── Flow builder ───────────────────────────────────────────────
function buildFlowView() {
  const view = $('#view-flow');

  const preZone  = buildZone('pre',  'Pre-processor',  'Setup',           'badge-setup',
    'Berjalan <strong>sekali</strong> sebelum VU mulai — cocok untuk login &amp; mendapatkan token.', true);
  const conn1    = buildConnector('connector-pre-main');
  const mainZone = buildZone('main', 'Skenario Utama', 'Diulang tiap VU', 'badge-loop',
    'Dijalankan berulang oleh setiap virtual user selama durasi test berlangsung.', false);
  const conn2    = buildConnector('connector-main-post');
  const postZone = buildZone('post', 'Post-processor', 'Teardown',        'badge-teardown',
    'Berjalan <strong>sekali</strong> setelah semua VU selesai — cocok untuk logout &amp; cleanup.', true);

  view.append(preZone, conn1, mainZone, conn2, postZone);
}

function buildZone(ctx, title, badgeText, badgeClass, descHTML, toggleable) {
  const zone = document.createElement('div');
  zone.className = `flow-zone zone-${ctx}`;
  zone.id = `zone-${ctx}`;

  // Zone header
  const zHead = document.createElement('div');
  zHead.className = 'zone-header';

  const tGroup = document.createElement('div');
  tGroup.className = 'zone-title-group';
  tGroup.innerHTML = `<span class="zone-title">${title}</span>
    <span class="zone-badge ${badgeClass}">${badgeText}</span>`;

  if (toggleable) {
    const lbl = document.createElement('label');
    lbl.className = 'zone-toggle';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.id   = `${ctx}-enabled`;
    lbl.append(chk, document.createTextNode(' Aktifkan'));
    zHead.append(tGroup, lbl);
  } else {
    zHead.appendChild(tGroup);
  }

  const zDesc = document.createElement('div');
  zDesc.className = 'zone-desc';
  zDesc.innerHTML = descHTML;

  // Zone body
  const zBody = document.createElement('div');
  zBody.className = `zone-body${toggleable ? ' hidden' : ''}`;
  zBody.id = `zone-body-${ctx}`;

  const reqCont = document.createElement('div');
  reqCont.id = `reqs-${ctx}`;

  const addBtn = document.createElement('button');
  addBtn.className   = 'add-req-btn';
  addBtn.textContent = `+ Tambah Request`;
  addBtn.addEventListener('click', () =>
    reqCont.appendChild(reqCard(reqCont.children.length, ctx)));

  zBody.append(reqCont, addBtn);
  zone.append(zHead, zDesc, zBody);

  if (toggleable) {
    const chk = zone.querySelector(`#${ctx}-enabled`);
    chk.addEventListener('change', () => zBody.classList.toggle('hidden', !chk.checked));
  }

  return zone;
}

function buildConnector(id) {
  const c = document.createElement('div');
  c.className = 'flow-connector';
  c.id = id;
  c.innerHTML = `
    <div class="conn-line"></div>
    <div class="conn-vars"><span class="conn-empty">—</span></div>
    <div class="conn-line"></div>`;
  return c;
}

function refreshConnVars() {
  const names = $$('#reqs-pre .ext-name')
    .map(n => n.value.trim()).filter(Boolean);

  const box = $('#connector-pre-main .conn-vars');
  if (!box) return;
  box.innerHTML = names.length
    ? names.map(n => `<span class="var-pill">{{${n}}}</span>`).join('')
    : '<span class="conn-empty">Tidak ada variabel dari pre-processor</span>';
}

function renumberMain() {
  $$('#reqs-main .req-card').forEach((c, i) => {
    const n = c.querySelector('.req-num');
    if (n) n.textContent = `#${i + 1}`;
  });
}

// ── Stages builder ─────────────────────────────────────────────
function stageRow(dur = '30s', tgt = '20') {
  const row = document.createElement('div');
  row.className = 'stage-row';
  row.innerHTML = `
    <span class="lbl">Selama</span>
    <input class="stage-dur" placeholder="mis. 30s" />
    <span class="lbl">naik ke</span>
    <input class="stage-target" type="number" min="0" placeholder="VUs" />
    <button class="btn-remove-sm">&times;</button>`;
  row.querySelector('.stage-dur').value    = dur;
  row.querySelector('.stage-target').value = tgt;
  row.querySelector('.btn-remove-sm').addEventListener('click', () => row.remove());
  return row;
}

$('#add-stage').addEventListener('click', () => $('#stages').appendChild(stageRow()));

$$('input[name="load-mode"]').forEach(r =>
  r.addEventListener('change', () => {
    const m = $('input[name="load-mode"]:checked').value;
    $('#load-simple').classList.toggle('hidden', m !== 'simple');
    $('#load-stages').classList.toggle('hidden', m !== 'stages');
  }));

// ── Config collectors ──────────────────────────────────────────
function collectHeaders(card) {
  return $$('.header-row', card)
    .map(r => ({ key: r.querySelector('.h-key').value.trim(), value: r.querySelector('.h-val').value }))
    .filter(h => h.key);
}

function collectExtractions(card) {
  return $$('.extraction-row', card)
    .map(r => ({
      varName:  r.querySelector('.ext-name').value.trim().replace(/\s+/g, '_'),
      source:   r.querySelector('.ext-source').value,
      selector: r.querySelector('.ext-selector').value.trim(),
    }))
    .filter(e => e.varName);
}

function collectReqList(containerId) {
  return $$(`#${containerId} .req-card`).map(card => ({
    method:      card.querySelector('.method').value,
    url:         card.querySelector('.url').value.trim(),
    headers:     collectHeaders(card),
    body:        card.querySelector('.body').value,
    checkStatus: card.querySelector('.check-status').checked,
    sleepAfter:  card.querySelector('.sleep').value,
    extractions: collectExtractions(card),
  }));
}

function collectConfig() {
  const mode = $('input[name="load-mode"]:checked').value;
  const load = { mode };
  if (mode === 'simple') {
    load.vus      = $('#vus').value;
    load.duration = $('#duration').value.trim();
  } else {
    load.stages = $$('.stage-row').map(s => ({
      duration: s.querySelector('.stage-dur').value.trim(),
      target:   s.querySelector('.stage-target').value,
    }));
  }

  return {
    preprocessor:  { requests: ($('#pre-enabled')?.checked  ? collectReqList('reqs-pre')  : []) },
    scenario:      { requests: collectReqList('reqs-main') },
    postprocessor: { requests: ($('#post-enabled')?.checked ? collectReqList('reqs-post') : []) },
    load,
    thresholds: { p95: $('#p95').value, errorRate: $('#errorRate').value },
    options: { logRequests: $('#log-requests')?.checked ?? true },
  };
}

function validate(config) {
  if (!config.scenario.requests.filter(r => r.url).length)
    return 'Tambahkan minimal satu request dengan URL di Skenario Utama.';
  if (config.load.mode === 'stages') {
    if (!(config.load.stages || []).filter(s => s.duration && s.target !== '').length)
      return 'Tambahkan minimal satu stage yang valid di Profil Beban.';
  }
  return null;
}

// ── Script preview ─────────────────────────────────────────────
async function loadScript() {
  const config = collectConfig();
  const err = validate(config);
  if (err) { alert(err); return; }
  try {
    const res  = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    const data = await res.json();
    $('#script-preview').textContent = data.script || data.error || '// (kosong)';
  } catch (e) {
    $('#script-preview').textContent = `// Error: ${e.message}`;
  }
  navigate('script');
}

$('#preview-btn').addEventListener('click', loadScript);
$('#refresh-script').addEventListener('click', loadScript);

$('#copy-script').addEventListener('click', () => {
  navigator.clipboard.writeText($('#script-preview').textContent);
  $('#copy-script').textContent = 'Tersalin!';
  setTimeout(() => ($('#copy-script').textContent = 'Salin'), 1600);
});

// ── Results tabs ───────────────────────────────────────────────
$$('.results-tab[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.results-tab[data-tab]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const id = btn.dataset.tab;
    $('#tab-live').classList.toggle('hidden', id !== 'live');
    $('#tab-requests').classList.toggle('hidden', id !== 'requests');
  });
});

$('#filter-errors-only')?.addEventListener('change', applyReqFilter);
$('#filter-url')?.addEventListener('input', applyReqFilter);

// ── Request log ────────────────────────────────────────────────
let reqLogs = [];

function statusClass(s) {
  if (s >= 500) return 's-5xx';
  if (s >= 400) return 's-4xx';
  if (s >= 300) return 's-3xx';
  if (s >= 200) return 's-2xx';
  return 's-other';
}

function renderReqLogRow(entry) {
  const tr = document.createElement('tr');
  tr.className = 'req-log-row' + (entry.ok ? '' : ' req-row-err');
  tr.dataset.url = entry.url;
  tr.dataset.ok  = entry.ok ? '1' : '0';
  tr.innerHTML = `
    <td>${entry.vu}</td>
    <td>${entry.it}</td>
    <td>${entry.i + 1}</td>
    <td><span class="method-badge">${entry.m}</span></td>
    <td class="req-url-cell" title="${entry.url}">${entry.url}</td>
    <td><span class="status-code ${statusClass(entry.s)}">${entry.s}</span></td>
    <td>${entry.d} ms</td>`;

  tr.addEventListener('click', () => {
    const existing = tr.nextElementSibling;
    if (existing?.classList.contains('req-detail-row')) {
      existing.remove();
      tr.classList.remove('expanded');
      return;
    }
    tr.classList.add('expanded');
    const detail = document.createElement('tr');
    detail.className = 'req-detail-row';
    detail.innerHTML = `<td colspan="7"><pre class="req-detail-body">${escHtml(entry.rb || '(kosong)')}</pre></td>`;
    tr.after(detail);
  });

  return tr;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function applyReqFilter() {
  const errOnly = $('#filter-errors-only')?.checked;
  const urlTerm = ($('#filter-url')?.value || '').toLowerCase();
  $$('#req-log-tbody .req-log-row').forEach(tr => {
    const ok  = tr.dataset.ok === '1';
    const url = (tr.dataset.url || '').toLowerCase();
    const show = (!errOnly || !ok) && (!urlTerm || url.includes(urlTerm));
    tr.classList.toggle('hidden', !show);
    const next = tr.nextElementSibling;
    if (next?.classList.contains('req-detail-row')) next.classList.toggle('hidden', !show);
  });
}

function resetReqLog() {
  reqLogs = [];
  $('#req-log-tbody').innerHTML = '';
  $('#req-log-count').textContent = '0';
}

// ── Run test ───────────────────────────────────────────────────
let abortCtrl = null;

function setRunning(running) {
  $('#run-btn').classList.toggle('hidden', running);
  $('#stop-btn').classList.toggle('hidden', !running);
  const dot = $('#nav-run-dot');
  if (running) {
    dot.className = 'run-dot running';
    dot.classList.remove('hidden');
  } else {
    dot.classList.add('hidden');
  }
}

async function runTest() {
  const config = collectConfig();
  const err = validate(config);
  if (err) { alert(err); return; }

  navigate('results');
  const logEl   = $('#log-output');
  const stateEl = $('#run-state');

  logEl.textContent = '';
  $('#run-metrics').classList.add('hidden');
  $('#run-metrics').innerHTML = '';
  stateEl.textContent = 'BERJALAN';
  stateEl.className   = 'run-state-badge running';
  resetReqLog();
  // Switch to live tab at start
  $$('.results-tab[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === 'live'));
  $('#tab-live').classList.remove('hidden');
  $('#tab-requests').classList.add('hidden');
  setRunning(true);

  abortCtrl = new AbortController();

  try {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
      signal: abortCtrl.signal,
    });

    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || `Server error ${res.status}`);
    }

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let   buffer  = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop();
      for (const raw of chunks) {
        if (!raw.trim()) continue;
        const em = raw.match(/^event: (.+)$/m);
        const dm = raw.match(/^data: (.+)$/m);
        if (dm) handleSSE(em ? em[1] : 'message', JSON.parse(dm[1]));
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      logEl.textContent += `\n[ERROR] ${e.message}\n`;
      stateEl.textContent = 'GAGAL';
      stateEl.className   = 'run-state-badge fail';
    }
  } finally {
    setRunning(false);
    abortCtrl = null;
  }
}

function handleSSE(event, data) {
  const logEl   = $('#log-output');
  const stateEl = $('#run-state');
  const dot     = $('#nav-run-dot');

  if (event === 'log') {
    logEl.textContent += data.line;
    logEl.scrollTop = logEl.scrollHeight;
  } else if (event === 'status') {
    logEl.textContent += `[${data.message}]\n`;
  } else if (event === 'error') {
    logEl.textContent += `\n[ERROR] ${data.message}\n`;
    stateEl.textContent = 'GAGAL'; stateEl.className = 'run-state-badge fail';
  } else if (event === 'req-log') {
    reqLogs.push(data);
    $('#req-log-count').textContent = reqLogs.length;
    const tbody = $('#req-log-tbody');
    const row = renderReqLogRow(data);
    // apply current filter before appending
    const errOnly = $('#filter-errors-only')?.checked;
    const urlTerm = ($('#filter-url')?.value || '').toLowerCase();
    if ((errOnly && data.ok) || (urlTerm && !data.url.toLowerCase().includes(urlTerm))) {
      row.classList.add('hidden');
    }
    tbody.appendChild(row);
  } else if (event === 'done') {
    const ok = data.code === 0;
    stateEl.textContent = ok ? 'SELESAI ✓' : 'THRESHOLD TIDAK TERPENUHI';
    stateEl.className   = 'run-state-badge ' + (ok ? 'ok' : 'fail');
    dot.className = 'run-dot done'; dot.classList.remove('hidden');
    if (data.summary) renderMetrics(data.summary);
  }
}

function fmt(n, d = 2) {
  return n == null || Number.isNaN(n) ? '-' : Number(n).toFixed(d);
}

function renderMetrics(summary) {
  const m = summary.metrics || {};
  const cards = [];
  const reqs  = m.http_reqs;
  const dur   = m.http_req_duration;
  const fail  = m.http_req_failed;

  if (reqs)       cards.push({ label: 'Total Request',   val: reqs.count ?? '-' });
  if (reqs?.rate) cards.push({ label: 'Request/detik',   val: fmt(reqs.rate, 1) });
  if (dur) {
    cards.push({ label: 'Respons avg',  val: fmt(dur.avg)        + ' ms' });
    cards.push({ label: 'Respons p95',  val: fmt(dur['p(95)'])   + ' ms' });
    cards.push({ label: 'Respons maks', val: fmt(dur.max)        + ' ms' });
  }
  if (fail?.value != null) {
    const pct = fail.value * 100;
    cards.push({ label: 'Error rate', val: fmt(pct, 2) + ' %', good: pct === 0 });
  }
  if (m.vus_max?.value != null) cards.push({ label: 'VUs maks', val: m.vus_max.value });

  const el = $('#run-metrics');
  el.innerHTML = cards.map(c => `
    <div class="metric-card">
      <div class="mc-label">${c.label}</div>
      <div class="mc-value ${c.good === true ? 'ok' : c.good === false ? 'bad' : ''}">${c.val}</div>
    </div>`).join('');
  el.classList.remove('hidden');
}

$('#run-btn').addEventListener('click', runTest);
$('#stop-btn').addEventListener('click', () => {
  if (abortCtrl) abortCtrl.abort();
  $('#run-state').textContent = 'DIHENTIKAN';
  $('#run-state').className   = 'run-state-badge fail';
  setRunning(false);
});

// ── k6 status ──────────────────────────────────────────────────
async function checkK6() {
  const el = $('#k6-status');
  try {
    const { installed } = await (await fetch('/api/k6-status')).json();
    el.textContent = installed ? 'k6 terpasang ✓' : 'k6 tidak terpasang';
    el.className   = 'k6-pill ' + (installed ? 'ok' : 'bad');
  } catch {
    el.textContent = 'k6 tidak terpasang';
    el.className   = 'k6-pill bad';
  }
}

// ── Save / Open project ────────────────────────────────────────
function saveProject() {
  const cfg = collectConfig();
  // Always capture all requests regardless of zone toggle state
  cfg.preprocessor  = { enabled: !!$('#pre-enabled')?.checked,  requests: collectReqList('reqs-pre') };
  cfg.postprocessor = { enabled: !!$('#post-enabled')?.checked, requests: collectReqList('reqs-post') };

  const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: 'k6-project.json',
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

function fillCard(card, req) {
  card.querySelector('.method').value = req.method || 'GET';
  card.querySelector('.url').value    = req.url    || '';
  card.querySelector('.body').value   = req.body   || '';
  card.querySelector('.check-status').checked = req.checkStatus !== false;
  const defSleep = card.dataset.context === 'main' ? 1 : 0;
  card.querySelector('.sleep').value = req.sleepAfter ?? defSleep;

  const hList = card.querySelector('.headers-list');
  for (const h of req.headers || []) {
    if (h.key) hList.appendChild(headerRow(h.key, h.value));
  }

  const extList = card.querySelector('.extractions-list');
  for (const e of req.extractions || []) {
    if (!e.varName) continue;
    const row = extractionRow();
    row.querySelector('.ext-name').value     = e.varName;
    row.querySelector('.ext-source').value   = e.source   || 'json';
    row.querySelector('.ext-selector').value = e.selector || '';
    row.querySelector('.ext-source').dispatchEvent(new Event('change'));
    extList.appendChild(row);
  }
  updateExtCount(card);
}

function restoreZone(containerId, ctx, requests, enabled) {
  const container = $('#' + containerId);
  container.innerHTML = '';

  if (ctx !== 'main') {
    const chk      = $(`#${ctx}-enabled`);
    const zoneBody = $(`#zone-body-${ctx}`);
    const active   = enabled || requests.length > 0;
    if (chk)      chk.checked = active;
    if (zoneBody) zoneBody.classList.toggle('hidden', !active);
  }

  for (let i = 0; i < requests.length; i++) {
    const card = reqCard(i, ctx);
    fillCard(card, requests[i]);
    container.appendChild(card);
  }
  if (ctx === 'main') renumberMain();
}

function applyConfig(cfg) {
  // Load profile
  const mode = cfg.load?.mode || 'simple';
  const modeRadio = $(`input[name="load-mode"][value="${mode}"]`);
  if (modeRadio) modeRadio.checked = true;
  $('#load-simple').classList.toggle('hidden', mode !== 'simple');
  $('#load-stages').classList.toggle('hidden', mode !== 'stages');

  if (mode === 'simple') {
    $('#vus').value      = cfg.load?.vus      ?? 10;
    $('#duration').value = cfg.load?.duration ?? '30s';
  } else {
    const stagesEl = $('#stages');
    stagesEl.innerHTML = '';
    const savedStages = cfg.load?.stages || [];
    if (savedStages.length) {
      savedStages.forEach(s => stagesEl.appendChild(stageRow(s.duration, s.target)));
    } else {
      stagesEl.appendChild(stageRow());
    }
  }

  // Thresholds
  $('#p95').value        = cfg.thresholds?.p95       ?? '';
  $('#errorRate').value  = cfg.thresholds?.errorRate ?? '';

  // Log requests option
  const logReqEl = $('#log-requests');
  if (logReqEl) logReqEl.checked = cfg.options?.logRequests ?? true;

  // Rebuild request zones
  restoreZone('reqs-pre',  'pre',  cfg.preprocessor?.requests  || [], cfg.preprocessor?.enabled  ?? false);
  restoreZone('reqs-main', 'main', cfg.scenario?.requests       || [], true);
  restoreZone('reqs-post', 'post', cfg.postprocessor?.requests || [], cfg.postprocessor?.enabled ?? false);

  refreshConnVars();
  navigate('flow');
}

$('#save-project-btn').addEventListener('click', e => { e.preventDefault(); saveProject(); });

$('#open-project-btn').addEventListener('click', e => {
  e.preventDefault();
  $('#project-file-input').value = '';
  $('#project-file-input').click();
});

$('#project-file-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const cfg = JSON.parse(ev.target.result);
      applyConfig(cfg);
    } catch {
      alert('File tidak valid. Pastikan file adalah hasil simpan dari K6UI.');
    }
  };
  reader.readAsText(file);
});

// ── Init ───────────────────────────────────────────────────────
buildFlowView();
$('#reqs-main').appendChild(reqCard(0, 'main'));

const stagesEl = $('#stages');
stagesEl.appendChild(stageRow('30s', '10'));
stagesEl.appendChild(stageRow('1m',  '20'));
stagesEl.appendChild(stageRow('30s', '0'));

refreshConnVars();
navigate('flow');
checkK6();
