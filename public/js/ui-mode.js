// Local presentation preference only; never part of a project or run payload.
// Without a valid stored choice the layout is Simple, the guided one for people
// new to load testing.
import { getCurrentView, navigate } from './nav.js';
const KEY = 'k6ui.uiMode';
const isUiMode = value => value === 'simple' || value === 'advanced';

export function writeUiMode(mode, storage) {
  if (!isUiMode(mode)) return;
  try {
    (storage ?? globalThis.localStorage)?.setItem(KEY, mode);
  } catch {
    // Storage may be blocked or full; the in-session mode still works.
  }
}

// Called once at startup. Only presentation changes; the canonical forms stay put.
export function initUiMode() {
  const root = document.documentElement;
  const radios = document.querySelectorAll('input[name="ui-mode"]');
  function present(mode) {
    root.dataset.uiMode = mode;
    document.querySelectorAll('[data-ui-nav]').forEach(nav => {
      nav.hidden = nav.dataset.uiNav !== mode;
    });
    radios.forEach(radio => { radio.checked = radio.value === mode; });
    // The decorative run indicator keeps one element (runner.js updates it by
    // ID) and follows the visible nav, so a running test shows in both modes.
    const dot = document.querySelector('#nav-run-dot');
    const resultsLink = document.querySelector(`[data-ui-nav="${mode}"] .nav-link[data-view="results"]`);
    if (dot && resultsLink && dot.parentElement !== resultsLink) resultsLink.appendChild(dot);
    navigate(getCurrentView(), { focusHeading: false });
    window.dispatchEvent(new CustomEvent('k6ui:ui-mode-changed', { detail: { mode } }));
  }
  present(readUiMode());
  radios.forEach(radio => radio.addEventListener('change', () => {
    if (!radio.checked || !isUiMode(radio.value)) return;
    present(radio.value);
    writeUiMode(radio.value);
  }));
}

export function readUiMode(storage) {
  try {
    const value = (storage ?? globalThis.localStorage)?.getItem(KEY);
    return isUiMode(value) ? value : 'simple';
  } catch {
    return 'simple';
  }
}
