// "Advanced settings configured" notice for Simple mode. It reports categories
// and counts only — never values — so a Simple user knows the flow carries
// settings that still run. Switching modes never changes what runs.
import { usableDataFileCount } from '../data-files.js';

const DEFAULT_PAUSE_SECONDS = 1;
const hasText = value => String(value ?? '').trim() !== '';
const pauseSeconds = value => {
  if (value === undefined || value === null) return DEFAULT_PAUSE_SECONDS;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds : 0;
};

// Request categories in display order. Each test receives one normalized request.
const REQUEST_CATEGORIES = [
  { id: 'grpc', label: 'gRPC requests', test: request => request.type === 'grpc' },
  { id: 'subRequests', label: 'Before/After requests', test: request => hasText(request.pre?.url) || hasText(request.post?.url) },
  { id: 'extractions', label: 'Response extraction', test: request => (request.extractions || []).some(item => hasText(item?.varName)) },
  { id: 'checks', label: 'Custom checks', test: request => (request.assertions || []).length > 0 },
  { id: 'scripts', label: 'Pre/post scripts', test: request => hasText(request.preScript) || hasText(request.postScript) },
  { id: 'pacing', label: 'Custom pause after request', test: request => pauseSeconds(request.sleepAfter) !== DEFAULT_PAUSE_SECONDS },
  { id: 'statusCheck', label: 'Automatic 2xx check turned off', test: request => request.checkStatus === false },
];

const hasGroupHeaders = group => (group.headers || []).some(header => hasText(header?.key));
const hasRunIf = group => Boolean(group.runIf);

// Pure: normalized requests/groups → { active, skipped, visible }. A group counts
// as conditional when it has a `runIf` condition (any truthy value).
// Only runnable requests (enabled, and not in a group that is off) count as
// active; configured-but-skipped requests and groups are tallied separately.
// `dataFiles` = CSV data files that will be used (they feed every request).
export function summarizeAdvancedSettings(requests, groups, dataFiles = 0) {
  const groupById = new Map(groups.map(group => [group.id, group]));
  const counts = new Map(REQUEST_CATEGORIES.map(category => [category.id, 0]));
  const skipped = { requests: 0, groups: 0 };
  for (const request of requests) {
    const matched = REQUEST_CATEGORIES.filter(category => category.test(request));
    if (!matched.length) continue;
    const group = groupById.get(request.groupId);
    const runs = request.enabled !== false && (!group || group.enabled !== false);
    if (!runs) {
      skipped.requests += 1;
      continue;
    }
    for (const category of matched) counts.set(category.id, counts.get(category.id) + 1);
  }
  let groupHeaders = 0;
  let conditionalGroups = 0;
  for (const group of groups) {
    if (!hasGroupHeaders(group) && !hasRunIf(group)) continue;
    if (group.enabled === false) {
      skipped.groups += 1;
      continue;
    }
    if (hasGroupHeaders(group)) groupHeaders += 1;
    if (hasRunIf(group)) conditionalGroups += 1;
  }
  const active = REQUEST_CATEGORIES
    .filter(category => counts.get(category.id) > 0)
    .map(category => ({ id: category.id, label: category.label, count: counts.get(category.id), unit: 'request' }));
  if (groupHeaders) active.push({ id: 'groupHeaders', label: 'Group header defaults', count: groupHeaders, unit: 'group' });
  if (conditionalGroups) active.push({ id: 'conditionalGroups', label: 'Conditional groups', count: conditionalGroups, unit: 'group' });
  if (dataFiles) active.push({ id: 'dataFiles', label: 'Data files', count: dataFiles, unit: 'file' });
  return { active, skipped, visible: active.length > 0 || skipped.requests > 0 || skipped.groups > 0 };
}

// ── DOM adapter ──────────────────────────────────────────────────
// A hydrated panel is the live truth; a lazy (never opened) panel falls back to
// the request it was loaded from (`card.requestState`). Reading never hydrates
// panels and never calls collectConfig(), so it is cheap enough per keystroke.
const panelReady = (card, panelId) =>
  card.querySelector(`.req-tab-panel[data-panel="${panelId}"]`)?.dataset.panelReady === 'true';

function liveSubRequest(card, position) {
  const form = card.querySelector(`.subreq-${position} .subreq-form`);
  if (!form || form.classList.contains('hidden')) return null;
  return { url: form.querySelector('.sr-url')?.value || '' };
}

export function readRequestSettings(card) {
  const saved = card.requestState || {};
  const field = selector => card.querySelector(selector);
  const scriptsReady = panelReady(card, 'scripts');
  const optionsReady = panelReady(card, 'options');
  return {
    enabled: field('.request-enabled')?.checked !== false,
    groupId: field('.request-group-select')?.value || '',
    type: field('.protocol')?.value || 'http',
    extractions: panelReady(card, 'extractions')
      ? [...card.querySelectorAll('.req-card-body .extractions-list .ext-name')].map(input => ({ varName: input.value }))
      : saved.extractions || [],
    assertions: panelReady(card, 'assertions')
      ? [...card.querySelectorAll('.req-card-body .assertions-list .assertion-row')].map(() => ({}))
      : saved.assertions || [],
    preScript: scriptsReady ? field('.pre-script').value : saved.preScript,
    postScript: scriptsReady ? field('.post-script').value : saved.postScript,
    sleepAfter: optionsReady ? field('.sleep').value : saved.sleepAfter,
    checkStatus: optionsReady ? field('.check-status').checked : saved.checkStatus !== false,
    pre: liveSubRequest(card, 'pre'),
    post: liveSubRequest(card, 'post'),
  };
}

function readGroupSettings() {
  return [...document.querySelectorAll('#request-groups > .request-group')].map(group => ({
    id: group.dataset.groupId,
    enabled: group.querySelector('.request-group-enabled')?.checked !== false,
    headers: [...group.querySelectorAll('.group-headers-list .h-key')].map(input => ({ key: input.value })),
    // A "Run only if" row that is filled in (the head badge is visible), valid or not.
    runIf: group.querySelector('.request-group-runif')?.hidden === false,
  }));
}

const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

function renderNotice(notice, summary) {
  notice.hidden = !summary.visible;
  if (!summary.visible) return;
  notice.querySelector('.advanced-notice-intro').textContent = summary.active.length
    ? 'These settings run when you start the test:'
    : 'None of these settings run right now.';
  notice.querySelector('.advanced-notice-list').replaceChildren(...summary.active.map(item => {
    const entry = document.createElement('li');
    entry.dataset.category = item.id;
    entry.textContent = `${item.label}: ${plural(item.count, item.unit)}`;
    return entry;
  }));
  const parts = [];
  if (summary.skipped.requests) parts.push(plural(summary.skipped.requests, 'skipped request'));
  if (summary.skipped.groups) parts.push(plural(summary.skipped.groups, 'turned-off group'));
  const skipped = notice.querySelector('.advanced-notice-skipped');
  skipped.hidden = !parts.length;
  skipped.textContent = parts.length ? `Also configured but not run: ${parts.join(' and ')}.` : '';
}

// Called once at startup. Recomputes only while Simple is shown; entering
// Simple (k6ui:ui-mode-changed) refreshes it.
export function initAdvancedNotice() {
  const notice = document.querySelector('#advanced-notice');
  const view = document.querySelector('#view-flow');
  if (!notice || !view) return;
  let pending = false;
  function render() {
    pending = false;
    if (document.documentElement.dataset.uiMode !== 'simple') return;
    const requests = [...document.querySelectorAll('#reqs-main > .req-card')].map(readRequestSettings);
    renderNotice(notice, summarizeAdvancedSettings(requests, readGroupSettings(), usableDataFileCount()));
  }
  function schedule() {
    if (pending) return;
    pending = true;
    queueMicrotask(render);
  }
  // Clicks cover row/sub-request removal and template buttons, which fire no input event.
  for (const type of ['input', 'change', 'click']) view.addEventListener(type, schedule);
  for (const type of ['k6ui:flow-changed', 'k6ui:project-applied', 'k6ui:ui-mode-changed', 'k6ui:request-group-changed', 'k6ui:data-sets-changed']) {
    window.addEventListener(type, schedule);
  }
  schedule();
}
