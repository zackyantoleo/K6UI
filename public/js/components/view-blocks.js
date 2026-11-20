// Foldable blocks of a page (Test data: Variables, Shared headers, CSV data
// files). Simple only: the toggle sits in the block heading and carries
// `data-ui-only="simple"`; Advanced shows one block per category, always open
// (css/views.css), so a folded block is never stuck closed there. The open state
// lives in this tab's DOM only and is never saved.
import { $$ } from '../dom.js';

function setOpen(toggle, open) {
  toggle.setAttribute('aria-expanded', String(open));
  const body = document.getElementById(toggle.getAttribute('aria-controls'));
  if (body) body.hidden = !open;
}

export function expandViewBlock(block) {
  const toggle = block?.querySelector('.view-block-toggle');
  if (toggle && toggle.getAttribute('aria-expanded') !== 'true') setOpen(toggle, true);
}

// Called once at startup.
export function initViewBlocks() {
  for (const toggle of $$('.view-block-toggle[aria-controls]')) {
    toggle.addEventListener('click', () => setOpen(toggle, toggle.getAttribute('aria-expanded') !== 'true'));
  }
}
