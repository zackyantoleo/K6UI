// Run & Results → k6 output: the raw lines of the run, written to the page in batches
// (every LOG_FLUSH_MS) and capped at the MAX_LOG_LINES most recent. Text only.
//
// Each batch is one text node of #log-output. Past the cap, the oldest batches leave
// (the oldest one kept is cut to fit) and a note goes first, so a flush costs the new
// batch only: rewriting all 1,500 lines every 80 ms took ~3.5 ms a flush in a fast run.
import { $ } from './dom.js';

const MAX_LOG_LINES = 1500;
const LOG_FLUSH_MS = 80;
const TRIMMED_NOTE = `… older lines hidden — showing the ${MAX_LOG_LINES} most recent lines …\n`;

let pendingLog = [];   // lines not on the page yet
let batches = [];      // on the page, oldest first: { node, lengths } (one length per line)
let shownLines = 0;
let note = null;       // the "older lines hidden" text node, once a line was dropped
let logTimer = null;

export function resetLiveLog() {
  pendingLog = [];
  batches = [];
  shownLines = 0;
  note = null;
  if (logTimer) clearTimeout(logTimer);
  logTimer = null;
  $('#log-output').textContent = '';
}

export function appendLog(text) {
  pendingLog.push(String(text));
  if (!logTimer) logTimer = setTimeout(flushLog, LOG_FLUSH_MS);
}

// Drops the `count` oldest lines on the page.
function dropOldest(count) {
  while (count > 0 && batches.length) {
    const first = batches[0];
    if (first.lengths.length <= count) {
      first.node.remove();
      batches.shift();
      shownLines -= first.lengths.length;
      count -= first.lengths.length;
    } else {
      const cut = first.lengths.splice(0, count);
      first.node.deleteData(0, cut.reduce((sum, length) => sum + length, 0));
      shownLines -= cut.length;
      count = 0;
    }
  }
}

export function flushLog() {
  if (logTimer) clearTimeout(logTimer);
  logTimer = null;
  if (!pendingLog.length) return;
  const logEl = $('#log-output');
  let lines = pendingLog;
  pendingLog = [];
  let trimmed = false;
  if (lines.length > MAX_LOG_LINES) {
    lines = lines.slice(-MAX_LOG_LINES);
    trimmed = true;
  }
  const node = document.createTextNode(lines.join(''));
  logEl.append(node);
  batches.push({ node, lengths: lines.map(line => line.length) });
  shownLines += lines.length;
  if (shownLines > MAX_LOG_LINES) {
    dropOldest(shownLines - MAX_LOG_LINES);
    trimmed = true;
  }
  if (trimmed && !note) {
    note = document.createTextNode(TRIMMED_NOTE);
    logEl.prepend(note);
  }
  logEl.scrollTop = logEl.scrollHeight;
}
