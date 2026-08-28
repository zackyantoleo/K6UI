export function createAdvancedPanel() {
  const panel = document.createElement('div');
  const options = document.createElement('div');
  options.className = 'options-row';

  const statusLabel = document.createElement('label');
  statusLabel.className = 'opt-label';
  const checkStatus = document.createElement('input');
  checkStatus.type = 'checkbox';
  checkStatus.className = 'check-status';
  checkStatus.checked = true;
  statusLabel.append(checkStatus, ' Check success status (2xx)');

  const sleepLabel = document.createElement('label');
  sleepLabel.className = 'opt-label';
  sleepLabel.append('Pause after request (seconds): ');
  const sleep = document.createElement('input');
  sleep.type = 'number';
  sleep.className = 'sleep';
  sleep.min = '0';
  sleep.step = '0.5';
  sleep.value = '1';
  sleepLabel.appendChild(sleep);

  options.append(statusLabel, sleepLabel);
  panel.appendChild(options);
  return panel;
}
