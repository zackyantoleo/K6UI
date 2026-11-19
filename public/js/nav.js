// View navigation: show one section, mark the active sidebar link.
import { $, $$ } from './dom.js';

const NAV_TITLES = {
  flow:      'Build Flow',
  data:      'Data & Rules',
  load:      'Load',
  sla:       'Thresholds / SLA',
  script:    'k6 Script',
  results:   'Run & Results',
  vars:      'Global Variables',
  headers:   'Global Headers',
  datafiles: 'Data files',
};

const STEP_BY_VIEW = {
  flow: 'flow',
  data: 'data',
  vars: 'data',
  headers: 'data',
  datafiles: 'data',
  sla: 'data',
  load: 'load',
  script: 'results',
  results: 'results',
};

let currentView = 'flow';
export const getCurrentView = () => currentView;

export function navigate(viewId, { focusHeading = true } = {}) {
  const mode = document.documentElement.dataset.uiMode || 'simple';
  if (mode === 'advanced' && viewId === 'data') viewId = 'vars';
  currentView = viewId;
  $$('.view').forEach(v => v.classList.toggle('hidden', v.id !== `view-${viewId}`));
  const activeView = mode === 'simple' ? STEP_BY_VIEW[viewId] || viewId : viewId;
  $$('.nav-link[data-view]').forEach(link => {
    const active = link.closest('[data-ui-nav]')?.dataset.uiNav === mode && link.dataset.view === activeView;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', mode === 'simple' ? 'step' : 'page');
    else link.removeAttribute('aria-current');
  });
  const heading = $('#page-title');
  const categoryTitles = { flow: 'Request Flow', vars: 'Variables', headers: 'Headers', load: 'Load Profile' };
  heading.textContent = (mode === 'advanced' && categoryTitles[viewId]) || NAV_TITLES[viewId] || viewId;
  if (focusHeading) heading.focus({ preventScroll: true });
}
