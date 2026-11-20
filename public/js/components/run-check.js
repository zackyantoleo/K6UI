// Run & Results → "Before you run": what will happen (requests, load sentence, target,
// goals) and a checklist from run-summary.js (every {{variable}} has a value, the
// target is not production, a goal is set), each open item with
// a button to the place that fixes it. The recording options live here too, before the
// run. Presentation only: it reads the forms as typed (never a lazy request panel, the
// store, or the mode) and writes text with textContent. One DOM for both modes.
import { $ } from '../dom.js';
import { navigate } from '../nav.js';
import { setRequestExpanded } from './req-card.js';
import { readFlowVariables } from './variables-panel.js';
import { chosenGoal, loadSentence, loadShape, raceRequestName, readLoadForm, readVariables } from './load-chart.js';
import { readThresholdFields } from './pass-fail-goals.js';
import { checklistHeadline, goalTexts, preRunChecks } from '../run-summary.js';

const ICONS = { ok: '✓', warn: '!', bad: '✕' };
// Load & goals, at one goal card ("Choose Load test" in What to do next).
export function showLoadGoal(goal) {
  navigate('load');
  const card = $(`.load-goal[data-goal="${goal}"]`);
  card?.scrollIntoView({ block: 'center' });
  card?.focus({ preventScroll: true });
}

// Build Flow, at one request: Advanced selects it in the outline, Simple opens its card.
export function showRequest(id) {
  navigate('flow');
  const card = [...document.querySelectorAll('#reqs-main > .req-card')].find(item => item.dataset.requestId === id);
  if (!card) return;
  if (document.documentElement.dataset.uiMode === 'advanced') {
    const entry = [...document.querySelectorAll('#flow-outline .outline-item')].find(item => item.dataset.id === id);
    entry?.click();
  } else {
    setRequestExpanded(card, true);
  }
  card.scrollIntoView({ block: 'start' });
  (card.querySelector('.req-var-warnings') || card.querySelector('.url'))?.focus?.({ preventScroll: true });
}

// The recording options, opened and in view (from the Requests tab or "What to do next").
export function showRecordingOptions() {
  const prerun = $('#prerun');
  if (!prerun) return;
  prerun.open = true;
  $('#prerun-record')?.scrollIntoView({ block: 'center' });
  $('#log-requests')?.focus({ preventScroll: true });
}

export function runAction(action) {
  if (!action) return;
  if (action.kind === 'view') navigate(action.value);
  else if (action.kind === 'request') showRequest(action.value);
  else if (action.kind === 'goal') showLoadGoal(action.value);
  else if (action.kind === 'record') showRecordingOptions();
}

function readState() {
  const flow = readFlowVariables();
  const form = readLoadForm();
  const shape = loadShape(form, form.mode === 'race' ? readVariables() : []);
  const goal = chosenGoal();
  const thresholds = readThresholdFields();
  const outcomeTargets = document.querySelectorAll('#outcome-targets-list .outcome-target-row').length;
  return { flow, form, shape, goal, goals: { ...thresholds, outcomeTargets } };
}

export function renderRunCheck() {
  const list = $('#prerun-checklist');
  if (!list) return;
  const state = readState();
  const { facts, items } = preRunChecks({ flow: state.flow, goals: state.goals });

  $('#prerun-requests').textContent = facts.requests
    ? `${facts.requests} will run${facts.off ? ` · ${facts.off} off` : ''}`
    : 'None will run';
  const model = state.shape && !state.shape.problem ? state.shape : null;
  $('#prerun-load').textContent = model
    ? loadSentence(state.form, model, { goal: state.goal, requests: facts.requests,
      raceRequest: state.form.mode === 'race' ? raceRequestName() : '' })
    : state.shape?.problem || 'Finish the load settings first.';
  $('#prerun-target').textContent = facts.hosts.length
    ? facts.hosts.slice(0, 3).join(', ') + (facts.hosts.length > 3 ? ` and ${facts.hosts.length - 3} more` : '')
    : 'Known only during the run';
  $('#prerun-goals').textContent = goalTexts(state.goals).join(', ') || 'None';
  $('#prerun-headline').textContent = checklistHeadline(items);

  list.replaceChildren();
  for (const item of items) {
    const row = document.createElement('li');
    row.className = `prerun-item ${item.tone}`;
    row.dataset.check = item.key;
    const icon = document.createElement('span');
    icon.className = 'prerun-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = ICONS[item.tone];
    const body = document.createElement('div');
    body.className = 'prerun-text';
    const sentence = document.createElement('p');
    const status = document.createElement('span');
    status.className = 'sr-only';
    status.textContent = item.tone === 'ok' ? 'OK: ' : item.tone === 'bad' ? 'Problem: ' : 'Check: ';
    sentence.append(status, item.text);
    body.append(sentence);
    if (item.action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn ghost sm';
      button.textContent = item.action.label;
      button.addEventListener('click', () => runAction(item.action));
      body.append(button);
    }
    row.append(icon, body);
    list.append(row);
  }
}

// Called once at startup.
export function initRunCheck() {
  window.addEventListener('k6ui:view-shown', event => {
    if (event.detail?.page === 'results') renderRunCheck();
  });
  window.addEventListener('k6ui:project-applied', () => {
    if (!$('#view-results')?.classList.contains('hidden')) renderRunCheck();
  });
  $('#req-log-options')?.addEventListener('click', showRecordingOptions);
  renderRunCheck();
}
