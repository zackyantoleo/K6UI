// Local presentation preference only; never part of a project or run payload.
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
    return isUiMode(value) ? value : 'advanced';
  } catch {
    return 'advanced';
  }
}
