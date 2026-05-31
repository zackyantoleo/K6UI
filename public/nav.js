import { $, $$ } from './utils.js';

const NAV_TITLES = {
  flow:      'Alur Request',
  load:      'Profil Beban',
  sla:       'Threshold / SLA',
  script:    'Script k6',
  results:   'Jalankan & Monitor',
  vars:      'Variabel Global',
  headers:   'Headers Global',
  csv:       'Data CSV',
  cookies:   'Cookies',
  asserts:   'Assertions',
  timers:    'Timer',
  multiscen: 'Multi Skenario',
};

export function navigate(viewId) {
  $$('.view').forEach(v => v.classList.toggle('hidden', v.id !== `view-${viewId}`));
  $$('.nav-link[data-view]').forEach(l => l.classList.toggle('active', l.dataset.view === viewId));
  $('#page-title').textContent = NAV_TITLES[viewId] || viewId;
}
