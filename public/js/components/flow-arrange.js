// Arranging the request list in Simple: drag a request by its handle to a new
// place, and group bands that show which requests belong to a group.
//
// Cards never leave #reqs-main (docs/ui-modes.md): a drop moves the card within
// it, and a band is a header inside the first card of each run of one group.
// A drop next to a card takes that card's group, so a request joins a group by
// being dropped inside its band and leaves it by being dropped outside. The
// keyboard way is the same card's ⋯ panel: Move up / Move down and Group.
import { renumberMain, notifyFlowChanged } from './counts.js';
import { refreshRequestSummary, announceFlow, requestLabel } from './req-card.js';

const cards = () => [...document.querySelectorAll('#reqs-main > .req-card')];
const groupOf = card => card?.querySelector('.request-group-select')?.value || '';

// ── Group bands ────────────────────────────────────────────────
// Read from the group editors' always-visible heads (name, on/off, the "Run only
// if" badge), never from a hidden panel's inputs.
function groupSummaries() {
  return new Map([...document.querySelectorAll('#request-groups .request-group')].map(group => {
    const badge = group.querySelector('.request-group-runif');
    return [group.dataset.groupId, {
      element: group,
      name: group.querySelector('.request-group-name').value.trim() || 'Untitled group',
      enabled: group.querySelector('.request-group-enabled')?.checked !== false,
      condition: badge && !badge.hidden ? badge.textContent : '',
    }];
  }));
}

function bandElement(card) {
  let band = card.querySelector(':scope > .req-group-band');
  if (band) return band;
  band = document.createElement('div');
  band.className = 'req-group-band';
  band.dataset.uiOnly = 'simple';
  const name = document.createElement('strong');
  name.className = 'req-group-band-name';
  const condition = document.createElement('span');
  condition.className = 'req-group-band-condition';
  const off = document.createElement('span');
  off.className = 'req-group-band-off';
  off.textContent = 'Group is off';
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'req-group-band-edit';
  edit.textContent = 'Edit group';
  edit.addEventListener('click', () => {
    const group = [...document.querySelectorAll('#request-groups .request-group')]
      .find(item => item.dataset.groupId === card.dataset.bandGroup);
    if (!group) return;
    group.scrollIntoView({ block: 'center', behavior: 'smooth' });
    group.querySelector('.request-group-name')?.focus({ preventScroll: true });
  });
  band.append(name, condition, off, edit);
  card.prepend(band);
  return band;
}

export function refreshGroupBands() {
  const groups = groupSummaries();
  const list = cards();
  list.forEach((card, index) => {
    const id = groupOf(card);
    const group = groups.get(id);
    const startsRun = Boolean(group) && groupOf(list[index - 1]) !== id;
    const endsRun = Boolean(group) && groupOf(list[index + 1]) !== id;
    if (!group) {
      delete card.dataset.groupRun;
      delete card.dataset.bandGroup;
    } else {
      card.dataset.bandGroup = id;
      card.dataset.groupRun = startsRun && endsRun ? 'single' : startsRun ? 'start' : endsRun ? 'end' : 'middle';
    }
    if (!startsRun) {
      card.querySelector(':scope > .req-group-band')?.remove();
      return;
    }
    const band = bandElement(card);
    band.querySelector('.req-group-band-name').textContent = group.name;
    band.querySelector('.req-group-band-condition').textContent = group.condition;
    band.querySelector('.req-group-band-condition').hidden = !group.condition;
    band.querySelector('.req-group-band-off').hidden = group.enabled;
    band.querySelector('.req-group-band-edit').setAttribute('aria-label', `Edit group ${group.name}`);
  });
}

let bandsQueued = false;
function queueBands() {
  if (bandsQueued) return;
  bandsQueued = true;
  requestAnimationFrame(() => {
    bandsQueued = false;
    refreshGroupBands();
  });
}

// ── Drag and drop ──────────────────────────────────────────────
let dragged = null;

function clearMarks() {
  document.querySelectorAll('#reqs-main .drop-before, #reqs-main .drop-after')
    .forEach(card => card.classList.remove('drop-before', 'drop-after'));
}

// The card under the pointer and which half of it; between cards, the nearest one.
function dropTarget(container, clientY) {
  const shown = cards().filter(card => card !== dragged && card.getClientRects().length);
  let best = null;
  for (const card of shown) {
    const box = card.getBoundingClientRect();
    const distance = clientY < box.top ? box.top - clientY : clientY > box.bottom ? clientY - box.bottom : 0;
    if (!best || distance < best.distance) best = { card, distance, before: clientY < box.top + box.height / 2 };
  }
  return best;
}

export function moveRequestCard(card, target, before) {
  const container = card.parentElement;
  container.insertBefore(card, before ? target : target.nextElementSibling);
  const select = card.querySelector('.request-group-select');
  const group = groupOf(target);
  const changedGroup = select && select.value !== group;
  if (changedGroup) {
    select.value = group;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  renumberMain();
  container.querySelectorAll('.req-card').forEach(refreshRequestSummary);
  notifyFlowChanged();
  const groupName = group ? groupSummaries().get(group)?.name : '';
  const where = `${requestLabel(card)} is now request ${[...container.children].indexOf(card) + 1}`;
  announceFlow(changedGroup ? `${where}, ${groupName ? `in group ${groupName}` : 'outside any group'}.` : `${where}.`);
}

export function initFlowArrange() {
  const container = document.querySelector('#reqs-main');
  container.addEventListener('dragstart', event => {
    const handle = event.target instanceof Element ? event.target.closest('.req-drag-handle') : null;
    if (!handle) return;
    dragged = handle.closest('.req-card');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', dragged.dataset.requestId);
    event.dataTransfer.setDragImage(dragged, 24, 24);
    requestAnimationFrame(() => dragged?.classList.add('dragging'));
  });
  container.addEventListener('dragover', event => {
    if (!dragged) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const target = dropTarget(container, event.clientY);
    clearMarks();
    target?.card.classList.add(target.before ? 'drop-before' : 'drop-after');
  });
  container.addEventListener('dragleave', event => {
    if (dragged && !container.contains(event.relatedTarget)) clearMarks();
  });
  container.addEventListener('drop', event => {
    if (!dragged) return;
    event.preventDefault();
    const target = dropTarget(container, event.clientY);
    clearMarks();
    if (target) moveRequestCard(dragged, target.card, target.before);
  });
  container.addEventListener('dragend', () => {
    dragged?.classList.remove('dragging');
    dragged = null;
    clearMarks();
  });

  for (const type of ['k6ui:flow-changed', 'k6ui:request-group-changed', 'k6ui:project-applied']) {
    window.addEventListener(type, queueBands);
  }
  const groupsContainer = document.querySelector('#request-groups');
  for (const type of ['input', 'change']) groupsContainer?.addEventListener(type, queueBands);
  queueBands();
}
