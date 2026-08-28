export function createBodyPanel() {
  const panel = document.createElement('div');
  const textarea = document.createElement('textarea');
  textarea.className = 'body';
  textarea.setAttribute('aria-label', 'Request body');
  textarea.placeholder = '{"key":"value"}\n\nFor POST/PUT/PATCH/DELETE. Use {{variable_name}} to insert values.';
  panel.appendChild(textarea);
  return panel;
}
