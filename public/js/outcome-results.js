// "Outcomes" in the Overview of Run & Results: for each request with outcome rules,
// how many responses got each label (the `outcomes` of the `done` event, see
// public/js/shared/outcomes.js readOutcomeResults), and above them whether each outcome
// target was met (`outcomeThresholds`, see outcome-thresholds.js
// readOutcomeThresholdResults). Shown in both modes; names and labels are rendered
// with textContent only.
//
// While the test runs, every `metrics` event renders the same fields from the live
// counts (`{ live: true }`, target statuses from readLiveOutcomeThresholdResults),
// and `done` replaces them with the final values. Both go through one DOM: rows are
// kept by request, label and target number and only their text and bar width
// change, so the bars glide from one second to the next.
import { DEFAULT_OUTCOME_FALLBACK } from './shared/outcomes.js';
import { outcomeThresholdText, requestTitle as targetRequestTitle } from './shared/outcome-thresholds.js';

const TARGET_STATUS = {
  met: 'Met', 'not-met': 'Not met', skipped: 'Not checked', unknown: 'No result',
  // Live only: the count holds so far but may still break, or has not got there yet.
  'on-track': 'On track', 'not-yet': 'Not yet',
};

const STATE_NOTE = {
  live: 'Live: counts so far, updated every second while the test runs. The final counts replace them when it ends.',
  stopped: 'Counts when the run was stopped. A stopped run has no final counts.',
};

const percent = share => `${(share * 100).toFixed(share > 0 && share < 0.001 ? 2 : 1)} %`;

function requestTitle(result) {
  const name = result.name || `${result.method} ${result.url}`.trim();
  return `Request ${result.rq}${name ? ` · ${name}` : ''}`;
}

function element(tag, className) {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

// Makes `list` hold one child per item, in order: the child with the same key is
// reused (update() refreshes it), a new key gets make(). Children that stay in place
// are not moved, so a CSS transition on them keeps running.
function syncChildren(list, items, keyOf, make, update) {
  const current = new Map([...list.children].map(node => [node.dataset.key, node]));
  const nodes = items.map(item => {
    const key = String(keyOf(item));
    const node = current.get(key) || make();
    node.dataset.key = key;
    update(node, item);
    return node;
  });
  const children = list.children;
  const unchanged = nodes.length === children.length && nodes.every((node, index) => children[index] === node);
  if (!unchanged) list.replaceChildren(...nodes);
}

function makeLabelRow() {
  const row = document.createElement('li');
  const bar = element('div', 'run-outcome-bar');
  bar.setAttribute('aria-hidden', 'true');
  bar.appendChild(element('div', 'run-outcome-fill'));
  row.append(element('span', 'run-outcome-label-name'), bar, element('span', 'run-outcome-count'));
  return row;
}

function updateLabelRow(row, item, isFallback) {
  row.className = `run-outcome-label${isFallback ? ' fallback' : ''}`;
  row.dataset.label = item.label;
  row.querySelector('.run-outcome-label-name').textContent = item.label;
  row.querySelector('.run-outcome-fill').style.width = `${Math.min(100, Math.max(0, item.share * 100))}%`;
  row.querySelector('.run-outcome-count').textContent = `${item.count} (${percent(item.share)})`;
}

function makeEntry() {
  const entry = element('li', 'run-outcome');
  const head = element('div', 'run-outcome-head');
  head.append(element('span', 'run-outcome-name'), element('span', 'run-outcome-total'));
  entry.append(head, element('ul', 'run-outcome-labels'));
  return entry;
}

function updateEntry(entry, result) {
  entry.dataset.rq = String(result.rq);
  entry.querySelector('.run-outcome-name').textContent = requestTitle(result);
  entry.querySelector('.run-outcome-total').textContent = `${result.total} ${result.total === 1 ? 'response' : 'responses'}`;
  const labels = entry.querySelector('.run-outcome-labels');
  labels.setAttribute('aria-label', `Outcomes of request ${result.rq}`);
  const fallback = result.fallback || DEFAULT_OUTCOME_FALLBACK;
  syncChildren(labels, result.outcomes || [], item => item.label, makeLabelRow,
    (row, item) => updateLabelRow(row, item, item.label === fallback));
}

// One outcome target: its status, the target as typed, its request, the count.
function makeTargetRow() {
  const row = document.createElement('li');
  const body = element('span', 'run-outcome-target-text');
  body.append(element('span', 'run-outcome-target-rule'), element('span', 'run-outcome-target-request'));
  row.append(element('span', 'run-outcome-target-status'), body, element('span', 'run-outcome-target-count'));
  return row;
}

function updateTargetRow(row, target) {
  const status = TARGET_STATUS[target.status] ? target.status : 'unknown';
  row.className = `run-outcome-target ${status}`;
  row.dataset.number = String(target.number);
  row.querySelector('.run-outcome-target-status').textContent = TARGET_STATUS[status];
  row.querySelector('.run-outcome-target-rule').textContent = outcomeThresholdText(target);
  row.querySelector('.run-outcome-target-request').textContent = status === 'skipped'
    ? `${targetRequestTitle(target)}: not checked, as ${target.skipped}`
    : targetRequestTitle(target);
  row.querySelector('.run-outcome-target-count').textContent = target.count == null ? '' : `counted ${target.count}`;
}

function setState(section, state) {
  section.dataset.state = state;
  const note = document.querySelector('#run-outcomes-state');
  if (!note) return;
  note.textContent = STATE_NOTE[state] || '';
  note.hidden = !STATE_NOTE[state];
}

// results / thresholds: the `outcomes` / `outcomeThresholds` of a `done` event, or of
// a `metrics` event with { live: true }.
export function renderOutcomeResults(results, thresholds = [], { live = false } = {}) {
  const section = document.querySelector('#run-outcomes');
  const list = document.querySelector('#run-outcomes-list');
  if (!section || !list) return;
  const items = Array.isArray(results) ? results : [];
  const targets = Array.isArray(thresholds) ? thresholds : [];
  const targetList = document.querySelector('#run-outcome-targets');
  if (targetList) {
    syncChildren(targetList, targets, target => target.number, makeTargetRow, updateTargetRow);
    targetList.hidden = targets.length === 0;
  }
  syncChildren(list, items, result => result.rq, makeEntry, updateEntry);
  setState(section, live ? 'live' : 'final');
  section.hidden = items.length === 0 && targets.length === 0;
}

// The user stopped the run: what is shown stays, marked as the counts at that moment.
export function markOutcomeResultsStopped() {
  const section = document.querySelector('#run-outcomes');
  if (section?.dataset.state === 'live') setState(section, 'stopped');
}

export function resetOutcomeResults() {
  document.querySelector('#run-outcomes-list')?.replaceChildren();
  const targets = document.querySelector('#run-outcome-targets');
  if (targets) {
    targets.replaceChildren();
    targets.hidden = true;
  }
  const section = document.querySelector('#run-outcomes');
  if (section) {
    setState(section, '');
    section.hidden = true;
  }
}
