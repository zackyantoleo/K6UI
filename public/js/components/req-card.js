// Request card: main row (method + URL), Headers/Body/Extract/Assertions/
// Options tabs, plus optional "Before" and "After" sub-requests.
import { $$ } from '../dom.js';
import { headerRow, extractionRow } from './rows.js';
import { updateExtCount, updateAssertCount, renumberMain } from './counts.js';

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

// ── Tab helpers ────────────────────────────────────────────────
function activateTab(card, tabId) {
  $$('.req-tab',       card).forEach(t => t.classList.toggle('active', t.dataset.tab === tabId));
  $$('.req-tab-panel', card).forEach(p => p.classList.toggle('hidden', p.dataset.panel !== tabId));
}

// ── Assertion row ──────────────────────────────────────────────
// The `value` here must match the types recognized by
// server/generator/assertions.js.
const ASSERT_TYPES = [
  { value: 'status-2xx',        label: 'Status success (2xx)',   hasVal: false },
  { value: 'status-eq',         label: 'Status code ==',         hasVal: true, numVal: true,  ph: '200' },
  { value: 'status-ne',         label: 'Status code !=',         hasVal: true, numVal: true,  ph: '404' },
  { value: 'status-lt',         label: 'Status code <',          hasVal: true, numVal: true,  ph: '500' },
  { value: 'body-contains',     label: 'Body contains',          hasVal: true, ph: 'expected text' },
  { value: 'body-not-contains', label: 'Body does not contain',  hasVal: true, ph: 'unwanted text' },
  { value: 'body-matches',      label: 'Body matches regex',     hasVal: true, ph: '"key":"(\\w+)"' },
  { value: 'header-exists',     label: 'Header exists',          hasVal: true, ph: 'Authorization' },
  { value: 'header-eq',         label: 'Header == value',        hasVal: true, dualVal: true, ph: 'Header-Name', ph2: 'Expected value' },
  { value: 'duration-lt',       label: 'Response < X ms',        hasVal: true, numVal: true,  ph: '500' },
];

export function assertionRow(type = 'status-2xx', value = '', value2 = '') {
  const row = document.createElement('div');
  row.className = 'assertion-row';

  const typeSel = document.createElement('select');
  typeSel.className = 'assert-type';
  ASSERT_TYPES.forEach(t => {
    const o = document.createElement('option');
    o.value = t.value; o.textContent = t.label;
    typeSel.appendChild(o);
  });
  typeSel.value = type;

  const valInput  = document.createElement('input'); valInput.className  = 'assert-val';
  const val2Input = document.createElement('input'); val2Input.className = 'assert-val2 hidden';

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button'; removeBtn.className = 'row-remove';
  removeBtn.title = 'Remove'; removeBtn.innerHTML = '&times;';
  removeBtn.addEventListener('click', () => {
    const card = row.closest('.req-card');
    row.remove();
    if (card) updateAssertCount(card);
  });

  function syncInputs() {
    const def = ASSERT_TYPES.find(t => t.value === typeSel.value);
    if (!def) return;
    valInput.classList.toggle('hidden', !def.hasVal);
    val2Input.classList.toggle('hidden', !(def.hasVal && def.dualVal));
    if (def.hasVal) { valInput.type = def.numVal ? 'number' : 'text'; valInput.placeholder = def.ph || ''; }
    if (def.dualVal) val2Input.placeholder = def.ph2 || '';
  }

  typeSel.addEventListener('change', syncInputs);
  valInput.value = value; val2Input.value = value2;
  syncInputs();

  row.append(typeSel, valInput, val2Input, removeBtn);
  return row;
}

// ── Sub-request section ────────────────────────────────────────
function buildSubReqSection(position) {
  const isPost  = position === 'post';
  const label   = isPost ? 'After' : 'Before';
  const btnText = isPost ? '+ After Request' : '+ Before Request';

  const wrapper = document.createElement('div');
  wrapper.className = `subreq-section subreq-${position}`;

  const addBtn = document.createElement('button');
  addBtn.type = 'button'; addBtn.className = 'add-subreq-btn';
  addBtn.textContent = btnText;

  const form = document.createElement('div');
  form.className = 'subreq-form hidden';

  const formHead = document.createElement('div');
  formHead.className = 'subreq-form-head';

  const labelEl = document.createElement('span');
  labelEl.className = 'subreq-label'; labelEl.textContent = label;

  const srMethod = document.createElement('select');
  srMethod.className = 'sr-method';
  METHODS.forEach(m => { const o = document.createElement('option'); o.value = o.textContent = m; srMethod.appendChild(o); });

  const srUrl = document.createElement('input');
  srUrl.type = 'text'; srUrl.className = 'sr-url'; srUrl.placeholder = 'https://...';

  const expandBtn = document.createElement('button');
  expandBtn.type = 'button'; expandBtn.className = 'subreq-expand-btn';
  expandBtn.title = 'Headers / Body / Extract'; expandBtn.textContent = '⚙';

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button'; removeBtn.className = 'subreq-remove-btn'; removeBtn.textContent = '✕';

  formHead.append(labelEl, srMethod, srUrl, expandBtn, removeBtn);

  const formDetails = document.createElement('div');
  formDetails.className = 'subreq-form-details hidden';

  const srTabs = document.createElement('div');
  srTabs.className = 'sr-tabs';
  [{ id: 'headers', label: 'Headers' }, { id: 'body', label: 'Body' }, { id: 'ext', label: 'Extract' }]
    .forEach((def, i) => {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'sr-tab' + (i === 0 ? ' active' : '');
      btn.dataset.tab = def.id; btn.textContent = def.label;
      btn.addEventListener('click', () => {
        $$('.sr-tab',   formDetails).forEach(t => t.classList.toggle('active',  t.dataset.tab  === def.id));
        $$('.sr-panel', formDetails).forEach(p => p.classList.toggle('hidden', p.dataset.panel !== def.id));
      });
      srTabs.appendChild(btn);
    });

  const srPH = document.createElement('div');
  srPH.className = 'sr-panel'; srPH.dataset.panel = 'headers';
  const srHList = document.createElement('div'); srHList.className = 'sr-headers-list';
  const srAddH  = document.createElement('button');
  srAddH.type = 'button'; srAddH.className = 'add-row-btn'; srAddH.textContent = '+ Header';
  srAddH.addEventListener('click', () => srHList.appendChild(headerRow()));
  srPH.append(srHList, srAddH);

  const srPB = document.createElement('div');
  srPB.className = 'sr-panel hidden'; srPB.dataset.panel = 'body';
  const srBodyTA = document.createElement('textarea');
  srBodyTA.className = 'sr-body'; srBodyTA.placeholder = '{"key":"value"}';
  srPB.appendChild(srBodyTA);

  const srPE = document.createElement('div');
  srPE.className = 'sr-panel hidden'; srPE.dataset.panel = 'ext';
  const srExtList = document.createElement('div'); srExtList.className = 'sr-extractions-list';
  const srAddExt  = document.createElement('button');
  srAddExt.type = 'button'; srAddExt.className = 'add-row-btn'; srAddExt.textContent = '+ Extract Variable';
  srAddExt.addEventListener('click', () => srExtList.appendChild(extractionRow()));
  srPE.append(srExtList, srAddExt);

  formDetails.append(srTabs, srPH, srPB, srPE);
  form.append(formHead, formDetails);
  wrapper.append(addBtn, form);

  addBtn.addEventListener('click', () => { addBtn.classList.add('hidden'); form.classList.remove('hidden'); });

  expandBtn.addEventListener('click', () => {
    const open = !formDetails.classList.toggle('hidden');
    expandBtn.classList.toggle('active', open);
  });

  removeBtn.addEventListener('click', () => {
    form.classList.add('hidden'); addBtn.classList.remove('hidden');
    srMethod.value = 'GET'; srUrl.value = ''; srHList.innerHTML = '';
    srBodyTA.value = ''; srExtList.innerHTML = '';
    formDetails.classList.add('hidden'); expandBtn.classList.remove('active');
  });

  return wrapper;
}

// ── Request card ───────────────────────────────────────────────
export function reqCard(index, context) {
  const card = document.createElement('div');
  card.className = 'req-card';
  card.dataset.context = context;

  const head = document.createElement('div');
  head.className = 'req-card-head';

  const numEl = document.createElement('span');
  numEl.className = 'req-num'; numEl.textContent = `#${index + 1}`;

  const methodSel = document.createElement('select');
  methodSel.className = 'method';
  METHODS.forEach(m => { const o = document.createElement('option'); o.value = o.textContent = m; methodSel.appendChild(o); });

  const urlInput = document.createElement('input');
  urlInput.type = 'text'; urlInput.className = 'url';
  urlInput.placeholder = 'https://api.example.com/endpoint';

  const actions = document.createElement('div');
  actions.className = 'req-card-actions';

  const colBtn = document.createElement('button');
  colBtn.className = 'req-action-btn'; colBtn.title = 'Expand / Collapse';
  colBtn.innerHTML = '<span class="chevron">▾</span>';

  const delBtn = document.createElement('button');
  delBtn.className = 'req-action-btn del'; delBtn.title = 'Remove request';
  delBtn.textContent = '✕';

  actions.append(colBtn, delBtn);
  head.append(numEl, methodSel, urlInput, actions);

  const preSection = buildSubReqSection('pre');

  const body = document.createElement('div');
  body.className = 'req-card-body';

  const tabs = document.createElement('div');
  tabs.className = 'req-tabs';
  [
    { id: 'headers',    label: 'Headers' },
    { id: 'body',       label: 'Body' },
    { id: 'extractions',label: 'Extract',    badge: 'tab-count-ext' },
    { id: 'assertions', label: 'Assertions', badge: 'tab-count-assert' },
    { id: 'options',    label: 'Options' },
  ].forEach((def, i) => {
    const btn = document.createElement('button');
    btn.className = 'req-tab' + (i === 0 ? ' active' : '');
    btn.dataset.tab = def.id; btn.textContent = def.label;
    if (def.badge) { const cnt = document.createElement('span'); cnt.className = `tab-count ${def.badge}`; btn.append(' ', cnt); }
    btn.addEventListener('click', () => activateTab(card, def.id));
    tabs.appendChild(btn);
  });

  const pHeaders = document.createElement('div');
  pHeaders.className = 'req-tab-panel'; pHeaders.dataset.panel = 'headers';
  const hList = document.createElement('div'); hList.className = 'headers-list';
  const addHBtn = document.createElement('button');
  addHBtn.className = 'add-row-btn'; addHBtn.textContent = '+ Header';
  addHBtn.addEventListener('click', () => hList.appendChild(headerRow()));
  pHeaders.append(hList, addHBtn);

  const pBody = document.createElement('div');
  pBody.className = 'req-tab-panel hidden'; pBody.dataset.panel = 'body';
  const bodyTA = document.createElement('textarea');
  bodyTA.className = 'body';
  bodyTA.placeholder = '{"key":"value"}\n\nFor POST/PUT/PATCH/DELETE. Use {{variable_name}} to insert values.';
  pBody.appendChild(bodyTA);

  const pExt = document.createElement('div');
  pExt.className = 'req-tab-panel hidden'; pExt.dataset.panel = 'extractions';
  const extHintEl = document.createElement('p');
  extHintEl.className = 'ext-hint';
  extHintEl.innerHTML = 'Extract values from the response, then use <code>{{variable_name}}</code> in later requests.';
  const extList = document.createElement('div'); extList.className = 'extractions-list';
  const addExtBtn = document.createElement('button');
  addExtBtn.className = 'add-row-btn'; addExtBtn.textContent = '+ Extract Variable';
  addExtBtn.addEventListener('click', () => { extList.appendChild(extractionRow()); updateExtCount(card); });
  extList.addEventListener('input', e => { if (e.target.classList.contains('ext-name')) updateExtCount(card); });
  pExt.append(extHintEl, extList, addExtBtn);

  const pAssert = document.createElement('div');
  pAssert.className = 'req-tab-panel hidden'; pAssert.dataset.panel = 'assertions';
  const assertHint = document.createElement('p');
  assertHint.className = 'ext-hint';
  assertHint.textContent = 'Validate the response — if an assertion fails, k6 marks the request as failed.';
  const assertList = document.createElement('div'); assertList.className = 'assertions-list';
  const addAssertBtn = document.createElement('button');
  addAssertBtn.className = 'add-row-btn'; addAssertBtn.textContent = '+ Add Assertion';
  addAssertBtn.addEventListener('click', () => { assertList.appendChild(assertionRow()); updateAssertCount(card); });
  assertList.addEventListener('change', e => { if (e.target.classList.contains('assert-type')) updateAssertCount(card); });
  pAssert.append(assertHint, assertList, addAssertBtn);

  const pOpts = document.createElement('div');
  pOpts.className = 'req-tab-panel hidden'; pOpts.dataset.panel = 'options';
  pOpts.innerHTML = `
    <div class="options-row">
      <label class="opt-label">
        <input type="checkbox" class="check-status" checked />
        Check success status (2xx)
      </label>
      <label class="opt-label">
        Pause after request (seconds):
        <input type="number" class="sleep" min="0" step="0.5" value="1" />
      </label>
    </div>`;

  body.append(tabs, pHeaders, pBody, pExt, pAssert, pOpts);

  const postSection = buildSubReqSection('post');

  card.append(head, preSection, body, postSection);

  colBtn.addEventListener('click', e => { e.stopPropagation(); card.classList.toggle('collapsed'); });
  delBtn.addEventListener('click', () => { card.remove(); renumberMain(); });

  return card;
}
