// Helper bersama untuk kartu request: badge jumlah ekstraksi/assertion di tab
// dan penomoran ulang kartu. Dipisah ke modul sendiri agar req-card.js dan
// rows.js tidak perlu saling meng-import (hindari circular import).
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
