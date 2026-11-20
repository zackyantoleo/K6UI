// The first-run screen of Build Flow (`#flow-empty-state`, shown while the project
// has no request; counts.js refreshFlowEmptyState()): four ways to start. One DOM for Simple and Advanced. The template is an
// ordinary project in the existing schema (templates.js), applied like an opened
// project, so it is saved, generated and run like any other.
import { $ } from '../dom.js';
import { collectConfig } from '../config.js';
import { applyConfig } from '../project-io.js';
import { createRequestId } from '../project-store.js';
import { withLoginTemplate } from '../templates.js';
import { addRequest } from './flow-view.js';
import { announceFlow } from './req-card.js';

export function addLoginTemplate() {
  // Keeps what the page already holds (variables, headers, data files, load, goals).
  applyConfig(withLoginTemplate(collectConfig(), [createRequestId(), createRequestId()]));
  announceFlow('Added two requests: Log in, then Use the token. Change base_url, username and password under Test data.');
  $('#reqs-main .req-card .url')?.focus();
}

export function initFirstRun() {
  $('#empty-add-request').addEventListener('click', () => addRequest());
  $('#empty-import-curl').addEventListener('click', () => addRequest({ openCurl: true }));
  $('#empty-template-login').addEventListener('click', addLoginTemplate);
  // The top bar's Import → "A k6 script or JMeter plan" (script-import.js owns the dialog).
  $('#empty-import-file').addEventListener('click', () => $('#import-k6-btn').click());
}
