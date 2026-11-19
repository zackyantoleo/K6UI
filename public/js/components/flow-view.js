// Builds the "Request Flow" view (main scenario zone) and the stage rows
// for the staged load profile.
import { $ } from '../dom.js';
import { reqCard, setRequestExpanded } from './req-card.js';
import { notifyFlowChanged, refreshFlowEmptyState } from './counts.js';
import { createRequestId } from '../project-store.js';
import { createFlowOutline } from './flow-outline.js';
import {
  applyRequestGroupVisibility,
  createRequestGroup,
  refreshRequestGroupOptions,
} from './request-groups.js';
import { helpButton } from './help-tips.js';
import { initFlowArrange } from './flow-arrange.js';

export function addRequest({ openCurl = false } = {}) {
  const container = $('#reqs-main');
  const card = reqCard(container.children.length, 'main', createRequestId());
  container.appendChild(card);
  refreshFlowEmptyState();
  refreshRequestGroupOptions();
  setRequestExpanded(card, true);
  notifyFlowChanged({ kind: 'request', id: card.dataset.requestId });
  if (openCurl) card.querySelector('.req-more-item.curl').click();
  else card.querySelector('.url').focus();
  return card;
}

export function addRequestGroup() {
  const group = createRequestGroup();
  $('#request-groups').appendChild(group);
  refreshRequestGroupOptions();
  notifyFlowChanged({ kind: 'group', id: group.dataset.groupId });
  group.querySelector('.request-group-name').focus();
  return group;
}

// The stages a fresh page starts with, and what opening a project that does not use
// stages puts back (so the editor never keeps the stages of the project before).
export const DEFAULT_STAGES = Object.freeze([
  Object.freeze({ duration: '30s', target: '10' }),
  Object.freeze({ duration: '1m', target: '20' }),
  Object.freeze({ duration: '30s', target: '0' }),
]);

export function defaultStageRows() {
  return DEFAULT_STAGES.map(stage => stageRow(stage.duration, stage.target));
}

export function stageRow(dur = '30s', tgt = '20') {
  const row = document.createElement('div');
  row.className = 'stage-row';
  const forLabel = document.createElement('span');
  forLabel.className = 'lbl';
  forLabel.textContent = 'For';
  const duration = document.createElement('input');
  duration.className = 'stage-dur';
  duration.placeholder = 'e.g. 30s';
  duration.value = dur;
  const targetLabel = document.createElement('span');
  targetLabel.className = 'lbl';
  targetLabel.textContent = 'ramp to';
  const target = document.createElement('input');
  target.className = 'stage-target';
  target.type = 'number';
  target.min = '0';
  target.placeholder = 'VUs';
  target.value = tgt;
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn-remove-sm';
  remove.setAttribute('aria-label', 'Remove stage');
  remove.textContent = '×';
  remove.addEventListener('click', () => row.remove());
  row.append(forLabel, duration, targetLabel, target, remove);
  return row;
}

export function buildFlowView() {
  const view = $('#view-flow');
  // The outline is a sibling of the zone: request cards stay in #reqs-main
  // and groups in #request-groups, in both UI modes.
  const layout = document.createElement('div');
  layout.className = 'flow-layout';
  const zone = buildZone('main', 'Main Scenario', 'Repeated per VU', 'badge-loop',
    'Every virtual user runs these requests in order, again and again, for as long as the test lasts.');
  layout.append(createFlowOutline({ view, onAddRequest: () => addRequest(), onAddGroup: addRequestGroup }), zone);
  view.appendChild(layout);
  initFlowArrange();
}

function buildZone(ctx, title, badgeText, badgeClass, descHTML) {
  const zone = document.createElement('div');
  zone.className = `flow-zone zone-${ctx}`;
  zone.id = `zone-${ctx}`;

  const zHead = document.createElement('div');
  zHead.className = 'zone-header';
  const titleGroup = document.createElement('div');
  titleGroup.className = 'zone-title-group';
  const titleElement = document.createElement('span');
  titleElement.className = 'zone-title';
  titleElement.textContent = title;
  const badge = document.createElement('span');
  badge.className = `zone-badge ${badgeClass}`;
  badge.textContent = badgeText;
  titleGroup.append(titleElement, badge, helpButton('vu'));
  const keepOpenLabel = document.createElement('label');
  keepOpenLabel.className = 'keep-open-label';
  const keepOpen = document.createElement('input');
  keepOpen.type = 'checkbox';
  keepOpen.className = 'keep-request-editors-open';
  keepOpenLabel.append(keepOpen, ' Keep editors open');
  keepOpen.addEventListener('change', () => {
    if (keepOpen.checked) return;
    const expanded = [...zone.querySelectorAll('.req-card.expanded')];
    expanded.slice(0, -1).forEach(card => setRequestExpanded(card, false, { exclusive: false }));
  });
  zHead.append(titleGroup, keepOpenLabel);

  const zDesc = document.createElement('div');
  zDesc.className = 'zone-desc';
  zDesc.textContent = descHTML.replace(/<[^>]+>/g, '');

  const groupsPanel = document.createElement('section');
  groupsPanel.className = 'request-groups-panel';
  groupsPanel.setAttribute('aria-label', 'Request groups');
  const groupsHead = document.createElement('div');
  groupsHead.className = 'request-groups-head';
  const groupsIntro = document.createElement('div');
  const groupsTitle = document.createElement('strong');
  groupsTitle.textContent = 'Request groups';
  const groupsHint = document.createElement('small');
  groupsHint.textContent = 'Optional. Share headers between requests, or run some only on a condition. '
    + 'Put a request in a group with its ⋯ → Group, or drag it into the group\'s band in the list above.';
  groupsIntro.append(groupsTitle, groupsHint);
  const addGroup = document.createElement('button');
  addGroup.type = 'button';
  addGroup.className = 'btn ghost sm add-request-group';
  addGroup.textContent = '+ Add Group';
  const groupsContainer = document.createElement('div');
  groupsContainer.id = 'request-groups';
  addGroup.addEventListener('click', () => addRequestGroup());
  groupsHead.append(groupsIntro, addGroup);
  groupsPanel.append(groupsHead, groupsContainer);

  const zBody = document.createElement('div');
  zBody.className = 'zone-body';
  zBody.id = `zone-body-${ctx}`;

  const reqCont = document.createElement('div');
  reqCont.id = `reqs-${ctx}`;

  const addBtn = document.createElement('button');
  addBtn.className = 'add-req-btn'; addBtn.textContent = '+ Add Request';
  addBtn.type = 'button';
  addBtn.addEventListener('click', () => addRequest());

  const announcer = document.createElement('p');
  announcer.id = 'flow-announcer';
  announcer.className = 'sr-only';
  announcer.setAttribute('role', 'status');
  announcer.setAttribute('aria-live', 'polite');
  zBody.append(reqCont, addBtn, announcer);
  // Requests first: groups are optional and sit below the list they organize.
  zone.append(zHead, zDesc, zBody, groupsPanel);
  window.addEventListener('k6ui:project-applied', applyRequestGroupVisibility);
  return zone;
}
