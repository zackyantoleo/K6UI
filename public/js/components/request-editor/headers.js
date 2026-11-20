import { headerRow } from '../rows.js';

export function createHeadersPanel() {
  const panel = document.createElement('div');
  const hint = document.createElement('p');
  hint.className = 'ext-hint';
  hint.textContent = 'Sent with this request only. Global headers go with every request; a header here with the same name wins.';
  const list = document.createElement('div');
  list.className = 'headers-list';
  const addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.className = 'add-row-btn';
  addButton.setAttribute('aria-label', 'Add header');
  addButton.textContent = '+ Header';
  addButton.addEventListener('click', () => list.appendChild(headerRow()));
  panel.append(hint, list, addButton);
  return panel;
}
