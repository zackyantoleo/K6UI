export function createBasicFields(index) {
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'request-name';
  nameInput.placeholder = `Request ${index + 1}`;
  nameInput.setAttribute('aria-label', `Request ${index + 1} name`);
  nameInput.maxLength = 120;
  return { nameInput };
}
