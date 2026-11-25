// "Send once" in the request editor (one DOM for Simple and Advanced): the button
// in the head of an open request sends it one time through POST /api/send-once
// (server/send-once.js) and shows the response above the editor's sections. A
// JSON value of the response is a button: clicking it adds a row to "Take a value
// from the response" with its path filled in (req-card.js takeExtraction()).
// Everything that came back is written with textContent / DOM properties, never
// parsed as markup. Nothing here is saved in the project.
import { el } from '../dom.js';
import { collectConfig } from '../config.js';
import { takeExtraction } from './req-card.js';
import {
  MAX_VALUE_BUTTONS, bodyNote, resultSummary, responseJson, selectorFor, unresolvedText, variableNameFor,
} from '../send-once.js';

// The path of each value button (object keys and array positions).
const valuePaths = new WeakMap();

function buildPanel(card) {
  const panel = el('section', 'send-once');
  panel.setAttribute('aria-label', 'Response of Send once');
  const head = el('div', 'so-head');
  const title = el('h3', 'so-title', 'Response');
  title.tabIndex = -1;
  const status = el('span', 'so-status');
  const facts = el('span', 'so-facts');
  const close = el('button', 'row-remove so-close');
  close.type = 'button';
  close.title = 'Close the response';
  close.setAttribute('aria-label', 'Close the response');
  close.textContent = '×';
  head.append(title, status, facts, close);
  const live = el('p', 'so-live');
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  const verdict = el('p', 'so-verdict');
  const error = el('p', 'so-error');
  const unresolved = el('p', 'so-unresolved');
  const note = el('p', 'so-note');
  const body = el('pre', 'so-body');
  body.setAttribute('aria-label', 'Response body');
  const headers = el('details', 'so-more so-headers');
  headers.append(el('summary', '', 'Response headers'), el('dl', 'so-list'));
  const sent = el('details', 'so-more so-sent');
  sent.append(el('summary', '', 'What was sent'), el('p', 'so-sent-line'), el('dl', 'so-list'), el('pre', 'so-sent-body'));
  const log = el('details', 'so-more so-log');
  log.append(el('summary', '', 'k6 messages'), el('ul', 'so-log-list'));
  panel.append(head, verdict, error, unresolved, live, note, body, headers, sent, log);
  card.querySelector('.req-card-body').prepend(panel);
  return panel;
}

const panelOf = card => card.querySelector('.req-card-body > .send-once') || buildPanel(card);

function fillList(dl, headers) {
  dl.replaceChildren(...Object.entries(headers || {}).flatMap(([name, value]) => [el('dt', '', name), el('dd', '', value)]));
}

function reset(panel) {
  for (const selector of ['.so-status', '.so-facts', '.so-verdict', '.so-error', '.so-unresolved', '.so-note']) {
    panel.querySelector(selector).textContent = '';
  }
  panel.querySelector('.so-status').className = 'so-status';
  for (const selector of ['.so-verdict', '.so-error', '.so-unresolved', '.so-note', '.so-body', '.so-headers', '.so-sent', '.so-log']) {
    panel.querySelector(selector).hidden = true;
  }
  panel.querySelector('.so-body').replaceChildren();
}

// The JSON as indented text, every value a button (the first MAX_VALUE_BUTTONS of
// those a selector can name); one Tab stop, arrow keys move between values.
function renderJson(pre, json, grpc) {
  let buttons = 0;
  const write = text => pre.append(document.createTextNode(text));
  const walk = (value, parts, indent, key, last) => {
    const pad = '  '.repeat(indent);
    write(pad);
    if (key !== null) {
      pre.append(el('span', 'so-key', JSON.stringify(key)));
      write(': ');
    }
    const comma = last ? '' : ',';
    if (value && typeof value === 'object') {
      const entries = Array.isArray(value) ? value.map((item, i) => [i, item]) : Object.entries(value);
      const [open, end] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
      if (!entries.length) { write(`${open}${end}${comma}\n`); return; }
      write(`${open}\n`);
      entries.forEach(([childKey, child], i) => walk(child, [...parts, childKey], indent + 1, Array.isArray(value) ? null : childKey, i === entries.length - 1));
      write(`${pad}${end}${comma}\n`);
      return;
    }
    const shown = JSON.stringify(value) ?? 'null';
    const selector = selectorFor(parts, { grpc });
    if (selector !== null && buttons < MAX_VALUE_BUTTONS) {
      const button = el('button', 'so-take', shown);
      button.type = 'button';
      button.tabIndex = buttons ? -1 : 0;
      button.title = `Take ${selector} for later requests`;
      button.setAttribute('aria-label', `${shown.length > 60 ? `${shown.slice(0, 60)}…` : shown}: take ${selector}`);
      valuePaths.set(button, parts);
      pre.append(button);
      buttons++;
    } else {
      pre.append(el('span', 'so-value', shown));
    }
    write(`${comma}\n`);
  };
  walk(json, [], 0, null, true);
  return buttons;
}

function render(card, panel, result) {
  reset(panel);
  const summary = resultSummary(result);
  const status = panel.querySelector('.so-status');
  status.textContent = summary.status;
  status.classList.add(summary.tone);
  panel.querySelector('.so-facts').textContent = [...summary.facts, `sent at ${new Date().toLocaleTimeString('en-GB')}`].join(' · ');
  const show = (selector, text) => {
    const node = panel.querySelector(selector);
    node.textContent = text;
    node.hidden = !text;
  };
  if (result.sent === false) {
    status.textContent = 'Not sent';
    status.className = 'so-status bad';
    panel.querySelector('.so-facts').textContent = `at ${new Date().toLocaleTimeString('en-GB')}`;
  } else {
    show('.so-verdict', summary.verdict);
  }
  show('.so-error', result.error || '');
  show('.so-unresolved', unresolvedText(result.unresolved));

  const response = result.response;
  if (response) {
    const body = panel.querySelector('.so-body');
    const read = responseJson(response);
    let clickable = 0;
    if (read.reason) {
      body.textContent = response.body || '';
    } else {
      clickable = renderJson(body, read.json, card.querySelector('.protocol').value === 'grpc');
    }
    body.hidden = !response.body;
    body.classList.toggle('json', !read.reason);
    show('.so-note', read.reason ? bodyNote(read.reason, response) : clickable ? bodyNote(null) : '');
    const headers = panel.querySelector('.so-headers');
    fillList(headers.querySelector('.so-list'), response.headers);
    headers.querySelector('summary').textContent = `Response headers (${Object.keys(response.headers || {}).length})`;
    headers.hidden = false;
  }
  if (result.request) {
    const sent = panel.querySelector('.so-sent');
    sent.querySelector('.so-sent-line').textContent = `${result.request.method} ${result.request.url}`;
    fillList(sent.querySelector('.so-list'), result.request.headers);
    const sentBody = sent.querySelector('.so-sent-body');
    sentBody.textContent = result.request.body || '';
    sentBody.hidden = !result.request.body;
    sent.hidden = false;
  }
  const log = panel.querySelector('.so-log');
  log.querySelector('.so-log-list').replaceChildren(...(result.log || []).map(entry => el('li', `so-log-${entry.level}`, entry.text)));
  log.hidden = !(result.log || []).length;
}

function renderProblem(panel, message) {
  reset(panel);
  const status = panel.querySelector('.so-status');
  status.textContent = 'Not sent';
  status.classList.add('bad');
  const error = panel.querySelector('.so-error');
  error.textContent = message;
  error.hidden = false;
}

async function sendOnce(card, button) {
  const panel = panelOf(card);
  panel.hidden = false;
  const live = panel.querySelector('.so-live');
  if (!card.querySelector('.url').value.trim()) {
    renderProblem(panel, 'Type a URL first.');
    live.textContent = 'Type a URL first.';
    card.querySelector('.url').focus();
    return;
  }
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = 'Sending…';
  live.textContent = 'Sending this request once…';
  panel.classList.add('sending');
  try {
    const config = collectConfig();
    const response = await fetch('/api/send-once', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config, requestId: card.dataset.requestId }),
    });
    const data = await response.json().catch(() => ({ error: `Send once failed (HTTP ${response.status}).` }));
    if (!response.ok) {
      renderProblem(panel, data.error || `Send once failed (HTTP ${response.status}).`);
      live.textContent = 'The request was not sent.';
    } else {
      render(card, panel, data);
      live.textContent = data.sent === false ? 'The request was not sent.' : `Response ${data.response?.status || 'missing'}.`;
    }
  } catch (error) {
    renderProblem(panel, `Send once failed: ${error.message}`);
    live.textContent = 'The request was not sent.';
  } finally {
    panel.classList.remove('sending');
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.textContent = 'Send once';
  }
}

function take(card, button) {
  const parts = valuePaths.get(button);
  const selector = selectorFor(parts, { grpc: card.querySelector('.protocol').value === 'grpc' });
  if (selector === null) return;
  const taken = new Set([...card.querySelectorAll('.req-card-body .extraction-row .ext-name')].map(field => field.value.trim()).filter(Boolean));
  const { name, existing } = takeExtraction(card, { varName: variableNameFor(parts, taken), source: 'json', selector });
  button.classList.add('taken');
  button.closest('.send-once').querySelector('.so-live').textContent = existing
    ? `{{${name}}} already takes ${selector}.`
    : `Took ${selector} as {{${name}}}. Later requests can use it; rename it in the Extract tab.`;
}

function moveFocus(button, key) {
  const buttons = [...button.closest('.so-body').querySelectorAll('.so-take')];
  const index = buttons.indexOf(button);
  const next = { ArrowDown: index + 1, ArrowRight: index + 1, ArrowUp: index - 1, ArrowLeft: index - 1, Home: 0, End: buttons.length - 1 }[key];
  const target = buttons[Math.max(0, Math.min(buttons.length - 1, next))];
  if (!target || target === button) return;
  button.tabIndex = -1;
  target.tabIndex = 0;
  target.focus();
}

// Called once at startup (app.js): one listener for every card, so cards that are
// replaced (opening a project) leave nothing behind.
export function initSendOnce() {
  document.addEventListener('click', event => {
    const card = event.target.closest?.('.req-card');
    if (!card) return;
    const send = event.target.closest('.req-send-once');
    if (send) {
      sendOnce(card, send);
      return;
    }
    const value = event.target.closest('.so-take');
    if (value) {
      take(card, value);
      return;
    }
    if (event.target.closest('.so-close')) {
      card.querySelector('.req-card-body > .send-once').hidden = true;
      card.querySelector('.req-send-once').focus();
    }
  });
  document.addEventListener('keydown', event => {
    const value = event.target.closest?.('.so-take');
    if (!value || !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    moveFocus(value, event.key);
  });
}
