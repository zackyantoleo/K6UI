// Builds the "Request Flow" view (main scenario zone) and the stage rows
// for the staged load profile.
import { $ } from '../dom.js';
import { reqCard, setRequestExpanded } from './req-card.js';
import { refreshFlowEmptyState } from './counts.js';
import { createRequestId } from '../project-store.js';

export function addRequest({ openCurl = false } = {}) {
  const container = $('#reqs-main');
  const card = reqCard(container.children.length, 'main', createRequestId());
  container.appendChild(card);
  refreshFlowEmptyState();
  setRequestExpanded(card, true);
  if (openCurl) card.querySelector('.req-action-btn.curl').click();
  else card.querySelector('.url').focus();
  return card;
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
  view.appendChild(buildZone('main', 'Main Scenario', 'Repeated per VU', 'badge-loop',
    'Run repeatedly by every virtual user. Each request can have optional <em>Before</em> and <em>After</em> sub-requests.'));
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
  titleGroup.append(titleElement, badge);
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

  const zBody = document.createElement('div');
  zBody.className = 'zone-body';
  zBody.id = `zone-body-${ctx}`;

  const reqCont = document.createElement('div');
  reqCont.id = `reqs-${ctx}`;

  const addBtn = document.createElement('button');
  addBtn.className = 'add-req-btn'; addBtn.textContent = '+ Add Request';
  addBtn.type = 'button';
  addBtn.addEventListener('click', () => addRequest());

  zBody.append(reqCont, addBtn);
  zone.append(zHead, zDesc, zBody);
  return zone;
}
