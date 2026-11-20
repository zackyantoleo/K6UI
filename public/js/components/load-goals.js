// Load & goals → "What do you want to find out?": five goals that start the load
// settings. Smoke, Load and Stress are presets (LOAD_PRESETS: a staged load written
// into the stage rows); Race burst is the race load mode; Custom shows the kind of
// load (fixed VUs, stages, iterations). Which goal is chosen is presentation only:
// it is never saved, the project keeps only `load`, and an opened project counts as
// Custom (Race burst for a race load). A preset asks before it replaces values that
// were typed or opened. One DOM for Simple and Advanced: Advanced also shows the kind
// of load under a preset, so the custom editor is always open there (css/views.css).
import { $, $$ } from '../dom.js';
import { stageRow } from './flow-view.js';
import { chosenGoal, readLoadMode } from './load-chart.js';

export const LOAD_PRESETS = {
  smoke:  { stages: [{ duration: '30s', target: '1' }] },
  load:   { stages: [{ duration: '1m', target: '10' }, { duration: '3m', target: '10' }, { duration: '1m', target: '0' }] },
  stress: { stages: [{ duration: '2m', target: '10' }, { duration: '2m', target: '50' }, { duration: '1m', target: '50' }, { duration: '1m', target: '0' }] },
};

export const LOAD_GOALS = {
  smoke: { name: 'Smoke', note: 'Run this first, every time you change the requests. Change the step only if you need more time or users.' },
  load: { name: 'Load', note: 'A common shape for a normal day: up to 10 users, held for a few minutes, then down again. Change the steps if you know your traffic.' },
  stress: { name: 'Stress', note: 'More users than a normal day, step by step, to see where it starts to break. Change the steps if you know your traffic.' },
  race: { name: 'Race burst', note: 'Every user runs the flow once and sends one request at a planned moment. It finds double-spend and stock bugs, not speed problems.' },
  custom: { name: 'Custom', note: '' },
};

const LOAD_FIELDS = { simple: '#load-simple', stages: '#load-stages', iterations: '#load-iterations', race: '#load-race' };

// Values typed or opened since the last preset: a preset asks before replacing them.
let custom = false;
let applying = false;

// Show the fields of a load mode (the kind of load, or race).
function showLoadFields(mode) {
  for (const [name, selector] of Object.entries(LOAD_FIELDS)) $(selector)?.classList.toggle('hidden', name !== mode);
}

// Mark a goal as chosen and show its settings.
function chooseGoal(goal) {
  const known = LOAD_GOALS[goal] ? goal : 'custom';
  for (const card of $$('.load-goal[data-goal]')) card.setAttribute('aria-pressed', String(card.dataset.goal === known));
  const settings = $('#load-settings');
  if (settings) settings.dataset.goal = known;
  $('#load-settings-title').textContent = `${LOAD_GOALS[known].name} settings`;
  const note = $('#load-goal-note');
  note.textContent = LOAD_GOALS[known].note;
  note.hidden = !LOAD_GOALS[known].note;
  showLoadFields(readLoadMode());
}

// A typed value: a preset becomes Custom with the same values.
function markCustom() {
  if (applying) return;
  custom = true;
  if (LOAD_PRESETS[chosenGoal()]) chooseGoal('custom');
}

function applyPreset(goal) {
  if (custom && !confirm('Replace your custom load values with this preset? Cancel to keep your custom load values.')) return;
  applying = true;
  $('#load-kind').value = 'stages';
  $('#stages').replaceChildren(...LOAD_PRESETS[goal].stages.map(stage => stageRow(stage.duration, stage.target)));
  chooseGoal(goal);
  applying = false;
  custom = false;
}

// An opened project: its load mode, shown as Custom (or Race burst); its values count as custom.
export function restoreLoadMode(mode) {
  if (mode !== 'race') {
    const kind = $('#load-kind');
    kind.value = mode;
    // A mode this form does not know keeps the staged editor, as before.
    if (kind.value !== mode) kind.value = 'stages';
  }
  chooseGoal(mode === 'race' ? 'race' : 'custom');
  custom = true;
}

// A reopened browser draft (draft.js): its preset goal again, after restoreLoadMode()
// showed it as Custom. A preset is only kept while it was not edited (an edit makes
// it Custom), so the stages are still the preset's.
export function restoreLoadGoal(goal) {
  if (!LOAD_PRESETS[goal] || readLoadMode() !== 'stages') return;
  chooseGoal(goal);
  custom = false;
}

// Called once at startup.
export function initLoadGoals() {
  for (const card of $$('.load-goal[data-goal]')) {
    card.addEventListener('click', () => {
      const goal = card.dataset.goal;
      if (LOAD_PRESETS[goal]) applyPreset(goal);
      else chooseGoal(goal);
    });
  }
  const settings = $('#load-settings');
  settings.addEventListener('input', markCustom);
  $('#load-kind').addEventListener('change', () => showLoadFields(readLoadMode()));
  $('#add-stage').addEventListener('click', () => {
    $('#stages').appendChild(stageRow());
    markCustom();
  });
  $('#stages').addEventListener('click', event => {
    if (event.target.closest('.btn-remove-sm')) markCustom();
  });
  window.addEventListener('k6ui:project-applied', () => { custom = true; });
  chooseGoal(chosenGoal());
}
