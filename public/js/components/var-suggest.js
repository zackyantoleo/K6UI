// {{ suggestions: typing {{ in a URL, header value, body or Save to CSV column
// opens a short list of the variables to insert, from public/js/variables.js.
// In a request's field the names it can use come first; a name a later request
// gives is marked "not available here yet". One listbox for the whole page,
// attached to the field being typed in (aria-activedescendant, no focus move):
// arrows move, Enter or Tab inserts, Escape closes. Names are DOM text.
import { variableSuggestions } from '../variables.js';
import { readFlowVariables } from './variables-panel.js';

const FIELDS = 'input.url, input.grpc-method, input.h-val, textarea.body, input.export-col-value';
const OPEN_BEFORE_CARET = /\{\{(\$?\w*)$/;
const NAME_AFTER_CARET = /^\$?\w*(\}\})?/;
const LIST_ID = 'var-suggest';

let list = null;
let live = null;
let field = null;
let items = [];
let active = 0;

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

// The request a field belongs to, and whether it is written after the request
// (Save to CSV). A shared header (global or group) belongs to none.
function contextOf(target) {
  const card = target.closest('#reqs-main > .req-card');
  return card ? { requestId: card.dataset.requestId, after: target.matches('.export-col-value') } : {};
}

// "{{tok" right before the caret → { start, prefix }, else null.
function openPlaceholder(target) {
  if (target.selectionStart !== target.selectionEnd) return null;
  const before = target.value.slice(0, target.selectionStart);
  const match = before.match(OPEN_BEFORE_CARET);
  return match ? { start: before.length - match[0].length, prefix: match[1] } : null;
}

// Where the caret is on screen: a hidden copy of the field's text up to it.
const COPIED_STYLES = [
  'boxSizing', 'width', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontFamily', 'fontSize', 'fontWeight',
  'fontStyle', 'letterSpacing', 'lineHeight', 'textTransform', 'wordSpacing', 'tabSize',
];
function caretBox(target) {
  const box = target.getBoundingClientRect();
  const style = getComputedStyle(target);
  const copy = node('div');
  for (const name of COPIED_STYLES) copy.style[name] = style[name];
  const multiline = target.tagName === 'TEXTAREA';
  Object.assign(copy.style, {
    position: 'absolute', top: '0', left: '-9999px', visibility: 'hidden', overflow: 'hidden',
    whiteSpace: multiline ? 'pre-wrap' : 'pre', overflowWrap: multiline ? 'break-word' : 'normal',
    width: multiline ? style.width : 'auto',
  });
  copy.textContent = target.value.slice(0, target.selectionStart);
  const mark = node('span', '', '​');
  copy.appendChild(mark);
  document.body.appendChild(copy);
  const left = box.left + mark.offsetLeft - target.scrollLeft;
  const top = multiline ? box.top + mark.offsetTop - target.scrollTop : box.top;
  const bottom = multiline ? top + mark.offsetHeight : box.bottom;
  copy.remove();
  return { left: Math.min(Math.max(left, box.left), box.right), top, bottom };
}

function place() {
  const caret = caretBox(field);
  list.style.left = '0px';
  list.style.top = '0px';
  const { width, height } = list.getBoundingClientRect();
  const margin = 8;
  const left = Math.min(Math.max(margin, caret.left - 12), window.innerWidth - width - margin);
  const below = caret.bottom + 4;
  const top = below + height > window.innerHeight - margin ? Math.max(margin, caret.top - height - 4) : below;
  list.style.left = `${Math.round(left)}px`;
  list.style.top = `${Math.round(top)}px`;
}

function setActive(index) {
  active = (index + items.length) % items.length;
  list.querySelectorAll('[role="option"]').forEach((option, position) => {
    option.setAttribute('aria-selected', String(position === active));
  });
  const option = list.querySelector(`#${LIST_ID}-${active}`);
  field?.setAttribute('aria-activedescendant', option.id);
  // Scroll the list only (scrollIntoView could move the page under it).
  const top = option.offsetTop;
  const bottom = top + option.offsetHeight;
  if (top < list.scrollTop) list.scrollTop = top;
  else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
}

export function closeVariableSuggest() {
  if (!list || list.hidden) return;
  list.hidden = true;
  list.replaceChildren();
  field?.removeAttribute('aria-activedescendant');
  field?.removeAttribute('aria-controls');
  field = null;
  items = [];
}

function render(target, prefix) {
  const fresh = field !== target;
  if (fresh) closeVariableSuggest();
  const suggestions = variableSuggestions(readFlowVariables(), { ...contextOf(target), prefix });
  if (!suggestions.length && prefix) return closeVariableSuggest();
  field = target;
  items = suggestions;
  field.setAttribute('aria-autocomplete', 'list');
  field.setAttribute('aria-controls', LIST_ID);
  if (!items.length) {
    list.replaceChildren(node('p', 'var-suggest-empty',
      'No variables yet. Add a global variable or a data file, or take a value from a response.'));
    field.removeAttribute('aria-activedescendant');
  } else {
    list.replaceChildren(...items.map((item, index) => {
      const option = node('div', `var-suggest-item${item.available === false ? ' is-later' : ''}`);
      option.id = `${LIST_ID}-${index}`;
      option.setAttribute('role', 'option');
      option.dataset.index = String(index);
      option.title = `{{${item.name}}}`;
      const detail = item.available === false ? `${item.detail}: not available here yet` : item.detail;
      option.append(node('span', 'var-suggest-name', `{{${item.name}}}`), node('span', 'var-suggest-detail', detail));
      return option;
    }));
  }
  list.hidden = false;
  if (items.length) setActive(fresh ? 0 : Math.min(active, items.length - 1));
  place();
  if (fresh) {
    live.textContent = items.length
      ? `${items.length} variable${items.length === 1 ? '' : 's'} suggested. Arrow keys to choose, Enter to insert.`
      : 'No variables yet.';
  }
}

// Replace "{{tok" (and the rest of a name and "}}" after the caret) with "{{name}}".
// execCommand keeps the field's undo history; setRangeText is the fallback.
function insert(index) {
  const target = field;
  const item = items[index];
  const open = target && item ? openPlaceholder(target) : null;
  closeVariableSuggest();
  if (!open) return;
  const caret = target.selectionStart;
  const end = caret + target.value.slice(caret).match(NAME_AFTER_CARET)[0].length;
  const text = `{{${item.name}}}`;
  target.focus();
  target.setSelectionRange(open.start, end);
  if (!document.execCommand('insertText', false, text)) {
    target.setRangeText(text, open.start, end, 'end');
    target.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function update(target) {
  const open = openPlaceholder(target);
  if (open) render(target, open.prefix);
  else if (field === target) closeVariableSuggest();
}

const fieldOf = event => (event.target instanceof Element && event.target.matches(FIELDS) ? event.target : null);

// Called once at startup (app.js).
export function initVariableSuggest() {
  list = node('div', 'var-suggest');
  list.id = LIST_ID;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Variables');
  list.hidden = true;
  live = node('p', 'sr-only');
  live.setAttribute('role', 'status');
  document.body.append(list, live);

  document.addEventListener('input', event => {
    const target = fieldOf(event);
    if (target) update(target);
  });
  // Moving the caret right after "{{name" (to change a name) opens the list; out of one closes it.
  document.addEventListener('keyup', event => {
    const target = fieldOf(event);
    if (target && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) update(target);
  });
  document.addEventListener('click', event => {
    const target = fieldOf(event);
    if (target) update(target);
  });
  document.addEventListener('keydown', event => {
    if (!field || event.target !== field || list.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeVariableSuggest();
    } else if (items.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      setActive(active + (event.key === 'ArrowDown' ? 1 : -1));
    } else if (items.length && (event.key === 'Enter' || event.key === 'Tab')) {
      event.preventDefault();
      event.stopPropagation();
      insert(active);
    }
  }, true);
  document.addEventListener('focusout', event => {
    if (event.target === field) closeVariableSuggest();
  });
  // A press on an option keeps the focus in the field.
  list.addEventListener('mousedown', event => {
    event.preventDefault();
    const option = event.target instanceof Element ? event.target.closest('[role="option"]') : null;
    if (option) insert(Number(option.dataset.index));
  });
  // The list is fixed to the window: it follows its field when the page or the
  // field scrolls, and closes once the field is out of sight.
  window.addEventListener('scroll', event => {
    if (!field || list.contains(event.target)) return;
    const box = field.getBoundingClientRect();
    if (box.bottom < 0 || box.top > window.innerHeight) closeVariableSuggest();
    else place();
  }, true);
  window.addEventListener('resize', closeVariableSuggest);
}
