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
};

const STEP_BY_VIEW = {
  flow: 'flow',
  data: 'data',
  vars: 'data',
  headers: 'data',
  sla: 'data',
  load: 'load',
  script: 'results',
  results: 'results',
};

export function navigate(viewId, { focusHeading = true } = {}) {
  $$('.view').forEach(v => v.classList.toggle('hidden', v.id !== `view-${viewId}`));
  const activeStep = STEP_BY_VIEW[viewId] || viewId;
  $$('.nav-link[data-view]').forEach(link => {
    const active = link.dataset.view === activeStep;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'step');
    else link.removeAttribute('aria-current');
  });
  const heading = $('#page-title');
  heading.textContent = NAV_TITLES[viewId] || viewId;
  if (focusHeading) heading.focus({ preventScroll: true });
}
