// Shared helpers for request cards: extraction/assertion count badges on tabs
// and card renumbering. Kept in a separate module so req-card.js and rows.js
// don't need to import each other (avoids a circular import).
import { $$ } from '../dom.js';

export function updateExtCount(card) {
  const list  = card.querySelector('.req-card-body .extractions-list');
  const n     = $$('.ext-name', list || card).filter(i => i.value.trim()).length;
  const badge = card.querySelector('.tab-count-ext');
  if (!badge) return;
  badge.textContent = n || '';
  badge.classList.toggle('visible', n > 0);
}

export function updateAssertCount(card) {
  const list  = card.querySelector('.assertions-list');
  const n     = list ? $$('.assertion-row', list).length : 0;
  const badge = card.querySelector('.tab-count-assert');
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
