// View navigation: show one section, mark the active sidebar link.
// Some pages hold several blocks (`.view-block[data-block]`): Test data
// (variables, shared headers, CSV data files) and Load & goals (load, pass/fail
// goals). Simple shows the whole page as one step; Advanced shows one block per
// category. One DOM either way: blocks are only hidden, never moved or rebuilt.
import { $, $$ } from './dom.js';
import { expandViewBlock } from './components/view-blocks.js';

// Simple step titles (the page title of a step).
const STEP_TITLES = {
  flow:    'Build Flow',
  data:    'Test data',
  load:    'Load & goals',
  script:  'k6 Script',
  results: 'Run & Results',
};

// Advanced category titles.
const CATEGORY_TITLES = {
  flow:      'Request Flow',
  vars:      'Variables',
  headers:   'Headers',
  datafiles: 'Data files',
  load:      'Load Profile',
  sla:       'Thresholds / SLA',
  script:    'k6 Script',
  results:   'Run & Results',
};

// A category that is one block of a page → that page.
const PAGE_OF = { vars: 'data', headers: 'data', datafiles: 'data', sla: 'load' };
// The Simple step that holds a view.
const STEP_OF = { ...PAGE_OF, script: 'results' };
// Advanced has no "whole page" category: a page opens on its first block.
const FIRST_CATEGORY = { data: 'vars' };

let currentView = 'flow';
export const getCurrentView = () => currentView;

export function navigate(viewId, { focusHeading = true } = {}) {
  const mode = document.documentElement.dataset.uiMode || 'simple';
  if (mode === 'advanced' && FIRST_CATEGORY[viewId]) viewId = FIRST_CATEGORY[viewId];
  currentView = viewId;
  const page = PAGE_OF[viewId] || viewId;
  const pageView = $(`#view-${page}`);
  $$('.view').forEach(v => v.classList.toggle('hidden', v !== pageView));
  // Advanced: only the block of this category. Simple: every block of the page.
  const blocks = pageView ? $$(':scope > .view-block[data-block]', pageView) : [];
  for (const block of blocks) {
    block.classList.toggle('hidden', mode === 'advanced' && block.dataset.block !== viewId);
  }

  const activeView = mode === 'simple' ? STEP_OF[viewId] || viewId : viewId;
  $$('.nav-link[data-view]').forEach(link => {
    const active = link.closest('[data-ui-nav]')?.dataset.uiNav === mode && link.dataset.view === activeView;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', mode === 'simple' ? 'step' : 'page');
    else link.removeAttribute('aria-current');
  });
  const heading = $('#page-title');
  heading.textContent = (mode === 'advanced' ? CATEGORY_TITLES[viewId] : STEP_TITLES[page]) || viewId;
  if (focusHeading) heading.focus({ preventScroll: true });

  // Simple, opened at one block (a link such as "Edit: Data files"): open it and bring it into view.
  const target = mode === 'simple' && PAGE_OF[viewId] ? blocks.find(block => block.dataset.block === viewId) : null;
  if (target) {
    expandViewBlock(target);
    if (focusHeading) target.scrollIntoView({ block: 'start' });
  }
  window.dispatchEvent(new CustomEvent('k6ui:view-shown', { detail: { view: viewId, page } }));
}
