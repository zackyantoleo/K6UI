// Run & Results → k6 output: the raw lines of the run, written to the page in batches
// (every LOG_FLUSH_MS) and capped at the MAX_LOG_LINES most recent. Text only.
import { $ } from './dom.js';

const MAX_LOG_LINES = 1500;
const LOG_FLUSH_MS = 80;

let logLines = [];
let pendingLog = [];
let logTimer = null;
let logWasTrimmed = false;

export function resetLiveLog() {
  logLines = [];
  pendingLog = [];
  logWasTrimmed = false;
  if (logTimer) clearTimeout(logTimer);
  logTimer = null;
  $('#log-output').textContent = '';
}

export function appendLog(text) {
  logLines.push(String(text));
  pendingLog.push(String(text));
  if (logLines.length > MAX_LOG_LINES) {
    logLines = logLines.slice(-MAX_LOG_LINES);
    logWasTrimmed = true;
  }
  if (!logTimer) logTimer = setTimeout(flushLog, LOG_FLUSH_MS);
}

export function flushLog() {
  logTimer = null;
  const logEl = $('#log-output');
  if (logWasTrimmed) {
    logEl.textContent = `… older lines hidden — showing the ${MAX_LOG_LINES} most recent lines …\n${logLines.join('')}`;
  } else if (pendingLog.length) {
    logEl.append(pendingLog.join(''));
  }
  pendingLog = [];
  logEl.scrollTop = logEl.scrollHeight;
}
