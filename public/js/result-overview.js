// Run & Results → Overview, below the verdict: the key figures as cards (plain name,
// "?" help, value, the goal they are compared with, k6's own name), one row per
// request with the slowest one marked, and "What to do next". The words come from
// run-summary.js (pure); this module only writes them, with textContent. One DOM for
// Simple and Advanced. The cards are built once and updated in place, so the live
// figures (about once a second) never rebuild a focused "?" button.
import { $, el } from './dom.js';
import { helpButton } from './components/help-tips.js';
import { formatMs } from './run-summary.js';

const setText = (element, value) => {
  const next = String(value ?? '');
  if (element.textContent !== next) element.textContent = next;
};

// cards = metricCards() of run-summary.js; [] clears them.
export function renderResultCards(cards) {
  const box = $('#overview-metrics');
  if (!box) return;
  if (!cards.length) {
    box.replaceChildren();
    return;
  }
  for (const card of cards) {
    let element = box.querySelector(`.result-card[data-key="${card.key}"]`);
    if (!element) {
      element = el('article', 'result-card');
      element.dataset.key = card.key;
      const label = el('div', 'result-card-label');
      label.append(el('span', 'result-card-name'), helpButton(card.help));
      element.append(label, el('div', 'result-card-value'), el('div', 'result-card-note'),
        el('div', 'result-card-goal'), el('code', 'result-card-tech'));
      box.appendChild(element);
    }
    setText(element.querySelector('.result-card-name'), card.label);
    setText(element.querySelector('.result-card-value'), card.value);
    const note = element.querySelector('.result-card-note');
    setText(note, card.note || '');
    note.hidden = !card.note;
    const goal = element.querySelector('.result-card-goal');
    setText(goal, card.compare?.text || '');
    goal.hidden = !card.compare?.text;
    goal.className = `result-card-goal ${card.compare?.tone || 'none'}`;
    element.classList.toggle('missed', card.compare?.tone === 'bad');
    setText(element.querySelector('.result-card-tech'), card.tech);
  }
}

// model = perRequestRows(); hint = the sentence above the table; null hides the section.
export function renderPerRequest(model, hint = '') {
  const section = $('#run-per-request');
  if (!section) return;
  const rows = model?.rows || [];
  section.hidden = !rows.length;
  setText($('#run-per-request-hint'), hint);
  const body = $('#run-per-request-rows');
  body.replaceChildren();
  const longest = model?.slowest?.p95 || Math.max(0, ...rows.map(row => row.p95 || 0));
  for (const row of rows) {
    const tr = el('tr', row.slowest ? 'slowest' : '');
    tr.append(el('td', 'num', row.rq));
    const name = el('td', 'run-per-request-name');
    name.append(el('span', 'run-per-request-title', row.name));
    if (row.slowest) name.append(el('span', 'badge-slowest', 'Slowest'));
    tr.append(name);
    tr.append(el('td', 'num', row.sent == null ? '—' : row.sent.toLocaleString('en-US')));
    const failedText = row.failed == null ? '—'
      : row.failed === 0 ? '0' : `${row.failed.toLocaleString('en-US')} (${row.sent ? Number((row.failed / row.sent * 100).toFixed(1)) : 0}%)`;
    tr.append(el('td', `num${row.failed ? ' failed' : ''}`, failedText));
    tr.append(el('td', 'num', row.p95 == null ? '—' : formatMs(row.p95)));
    const barCell = el('td', 'run-per-request-bar');
    if (row.p95 != null && longest > 0) {
      const bar = el('span', 'time-bar');
      const fill = el('span', `time-bar-fill${row.slowest ? ' slow' : ''}`);
      fill.style.width = `${Math.max(2, Math.round(row.p95 / longest * 100))}%`;
      bar.append(fill);
      barCell.append(bar);
    }
    tr.append(barCell);
    body.append(tr);
  }
}

// steps = nextSteps(); act(action) runs a step's button. [] hides the section.
export function renderNextSteps(steps, act) {
  const section = $('#run-next');
  if (!section) return;
  section.hidden = !steps.length;
  const list = $('#run-next-list');
  list.replaceChildren();
  for (const step of steps) {
    const item = el('li', '', null);
    item.append(el('span', '', step.text));
    if (step.action) {
      const button = el('button', 'btn ghost sm', step.action.label);
      button.type = 'button';
      button.addEventListener('click', () => act(step.action));
      item.append(button);
    }
    list.append(item);
  }
}

export function resetOverview() {
  renderResultCards([]);
  renderPerRequest(null);
  renderNextSteps([], () => {});
  const all = $('#run-all-metrics');
  if (all) {
    all.hidden = true;
    all.open = false;
  }
}
