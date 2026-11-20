// "Label each response" section of a request (see public/js/outcomes.js): rules that give every
// response one label, top to bottom, first match wins; a response no rule
// matches gets the fallback label. One DOM for Simple and Advanced; values are
// DOM properties, never markup.
import {
  DEFAULT_OUTCOME_FALLBACK, OUTCOME_OPERATORS, OUTCOME_SOURCES, OUTCOME_VARIABLE, isBlankOutcomeRule, normalizeOutcomeRule,
} from '../../outcomes.js';

const SELECTOR_HINTS = { json: 'JSON path, e.g. code or error.code', header: 'Header name, e.g. X-Error-Code' };
const VALUE_HINTS = { equals: 'Value, e.g. PROM-422001', contains: 'Text, e.g. quota', matches: 'Regex, e.g. /quota/i' };

// Presets: each adds its rules below the ones already there.
const OUTCOME_TEMPLATES = [
  {
    label: 'By status class',
    description: '2xx success, 4xx rejected, 5xx server error',
    rules: [
      { label: 'success', status: '2xx', source: 'none' },
      { label: 'rejected', status: '4xx', source: 'none' },
      { label: 'server_error', status: '5xx', source: 'none' },
    ],
  },
  {
    label: 'Error code in the body',
    description: 'One label per error code a 4xx response carries',
    rules: [
      { label: 'success', status: '2xx', source: 'none' },
      { label: 'quota_reached', status: '4xx', source: 'json', selector: 'code', operator: 'equals', value: '' },
      { label: 'lock_rejected', status: '4xx', source: 'json', selector: 'code', operator: 'equals', value: '' },
    ],
  },
];

function input(className, placeholder, label, value = '') {
  const field = document.createElement('input');
  field.className = className;
  field.placeholder = placeholder;
  field.setAttribute('aria-label', label);
  field.value = value;
  return field;
}

function select(className, label, options, value) {
  const field = document.createElement('select');
  field.className = className;
  field.setAttribute('aria-label', label);
  for (const item of options) {
    const option = document.createElement('option');
    option.value = item.value;
    option.textContent = item.label;
    field.appendChild(option);
  }
  field.value = value;
  return field;
}

export function outcomeRuleRow(rawRule = {}, onChange = () => {}) {
  const rule = normalizeOutcomeRule(rawRule) || normalizeOutcomeRule({});
  const row = document.createElement('div');
  row.className = 'outcome-rule-row';
  const label = input('outcome-label', 'label, e.g. success', 'Outcome label', rule.label);
  const status = input('outcome-status', 'Status: 200, 4xx (empty = any)', 'Status codes', rule.status);
  const source = select('outcome-source', 'Then look at', OUTCOME_SOURCES, rule.source);
  const selector = input('outcome-selector', '', 'JSON path or header name', rule.selector);
  const operator = select('outcome-operator', 'Comparison', OUTCOME_OPERATORS, rule.operator);
  const value = input('outcome-value', '', 'Compared value', rule.value);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'row-remove';
  remove.title = 'Remove';
  remove.setAttribute('aria-label', 'Remove outcome rule');
  remove.textContent = '×';

  function sync() {
    const looks = source.value !== 'none';
    selector.classList.toggle('hidden', !looks || source.value === 'body');
    selector.placeholder = SELECTOR_HINTS[source.value] || '';
    operator.classList.toggle('hidden', !looks);
    // "exists" reads a JSON path or a header; the body is always there.
    operator.querySelector('option[value="exists"]').disabled = source.value === 'body';
    if (source.value === 'body' && operator.value === 'exists') operator.value = 'contains';
    value.classList.toggle('hidden', !looks || operator.value === 'exists');
    value.placeholder = VALUE_HINTS[operator.value] || '';
  }
  source.addEventListener('change', sync);
  operator.addEventListener('change', sync);
  remove.addEventListener('click', () => {
    row.remove();
    onChange();
  });
  sync();
  row.append(label, status, source, selector, operator, value, remove);
  return row;
}

export function readOutcomeRuleRow(row) {
  return normalizeOutcomeRule({
    label: row.querySelector('.outcome-label').value,
    status: row.querySelector('.outcome-status').value,
    source: row.querySelector('.outcome-source').value,
    selector: row.querySelector('.outcome-selector').value,
    operator: row.querySelector('.outcome-operator').value,
    value: row.querySelector('.outcome-value').value,
  });
}

// → { rules, fallback } of a panel, or undefined when it has no rule rows that count
// (so a request without rules saves no `outcomes` key).
export function readOutcomesPanel(panel) {
  if (!panel) return undefined;
  const rules = [...panel.querySelectorAll('.outcome-rule-row')].map(readOutcomeRuleRow).filter(rule => !isBlankOutcomeRule(rule));
  if (!rules.length) return undefined;
  return { rules, fallback: panel.querySelector('.outcome-fallback').value.trim() || DEFAULT_OUTCOME_FALLBACK };
}

// Fill a panel from a saved request's `outcomes` (rules + fallback).
export function fillOutcomesPanel(panel, outcomes, onChange = () => {}) {
  const list = panel.querySelector('.outcome-rules-list');
  for (const rule of outcomes?.rules || []) list.appendChild(outcomeRuleRow(rule, onChange));
  const fallback = typeof outcomes?.fallback === 'string' ? outcomes.fallback.trim() : '';
  panel.querySelector('.outcome-fallback').value = fallback || DEFAULT_OUTCOME_FALLBACK;
}

export function createOutcomesPanel(onCountChange = () => {}) {
  const panel = document.createElement('div');
  panel.className = 'outcomes-panel';
  const hint = document.createElement('p');
  hint.className = 'ext-hint';
  hint.append('Give every response one label, for example success, quota reached or rejected by a lock. '
    + 'Rules are checked top to bottom and the first one that matches wins. Run & Results counts each label; ');
  const variable = document.createElement('code');
  variable.textContent = `{{${OUTCOME_VARIABLE}}}`;
  hint.append(variable, ' holds it for Save to CSV and later requests. An expected rejection (a 400 that is the right answer) '
    + 'still counts as a failed request until its status is listed under Success statuses.');
  const templates = document.createElement('div');
  templates.className = 'check-template-list';
  templates.setAttribute('aria-label', 'Outcome templates');
  const list = document.createElement('div');
  list.className = 'outcome-rules-list';
  for (const template of OUTCOME_TEMPLATES) {
    const templateButton = document.createElement('button');
    templateButton.type = 'button';
    templateButton.className = 'check-template-btn outcome-template-btn';
    const name = document.createElement('strong');
    name.textContent = template.label;
    const description = document.createElement('span');
    description.textContent = template.description;
    templateButton.append(name, description);
    templateButton.addEventListener('click', () => {
      for (const rule of template.rules) list.appendChild(outcomeRuleRow(rule, onCountChange));
      onCountChange();
    });
    templates.appendChild(templateButton);
  }
  const addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.className = 'add-row-btn add-outcome-rule';
  addButton.textContent = '+ Add rule';
  addButton.addEventListener('click', () => {
    const row = outcomeRuleRow({}, onCountChange);
    list.appendChild(row);
    row.querySelector('.outcome-label').focus();
    onCountChange();
  });
  list.addEventListener('input', event => {
    if (event.target.classList.contains('outcome-label')) onCountChange();
  });

  const fallbackLabel = document.createElement('label');
  fallbackLabel.className = 'opt-label outcome-fallback-label';
  fallbackLabel.append('Any other response: ');
  const fallback = input('outcome-fallback', DEFAULT_OUTCOME_FALLBACK, 'Label for any other response', DEFAULT_OUTCOME_FALLBACK);
  fallbackLabel.appendChild(fallback);

  panel.append(hint, templates, list, addButton, fallbackLabel);
  return panel;
}
