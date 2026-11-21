// The browser draft: the project as typed, kept in this browser's localStorage
// (`k6ui.draft`) after each change (debounced) and when the page is hidden or
// closed, and opened again on the next page load, so a refresh or a closed tab
// loses nothing. It is never part of a project file or a run payload, and it is
// stored as typed, secrets included (the same values a saved project file holds).
//
// The page asks before leaving only when leaving would still lose something:
// while a test runs (the server stops k6 when the page goes), or when the
// browser refused the draft (storage full, often a large CSV data file, or
// blocked). "New" (top bar) drops the draft and starts from a fresh page.
//
// Pure helpers first (tested in Node), then the DOM adapter (initDraft).
import { isObject } from './shared/basics.js';
export const DRAFT_KEY = 'k6ui.draft';
export const DRAFT_VERSION = 1;
const SAVE_DELAY_MS = 700;

function storageOf(storage) {
  try {
    return storage ?? globalThis.localStorage ?? null;
  } catch {
    return null;   // a blocked localStorage getter throws
  }
}


// → true when the browser kept it.
export function writeDraft({ project, ui = {}, savedAt = Date.now() }, storage) {
  const store = storageOf(storage);
  if (typeof store?.setItem !== 'function') return false;
  try {
    store.setItem(DRAFT_KEY, JSON.stringify({ version: DRAFT_VERSION, savedAt, ui, project }));
    return true;
  } catch {
    return false;  // QuotaExceededError, or storage turned off
  }
}

// → { project, ui, savedAt } or null (none, unreadable, or another version).
export function readDraft(storage) {
  try {
    const text = storageOf(storage)?.getItem?.(DRAFT_KEY);
    if (!text) return null;
    const draft = JSON.parse(text);
    if (draft?.version !== DRAFT_VERSION || !isObject(draft.project)) return null;
    return {
      project: draft.project,
      ui: isObject(draft.ui) ? draft.ui : {},
      savedAt: Number.isFinite(draft.savedAt) ? draft.savedAt : null,
    };
  } catch {
    return null;
  }
}

export function clearDraft(storage) {
  try {
    storageOf(storage)?.removeItem?.(DRAFT_KEY);
  } catch {
    // Nothing to do: a blocked storage holds no draft either.
  }
}

// What a save compares to tell whether anything changed: the project (and `ui`) as
// text without the CSV text of its data files, plus those texts themselves. A data
// file holds up to 5 MB; stringifying it again after every click cost ~8 ms a save
// for one of 4.5 MB. A text read back from the same card is the same string, and
// `===` on the same string answers at once.
export function draftFingerprint(project, ui = null) {
  const dataSets = Array.isArray(project?.dataSets) ? project.dataSets : [];
  const contents = dataSets.map(set => (isObject(set) ? set.content : undefined));
  const light = isObject(project)
    ? { ...project, dataSets: dataSets.map(set => (isObject(set) && typeof set.content === 'string' ? { ...set, content: set.content.length } : set)) }
    : project;
  return { text: `${JSON.stringify(light)}\n${JSON.stringify(ui)}`, contents };
}

export function sameFingerprint(a, b) {
  return Boolean(a && b) && a.text === b.text && a.contents.length === b.contents.length
    && a.contents.every((content, i) => content === b.contents[i]);
}

// Leaving the page loses work only while a test runs or when the draft was refused.
export function leaveLosesWork({ running, kept }) {
  return Boolean(running) || !kept;
}

// What the top bar says about the draft. state: 'empty' | 'kept' | 'restored' | 'refused'.
export function draftStatus(state) {
  const kept = 'Your changes are kept in this browser, so a refresh or a closed tab loses nothing. Save writes a project file you can keep or share.';
  switch (state) {
    case 'kept':
      return { text: 'Kept in this browser', title: kept, icon: 'check', tone: 'kept' };
    case 'restored':
      return { text: 'Restored from your last visit', title: `${kept} New starts an empty project.`, icon: 'check', tone: 'kept' };
    case 'refused':
      return {
        text: 'Not kept in this browser',
        title: 'The browser refused to keep this project (storage full, often because of large CSV data files, or turned off). Use Save to keep it as a file: the page asks before you leave.',
        icon: 'alert',
        tone: 'refused',
      };
    default:
      return null;
  }
}

// ── DOM adapter ────────────────────────────────────────────────
// read()     → the project as typed (config.js readProjectDraft: no lazy panel is built)
// readUi()   → { view, goal }: where the user was, presentation only
// apply(project, ui) → open a draft (project-io.js applyConfig + the view and goal)
// isRunning() → a test is running (runner.js)
// Call once at startup, after the forms exist: the fresh page is the empty project.
export function initDraft({ read, readUi = () => ({}), apply, isRunning = () => false, storage }) {
  const status = document.querySelector('#draft-status');
  const readProject = () => {
    try {
      const project = read();
      return { project, print: draftFingerprint(project) };
    } catch (error) {
      console.warn('K6UI: could not read the project for the browser draft.', error);
      return null;
    }
  };

  const empty = readProject()?.print;
  let last = null;         // fingerprint (project + ui) of the last draft written or refused; null = none
  let kept = true;         // the project as typed is in the draft, or there is nothing to keep
  let discarding = false;  // "New": keep nothing more
  let timer = null;

  function show(state) {
    if (!status) return;
    const info = draftStatus(state);
    status.hidden = !info;
    if (!info) return;
    status.textContent = info.text;
    status.title = info.title;
    status.dataset.icon = info.icon;
    status.dataset.tone = info.tone;
  }

  function save() {
    clearTimeout(timer);
    timer = null;
    if (discarding) return;
    const current = readProject();
    if (!current) return;
    if (sameFingerprint(current.print, empty)) {
      // Nothing typed (or everything removed): no draft, nothing to lose.
      if (last) clearDraft(storage);
      last = null;
      kept = true;
      show('empty');
      return;
    }
    const ui = readUi();
    const print = draftFingerprint(current.project, ui);
    // Unchanged since the last write, or since the browser refused this very project
    // (trying again on every click would only cost the same refusal).
    if (sameFingerprint(print, last)) return;
    last = print;
    kept = writeDraft({ project: current.project, ui }, storage);
    show(kept ? 'kept' : 'refused');
  }

  function schedule() {
    if (discarding) return;
    clearTimeout(timer);
    timer = setTimeout(save, SAVE_DELAY_MS);
  }

  const draft = readDraft(storage);
  if (draft) {
    try {
      apply(draft.project, draft.ui);
      const restored = readProject();
      if (restored) last = draftFingerprint(restored.project, readUi());
      show('restored');
    } catch (error) {
      // Left in storage: the next change replaces it.
      console.warn('K6UI: the browser draft could not be opened.', error);
    }
  }

  // Any edit, structural change (add, remove, move, drop a file) or page change.
  for (const type of ['input', 'change', 'click', 'drop']) document.addEventListener(type, schedule, true);
  for (const type of ['k6ui:project-applied', 'k6ui:flow-changed', 'k6ui:data-sets-changed', 'k6ui:request-group-changed', 'k6ui:view-shown']) {
    window.addEventListener(type, schedule);
  }
  // Leaving: keep the latest typing at once (a refresh does not wait for the timer).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') save();
  });
  window.addEventListener('pagehide', save);
  window.addEventListener('beforeunload', event => {
    save();
    if (discarding || !leaveLosesWork({ running: isRunning(), kept })) return;
    event.preventDefault();
    event.returnValue = '';   // older browsers need it; the dialog text is the browser's own
  });

  return {
    save,
    // "New": nothing typed is kept after this; the caller reloads the page.
    discard() {
      discarding = true;
      clearTimeout(timer);
      clearDraft(storage);
    },
    // Something worth asking about before "New" throws it away.
    hasWork() {
      const current = readProject();
      return Boolean(current) && !sameFingerprint(current.print, empty);
    },
  };
}
