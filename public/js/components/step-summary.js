// What each Simple step holds, in a few words under its name ("4 requests ·
// 1 group", "2 variables · 1 CSV file", "Smoke · up to 1 user · 30s · 2 goals",
// "Last run passed"), plus the counts in the block headings of the Test data and
// Load & goals pages. Presentation only: it reads the forms as typed (never a
// lazy request panel, the store, or the mode) and writes text with textContent.
import { $, $$ } from '../dom.js';
import { formatDuration, loadShape, readLoadForm, readVariables } from './load-chart.js';

const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const PRESET_NAMES = { smoke: 'Smoke', load: 'Load', stress: 'Stress' };
const RUN_TEXT = {
  idle: 'Not run yet',
  running: 'Running…',
  passed: 'Last run passed',
  'threshold-failed': 'Last run missed a goal',
  failed: 'Last run failed',
  aborted: 'Last run was stopped',
};

// The load part of the Load & goals summary; '' when the form cannot run yet.
export function loadSummary(form, shape, preset = '') {
  if (!shape || shape.problem) return '';
  let text;
  if (shape.mode === 'race') text = `Race burst · ${plural(shape.peak, 'user')}`;
  else if (shape.mode === 'iterations') {
    const runs = Math.max(1, Math.floor(Number(form.iterations)) || 1);
    text = `${plural(shape.peak, 'user')} × ${plural(runs, 'run')}`;
  } else if (shape.mode === 'stages') {
    // Stages that never change the count (Smoke: 1 user throughout) are not "up to".
    const flat = (shape.points || []).every(([, users]) => users === shape.peak);
    text = `${flat ? '' : 'up to '}${plural(shape.peak, 'user')} · ${formatDuration(shape.total)}`;
  }
  else text = `${plural(shape.peak, 'user')} · ${formatDuration(shape.total)}`;
  return PRESET_NAMES[preset] ? `${PRESET_NAMES[preset]} · ${text}` : text;
}

// state: { requests, off, groups, variables, headers, dataFiles, load, goals, run }
// → { flow, data, load, results, vars, headersSum, files, goalsSum }
export function stepSummaries(state) {
  const flow = !state.requests ? 'Add what a user does' : [
    plural(state.requests, 'request'),
    state.groups ? plural(state.groups, 'group') : '',
    state.off ? `${state.off} off` : '',
  ].filter(Boolean).join(' · ');
  const dataParts = [
    state.variables ? plural(state.variables, 'variable') : '',
    state.headers ? plural(state.headers, 'shared header') : '',
    state.dataFiles ? plural(state.dataFiles, 'CSV file') : '',
  ].filter(Boolean);
  const goals = state.goals ? plural(state.goals, 'goal') : 'no goals';
  return {
    flow,
    data: dataParts.join(' · ') || 'Nothing added yet',
    load: `${state.load || 'Finish the load settings'} · ${goals}`,
    results: RUN_TEXT[state.run] || RUN_TEXT.idle,
    vars: state.variables ? plural(state.variables, 'variable') : 'None yet',
    headersSum: state.headers ? `${plural(state.headers, 'header')}, sent with every request` : 'None yet',
    files: state.dataFiles ? `${plural(state.dataFiles, 'file')} · one row per iteration` : 'None yet',
    goalsSum: state.goals ? plural(state.goals, 'goal') : 'None yet',
  };
}

// ── DOM adapter ────────────────────────────────────────────────
const filled = selector => $$(selector).filter(input => input.value.trim()).length;

function readState() {
  const cards = $$('#reqs-main > .req-card');
  const form = readLoadForm();
  const shape = loadShape(form, form.mode === 'race' ? readVariables() : []);
  const runClass = [...($('#run-state')?.classList || [])].find(name => RUN_TEXT[name]);
  return {
    requests: cards.length,
    off: cards.filter(card => card.querySelector('.request-enabled')?.checked === false).length,
    groups: $$('#request-groups .request-group').length,
    variables: filled('#global-vars-list .var-key'),
    headers: filled('#global-headers-list .h-key'),
    dataFiles: $$('#data-files-list .data-file-card').length,
    load: loadSummary(form, shape, $('.preset-btn[aria-pressed="true"]')?.dataset.preset),
    goals: filled('#p95') + filled('#errorRate') + $$('#outcome-targets-list .outcome-target-row').length,
    run: runClass || 'idle',
  };
}

const TARGETS = {
  flow: '#step-summary-flow', data: '#step-summary-data', load: '#step-summary-load', results: '#step-summary-results',
  vars: '#data-block-vars-sum', headersSum: '#data-block-headers-sum', files: '#data-block-datafiles-sum',
  goalsSum: '#load-goals-sum',
};

// Called once at startup.
export function initStepSummaries() {
  let pending = false;
  function render() {
    pending = false;
    const texts = stepSummaries(readState());
    for (const [key, selector] of Object.entries(TARGETS)) {
      const element = $(selector);
      if (element && element.textContent !== texts[key]) element.textContent = texts[key];
    }
  }
  function schedule() {
    if (pending) return;
    pending = true;
    // A task, not a microtask: a click's own handlers (adding or removing a row) run first.
    setTimeout(render, 0);
  }
  // Typing anywhere, and clicks that add or remove rows (no input event).
  for (const type of ['input', 'change', 'click']) document.addEventListener(type, schedule);
  for (const type of ['k6ui:flow-changed', 'k6ui:project-applied', 'k6ui:request-group-changed', 'k6ui:data-sets-changed']) {
    window.addEventListener(type, schedule);
  }
  // Values set from code: presets, an opened project, a run that ends.
  const observer = new MutationObserver(schedule);
  for (const selector of ['#reqs-main', '#stages', '#outcome-targets-list', '#data-files-list', '#global-vars-list', '#global-headers-list']) {
    const element = $(selector);
    if (element) observer.observe(element, { childList: true });
  }
  const runState = $('#run-state');
  if (runState) observer.observe(runState, { attributes: true, attributeFilter: ['class'] });
  for (const button of $$('.preset-btn[data-preset]')) observer.observe(button, { attributes: true, attributeFilter: ['aria-pressed'] });
  render();
}
