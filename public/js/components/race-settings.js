// Load Profile → Race burst (config.load.mode "race", see public/js/shared/race.js): the race
// request, VUs and timing (spread or offsets) in view; lead time, warm-up, "fail if
// late" and max duration under "Advanced timing", folded in Simple with a one-line
// summary of their values, always open in Advanced (css/views.css).
// The request list comes from the request cards as they are now, read without
// opening lazy editor panels (readRequestSettings), and is refreshed whenever the
// view is shown or the flow changes. A chosen request that is no longer offered stays
// as a marked option, so nothing is dropped silently and Run reports it. One DOM for
// Simple and Advanced; names are DOM text, never markup.
import { $, $$ } from '../dom.js';
import { readRequestSettings } from './advanced-notice.js';
import { requestTitle, thresholdRequests } from '../shared/outcome-thresholds.js';
import { DEFAULT_RACE, normalizeRace, raceOffsetEntries } from '../shared/race.js';

const NOT_RUN = {
  'the request is turned off': 'turned off',
  'the request is in a turned-off group': 'group turned off',
  'the request has no URL': 'no URL',
};

// The flow as the race sees it, from the cards and groups on the page.
function flowRequests() {
  const groups = $$('#request-groups > .request-group').map(group => ({
    id: group.dataset.groupId,
    enabled: group.querySelector('.request-group-enabled')?.checked !== false,
  }));
  const requests = $$('#reqs-main .req-card').map(card => ({
    ...readRequestSettings(card),
    id: card.dataset.requestId || '',
    name: card.querySelector('.request-name')?.value || '',
    method: card.querySelector('.method')?.value || 'GET',
    url: card.querySelector('.url')?.value || '',
  }));
  return thresholdRequests({ scenario: { groups, requests } });
}

function option(value, label) {
  const element = document.createElement('option');
  element.value = value;
  element.textContent = label;
  return element;
}

// Rebuild the race request list from the flow, keeping the chosen request.
export function refreshRaceRequests() {
  const select = $('#race-request');
  if (!select) return;
  const value = select.value;
  const requests = flowRequests();
  const first = requests.find(request => request.rq);
  const options = [option('', first ? `First request that runs (${requestTitle(first)})` : 'First request that runs')];
  for (const request of requests) {
    if (!request.id) continue;
    const why = request.skipped ? NOT_RUN[request.skipped] || 'not run' : request.type === 'grpc' ? 'gRPC, not supported' : '';
    options.push(option(request.id, why ? `${requestTitle(request)} (${why})` : requestTitle(request)));
  }
  if (value && !options.some(item => item.value === value)) options.push(option(value, 'Removed request'));
  select.replaceChildren(...options);
  select.value = value;
}

// The "Advanced timing" values in one line, so a folded section still shows them.
export function raceTimingSummary({ leadMs = '', warmup = true, failIfLate = false, maxDuration = '' } = {}) {
  return [
    `${String(leadMs).trim() || '?'} ms lead time`,
    warmup ? 'warm-up on' : 'no warm-up',
    failIfLate ? 'a late VU fails the run' : 'a late VU is a warning',
    `stops after ${String(maxDuration).trim() || '1h'}`,
  ].join(' · ');
}

function setAdvancedOpen(open) {
  $('#race-advanced-toggle')?.setAttribute('aria-expanded', String(open));
  const body = $('#race-advanced-body');
  if (body) body.hidden = !open;
}

// Which fields the timing uses; in offsets mode the VU count is the number of offsets.
function syncRaceFields() {
  const timing = $('#race-timing').value;
  const offsets = timing === 'offsets';
  $('#race-spread-field').classList.toggle('hidden', timing !== 'spread');
  $('#race-offsets-field').classList.toggle('hidden', !offsets);
  const vus = $('#race-vus');
  vus.readOnly = offsets;
  if (offsets) vus.value = String(raceOffsetEntries($('#race-offsets').value).length);
  $('#race-vus-note').textContent = offsets
    ? 'One VU per offset. Each VU runs the flow once.'
    : 'Each VU runs the flow once. A number, or a global variable like {{RACERS}}.';
  $('#race-warmup-path-field').classList.toggle('hidden', !$('#race-warmup').checked);
  const summary = $('#race-advanced-sum');
  if (summary) summary.textContent = raceTimingSummary({
    leadMs: $('#race-lead').value,
    warmup: $('#race-warmup').checked,
    failIfLate: $('#race-fail-late').checked,
    maxDuration: $('#race-max-duration').value,
  });
}

// → { vus, maxDuration, race } as typed.
export function readRaceSettings() {
  const race = normalizeRace({
    request: $('#race-request').value,
    timing: $('#race-timing').value,
    spreadMs: $('#race-spread').value,
    offsets: $('#race-offsets').value,
    leadMs: $('#race-lead').value,
    warmup: $('#race-warmup').checked,
    warmupPath: $('#race-warmup-path').value,
    failIfLate: $('#race-fail-late').checked,
  });
  const vus = race.timing === 'offsets' ? String(raceOffsetEntries(race.offsets).length) : $('#race-vus').value.trim();
  return { vus, maxDuration: $('#race-max-duration').value.trim(), race };
}

// Fill the fields from a saved load profile (call after the request cards are restored).
export function restoreRaceSettings(load = {}) {
  const race = normalizeRace(load.race);
  const select = $('#race-request');
  select.replaceChildren(option(race.request, race.request));
  select.value = race.request;
  refreshRaceRequests();
  const timing = $('#race-timing');
  timing.value = race.timing;
  if (timing.value !== race.timing) {
    timing.appendChild(option(race.timing, `${race.timing} (not a timing)`));
    timing.value = race.timing;
  }
  $('#race-vus').value = load.vus ?? '10';
  $('#race-spread').value = race.spreadMs;
  $('#race-offsets').value = race.offsets;
  $('#race-lead').value = race.leadMs;
  $('#race-warmup').checked = race.warmup;
  $('#race-warmup-path').value = race.warmupPath || DEFAULT_RACE.warmupPath;
  $('#race-fail-late').checked = race.failIfLate;
  $('#race-max-duration').value = load.maxDuration || '1h';
  syncRaceFields();
}

// Called once at startup.
export function initRaceSettings() {
  const panel = $('#load-race');
  const view = $('#view-load');
  if (!panel || !view) return;
  panel.addEventListener('input', syncRaceFields);
  panel.addEventListener('change', syncRaceFields);
  const toggle = $('#race-advanced-toggle');
  toggle?.addEventListener('click', () => setAdvancedOpen(toggle.getAttribute('aria-expanded') !== 'true'));
  // The request list follows the flow: refreshed when the view is shown and after structural edits.
  new MutationObserver(() => {
    if (!view.classList.contains('hidden')) refreshRaceRequests();
  }).observe(view, { attributes: true, attributeFilter: ['class'] });
  for (const name of ['k6ui:flow-changed', 'k6ui:request-group-changed']) {
    window.addEventListener(name, refreshRaceRequests);
  }
  refreshRaceRequests();
  syncRaceFields();
}
