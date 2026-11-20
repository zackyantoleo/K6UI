// "Success statuses" section of a request: expected statuses (see
// public/js/expected-statuses.js) and the automatic status check. One DOM for
// Simple and Advanced; values are DOM properties, never markup.
import { DEFAULT_EXPECTED_STATUSES, statusesFromOutcomeRules } from '../../expected-statuses.js';

// readOutcomes() → the request's outcome rules as they stand (an unopened "Label
// each response" section gives the saved ones), for "Use statuses from outcome rules".
export function createStatusesPanel(readOutcomes = () => undefined) {
  const panel = document.createElement('div');

  const expectedRow = document.createElement('div');
  expectedRow.className = 'options-row expected-statuses-row';
  const expectedLabel = document.createElement('label');
  expectedLabel.className = 'opt-label';
  expectedLabel.append('Expected statuses: ');
  const expected = document.createElement('input');
  expected.className = 'expected-statuses';
  expected.placeholder = `${DEFAULT_EXPECTED_STATUSES}, e.g. 200,400`;
  expected.autocomplete = 'off';
  expected.spellcheck = false;
  expectedLabel.appendChild(expected);
  const fromRules = document.createElement('button');
  fromRules.type = 'button';
  fromRules.className = 'btn ghost sm expected-from-outcomes';
  fromRules.textContent = 'Use statuses from outcome rules';
  expectedRow.append(expectedLabel, fromRules);

  const hint = document.createElement('p');
  hint.className = 'ext-hint expected-statuses-hint';
  hint.textContent = 'Statuses that count as a success: the status check, k6\'s http_req_failed and the '
    + '"errors" filter of the request details follow this list. Codes like 200 or classes like 4xx, '
    + `separated by commas; empty = ${DEFAULT_EXPECTED_STATUSES}.`;
  const status = document.createElement('p');
  status.className = 'ext-hint expected-statuses-status';
  status.setAttribute('role', 'status');

  const statusLabel = document.createElement('label');
  statusLabel.className = 'opt-label';
  const checkStatus = document.createElement('input');
  checkStatus.type = 'checkbox';
  checkStatus.className = 'check-status';
  checkStatus.checked = true;
  statusLabel.append(checkStatus, ' Check success status (a failed check for any other status)');

  fromRules.addEventListener('click', () => {
    const { statuses, skippedServerErrors } = statusesFromOutcomeRules(readOutcomes());
    const serverErrors = skippedServerErrors ? ' 5xx left out: server errors stay failures.' : '';
    if (!statuses) {
      status.textContent = `No outcome rule names a status${skippedServerErrors ? ' other than 5xx' : ''}; nothing changed.`;
      return;
    }
    expected.value = statuses;
    expected.dispatchEvent(new Event('input', { bubbles: true }));
    status.textContent = `Set to ${statuses} from the outcome rules.${serverErrors}`;
  });

  panel.append(expectedRow, hint, status, statusLabel);
  return panel;
}
