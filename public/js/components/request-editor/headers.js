import { headerRow } from '../rows.js';

export function createHeadersPanel() {
  const panel = document.createElement('div');
  const list = document.createElement('div');
  list.className = 'headers-list';
  const addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.className = 'add-row-btn';
  addButton.setAttribute('aria-label', 'Add header');
  addButton.textContent = '+ Header';
  addButton.addEventListener('click', () => list.appendChild(headerRow()));
  panel.append(list, addButton);
  return panel;
}
