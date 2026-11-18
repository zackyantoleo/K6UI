// "Outcomes" in the Overview of Run & Results: for each request with outcome rules,
// how many responses got each label (the `outcomes` of the `done` event, see
// public/js/outcomes.js readOutcomeResults), and above them whether each outcome
// target was met (`outcomeThresholds`, see outcome-thresholds.js
// readOutcomeThresholdResults). Shown in both modes; names and labels are rendered
// with textContent only.
import { DEFAULT_OUTCOME_FALLBACK } from './outcomes.js';
import { outcomeThresholdText, requestTitle as targetRequestTitle } from './outcome-thresholds.js';

const TARGET_STATUS = { met: 'Met', 'not-met': 'Not met', skipped: 'Not checked', unknown: 'No result' };

const percent = share => `${(share * 100).toFixed(share > 0 && share < 0.001 ? 2 : 1)} %`;

function requestTitle(result) {
  const name = result.name || `${result.method} ${result.url}`.trim();
  return `Request ${result.rq}${name ? ` · ${name}` : ''}`;
}

function labelRow(item, isFallback) {
  const row = document.createElement('li');
  row.className = `run-outcome-label${isFallback ? ' fallback' : ''}`;
  row.dataset.label = item.label;
  const name = document.createElement('span');
  name.className = 'run-outcome-label-name';
  name.textContent = item.label;
  const bar = document.createElement('div');
  bar.className = 'run-outcome-bar';
  bar.setAttribute('aria-hidden', 'true');
  const fill = document.createElement('div');
  fill.className = 'run-outcome-fill';
  fill.style.width = `${Math.min(100, Math.max(0, item.share * 100))}%`;
  bar.appendChild(fill);
  const count = document.createElement('span');
  count.className = 'run-outcome-count';
  count.textContent = `${item.count} (${percent(item.share)})`;
  row.append(name, bar, count);
  return row;
}

// One outcome target: its status, the target as typed, its request, the count.
function targetRow(target) {
  const row = document.createElement('li');
  const status = TARGET_STATUS[target.status] ? target.status : 'unknown';
  row.className = `run-outcome-target ${status}`;
  row.dataset.number = String(target.number);
  const mark = document.createElement('span');
  mark.className = 'run-outcome-target-status';
  mark.textContent = TARGET_STATUS[status];
  const body = document.createElement('span');
  body.className = 'run-outcome-target-text';
  const rule = document.createElement('span');
  rule.className = 'run-outcome-target-rule';
  rule.textContent = outcomeThresholdText(target);
  const where = document.createElement('span');
  where.className = 'run-outcome-target-request';
  where.textContent = status === 'skipped'
    ? `${targetRequestTitle(target)}: not checked, as ${target.skipped}`
    : targetRequestTitle(target);
  body.append(rule, where);
  const count = document.createElement('span');
  count.className = 'run-outcome-target-count';
  count.textContent = target.count == null ? '' : `counted ${target.count}`;
  row.append(mark, body, count);
  return row;
}

export function renderOutcomeResults(results, thresholds = []) {
  const section = document.querySelector('#run-outcomes');
  const list = document.querySelector('#run-outcomes-list');
  if (!section || !list) return;
  const items = Array.isArray(results) ? results : [];
  const targets = Array.isArray(thresholds) ? thresholds : [];
  const targetList = document.querySelector('#run-outcome-targets');
  if (targetList) {
    targetList.replaceChildren(...targets.map(targetRow));
    targetList.hidden = targets.length === 0;
  }
  list.replaceChildren(...items.map(result => {
    const entry = document.createElement('li');
    entry.className = 'run-outcome';
    entry.dataset.rq = String(result.rq);
    const head = document.createElement('div');
    head.className = 'run-outcome-head';
    const name = document.createElement('span');
    name.className = 'run-outcome-name';
    name.textContent = requestTitle(result);
    const total = document.createElement('span');
    total.className = 'run-outcome-total';
    total.textContent = `${result.total} ${result.total === 1 ? 'response' : 'responses'}`;
    head.append(name, total);
    const labels = document.createElement('ul');
    labels.className = 'run-outcome-labels';
    labels.setAttribute('aria-label', `Outcomes of request ${result.rq}`);
    const fallback = result.fallback || DEFAULT_OUTCOME_FALLBACK;
    for (const item of result.outcomes || []) labels.appendChild(labelRow(item, item.label === fallback));
    entry.append(head, labels);
    return entry;
  }));
  section.hidden = items.length === 0 && targets.length === 0;
}

export function resetOutcomeResults() {
  document.querySelector('#run-outcomes-list')?.replaceChildren();
  const targets = document.querySelector('#run-outcome-targets');
  if (targets) {
    targets.replaceChildren();
    targets.hidden = true;
  }
  const section = document.querySelector('#run-outcomes');
  if (section) section.hidden = true;
}
