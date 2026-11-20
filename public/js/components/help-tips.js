// "?" help buttons and the Glossary panel. Every <button data-help="<key>">
// gets its text from glossary.js: one shared tooltip shows it under the pointer
// or keyboard focus, and a click keeps it open (touch screens). The Glossary
// panel lists every term. Text is set with textContent only.
import { $ } from '../dom.js';
import { GLOSSARY_SECTIONS, glossaryEntry, glossarySection, searchGlossary } from '../glossary.js';

const TIP_ID = 'help-tip';
let tip = null;
let anchor = null;
let pinned = false;

// A help button for markup built in JS (request editor sections, groups).
export function helpButton(key) {
  const button = document.createElement('button');
  button.dataset.help = key;
  decorate(button);
  return button;
}

function decorate(button) {
  const item = glossaryEntry(button.dataset.help);
  button.type = 'button';
  button.classList.add('help-btn');
  button.textContent = '?';
  if (item && !button.hasAttribute('aria-label')) button.setAttribute('aria-label', `About ${item.term}`);
}

function place() {
  if (!anchor || !tip) return;
  const target = anchor.getBoundingClientRect();
  tip.style.left = '0px';
  tip.style.top = '0px';
  const { width, height } = tip.getBoundingClientRect();
  const margin = 8;
  const left = Math.min(Math.max(margin, target.left + target.width / 2 - width / 2), window.innerWidth - width - margin);
  const below = target.bottom + margin;
  const top = below + height > window.innerHeight - margin ? Math.max(margin, target.top - height - margin) : below;
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
}

function show(button, { pin = false } = {}) {
  const item = glossaryEntry(button.dataset.help);
  if (!item) return;
  if (anchor && anchor !== button) anchor.removeAttribute('aria-describedby');
  anchor = button;
  pinned = pin;
  const term = document.createElement('strong');
  term.textContent = item.term;
  const text = document.createElement('span');
  text.textContent = item.text;
  tip.replaceChildren(term, text);
  tip.hidden = false;
  button.setAttribute('aria-describedby', TIP_ID);
  button.setAttribute('aria-expanded', String(pin));
  place();
}

export function hideHelpTip() {
  if (!tip) return;
  tip.hidden = true;
  anchor?.removeAttribute('aria-describedby');
  anchor?.setAttribute('aria-expanded', 'false');
  anchor = null;
  pinned = false;
}

const helpTarget = event => event.target instanceof Element ? event.target.closest('[data-help]') : null;

export function initHelpTips() {
  tip = $(`#${TIP_ID}`);
  document.querySelectorAll('[data-help]').forEach(decorate);

  document.addEventListener('mouseover', event => {
    const button = helpTarget(event);
    if (button && !pinned) show(button);
  });
  document.addEventListener('mouseout', event => {
    const button = helpTarget(event);
    if (button && button === anchor && !pinned && !button.contains(event.relatedTarget)) hideHelpTip();
  });
  document.addEventListener('focusin', event => {
    const button = helpTarget(event);
    if (button) show(button);
  });
  document.addEventListener('focusout', event => {
    if (helpTarget(event) === anchor) hideHelpTip();
  });
  document.addEventListener('click', event => {
    const button = helpTarget(event);
    if (!button) {
      if (pinned) hideHelpTip();
      return;
    }
    event.preventDefault();
    if (pinned && anchor === button) hideHelpTip();
    else show(button, { pin: true });
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && anchor) hideHelpTip();
  });
  // The tooltip is fixed to the viewport; anything that moves the button closes it.
  window.addEventListener('scroll', hideHelpTip, true);
  window.addEventListener('resize', hideHelpTip);
}

// ── Glossary panel ─────────────────────────────────────────────
function renderGlossary(list, query) {
  const keys = query.trim() ? new Set(searchGlossary(query).map(item => item.key)) : null;
  list.replaceChildren();
  for (const section of GLOSSARY_SECTIONS) {
    const items = glossarySection(section.id).filter(item => !keys || keys.has(item.key));
    if (!items.length) continue;
    const heading = document.createElement('h4');
    heading.textContent = section.title;
    const terms = document.createElement('dl');
    for (const item of items) {
      const term = document.createElement('dt');
      term.id = `glossary-${item.key}`;
      term.textContent = item.term;
      const text = document.createElement('dd');
      text.textContent = item.text;
      terms.append(term, text);
    }
    list.append(heading, terms);
  }
  if (!list.children.length) {
    const empty = document.createElement('p');
    empty.className = 'glossary-empty';
    empty.textContent = `No term matches "${query.trim()}".`;
    list.append(empty);
  }
}

export function initGlossary() {
  const overlay = $('#glossary-panel');
  const panel = overlay.querySelector('.drawer');
  const list = $('#glossary-list');
  const filter = $('#glossary-filter');
  let returnFocus = null;

  const isOpen = () => !overlay.classList.contains('hidden');
  function open() {
    returnFocus = document.activeElement;
    hideHelpTip();
    filter.value = '';
    renderGlossary(list, '');
    overlay.classList.remove('hidden');
    $('#glossary-btn').setAttribute('aria-expanded', 'true');
    filter.focus();
  }
  function close() {
    overlay.classList.add('hidden');
    $('#glossary-btn').setAttribute('aria-expanded', 'false');
    returnFocus?.focus();
    returnFocus = null;
  }

  $('#glossary-btn').addEventListener('click', open);
  $('#glossary-close').addEventListener('click', close);
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  filter.addEventListener('input', () => renderGlossary(list, filter.value));
  document.addEventListener('keydown', event => {
    if (!isOpen()) return;
    if (event.key === 'Escape') { close(); return; }
    if (event.key !== 'Tab') return;
    // Keep keyboard focus inside the open panel.
    const focusable = [...panel.querySelectorAll('button, input')].filter(node => !node.disabled);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
}
