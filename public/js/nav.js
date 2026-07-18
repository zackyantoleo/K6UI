// View navigation: show one section, mark the active sidebar link.
import { $, $$ } from './dom.js';

const NAV_TITLES = {
  flow:      'Request Flow',
  load:      'Load Profile',
  sla:       'Thresholds / SLA',
  script:    'k6 Script',
  results:   'Run & Monitor',
  vars:      'Global Variables',
  headers:   'Global Headers',
  csv:       'CSV Data',
  cookies:   'Cookies',
  asserts:   'Assertions',
  timers:    'Timers',
  multiscen: 'Multi Scenario',
};

export function navigate(viewId) {
  $$('.view').forEach(v => v.classList.toggle('hidden', v.id !== `view-${viewId}`));
  $$('.nav-link[data-view]').forEach(l => l.classList.toggle('active', l.dataset.view === viewId));
  $('#page-title').textContent = NAV_TITLES[viewId] || viewId;
}
