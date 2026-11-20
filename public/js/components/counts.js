// Shared helpers for request cards: extraction/assertion count badges in the editor section heads
// and card renumbering. Kept in a separate module so req-card.js and rows.js
// don't need to import each other (avoids a circular import).
import { $$ } from '../dom.js';

export function updateExtCount(card) {
  const list  = card.querySelector('.req-card-body .extractions-list');
  const n     = $$('.ext-name', list || card).filter(i => i.value.trim()).length;
  const badge = card.querySelector('.section-count-ext');
  if (!badge) return;
  badge.textContent = n || '';
  badge.classList.toggle('visible', n > 0);
}

export function updateAssertCount(card) {
  const list  = card.querySelector('.assertions-list');
  const n     = list ? $$('.assertion-row', list).length : 0;
  const badge = card.querySelector('.section-count-assert');
  if (!badge) return;
  badge.textContent = n || '';
  badge.classList.toggle('visible', n > 0);
}

export function updateScriptCount(card) {
  const pre  = card.querySelector('.pre-script');
  const post = card.querySelector('.post-script');
  const n = (pre?.value.trim() ? 1 : 0) + (post?.value.trim() ? 1 : 0);
  const badge = card.querySelector('.section-count-script');
  if (!badge) return;
  badge.textContent = n || '';
  badge.classList.toggle('visible', n > 0);
}

// Outcome rules with a label (an empty row does not count).
export function updateOutcomeCount(card) {
  const list  = card.querySelector('.req-card-body .outcome-rules-list');
  const n     = list ? $$('.outcome-label', list).filter(i => i.value.trim()).length : 0;
  const badge = card.querySelector('.section-count-outcome');
  if (!badge) return;
  badge.textContent = n || '';
  badge.classList.toggle('visible', n > 0);
}

export function renumberMain() {
  $$('#reqs-main .req-card').forEach((c, i) => {
    const n = c.querySelector('.req-num');
    if (n) n.textContent = `#${i + 1}`;
  });
}

// Lightweight notification for the Advanced outline after structural edits.
// `select` ({ kind: 'request' | 'group', id }) asks it to select that item.
export function notifyFlowChanged(select) {
  window.dispatchEvent(new CustomEvent('k6ui:flow-changed', { detail: { select } }));
}

// Removing the focused card or group would drop keyboard focus on <body>.
// Advanced keeps the user in the outline, whose selection already moved to a
// neighbour (or, when that neighbour sits in a folded group, on that group's
// head); Simple moves to the first visible neighbour's control, else to the
// matching Add button. Call after notifyFlowChanged().
export function focusAfterRemoval(hadFocus, neighbours, controlSelector, fallbackSelector) {
  if (!hadFocus) return;
  const shown = element => Boolean(element?.getClientRects().length);
  const current = document.querySelector('#flow-outline .outline-item[aria-current="true"]');
  const target = document.documentElement.dataset.uiMode === 'advanced'
    ? (shown(current) ? current : current?.closest('.outline-section')?.querySelector('.outline-group'))
      || document.querySelector('#outline-add-request')
    : neighbours.map(item => item?.querySelector(controlSelector)).find(shown)
      || document.querySelector(fallbackSelector);
  target?.focus();
}

export function refreshFlowEmptyState() {
  const container = document.querySelector('#reqs-main');
  document.querySelector('#flow-empty-state')?.classList.toggle(
    'hidden',
    Boolean(container?.children.length),
  );
}
