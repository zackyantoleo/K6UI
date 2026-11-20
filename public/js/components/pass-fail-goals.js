// Load & goals → "Pass or fail" (Thresholds / SLA in Advanced): the p95 and error
// rate thresholds as sentences with a switch, "95% of requests finish within [500] ms"
// and "Less than [1]% of requests fail", plus "Add goal" for outcome targets
// (components/outcome-target-rows.js). The project keeps the same strings: a switch
// that is off is "" (not used), so a project without a threshold stays without one
// until a switch is turned on. While a switch is off its number is a suggestion (a
// common starting value) and the input is disabled. One DOM for Simple and Advanced;
// Advanced also shows the k6 expression of each goal.
import { $ } from '../dom.js';
import { initMenuButton } from './menu-button.js';

// Common starting values, shown while a goal is off.
export const GOAL_DEFAULTS = Object.freeze({ p95: '500', errorRate: '1' });

const GOALS = [
  { key: 'p95', input: '#p95', toggle: '#goal-p95-on', row: '#goal-p95-row', tech: '#goal-p95-tech', expression: value => `p(95)<${Number(value)}` },
  { key: 'errorRate', input: '#errorRate', toggle: '#goal-error-on', row: '#goal-error-row', tech: '#goal-error-tech', expression: value => `rate<${Number(value) / 100}` },
];

// The k6 expression a goal adds (the generator's own rule: a number, else nothing).
export function goalExpression(key, value) {
  const goal = GOALS.find(item => item.key === key);
  const text = String(value ?? '').trim();
  return goal && text !== '' && !Number.isNaN(Number(text)) ? goal.expression(text) : '';
}

// → { p95, errorRate } as the project keeps them ("" = not used).
export function readThresholdFields() {
  const values = {};
  for (const goal of GOALS) values[goal.key] = $(goal.toggle)?.checked ? $(goal.input).value : '';
  return values;
}

function sync(goal) {
  const on = $(goal.toggle).checked;
  const input = $(goal.input);
  input.disabled = !on;
  $(goal.row).classList.toggle('off', !on);
  const tech = $(goal.tech);
  if (tech) tech.textContent = on ? goalExpression(goal.key, input.value) || 'not used' : 'not used';
}

// Fill the switches from a saved project: a goal with a value is on, an empty one off.
export function restoreThresholdFields(thresholds = {}) {
  for (const goal of GOALS) {
    const value = String(thresholds?.[goal.key] ?? '').trim();
    $(goal.toggle).checked = value !== '';
    $(goal.input).value = value !== '' ? String(thresholds[goal.key]) : GOAL_DEFAULTS[goal.key];
    sync(goal);
  }
}

// Called once at startup.
export function initPassFailGoals() {
  for (const goal of GOALS) {
    $(goal.toggle).addEventListener('change', () => sync(goal));
    $(goal.input).addEventListener('input', () => sync(goal));
    sync(goal);
  }
  const button = $('#add-goal-btn');
  const menu = $('#add-goal-menu');
  if (button && menu) initMenuButton(button, menu);
}
