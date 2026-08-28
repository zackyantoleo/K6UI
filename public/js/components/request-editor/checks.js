const ASSERT_TYPES = [
  { value: 'status-2xx', label: 'Successful response (status 2xx)', hasVal: false },
  { value: 'status-eq', label: 'Expected status code', hasVal: true, numVal: true, ph: '200' },
  { value: 'status-ne', label: 'Status code !=', hasVal: true, numVal: true, ph: '404' },
  { value: 'status-lt', label: 'Status code <', hasVal: true, numVal: true, ph: '500' },
  { value: 'body-contains', label: 'Response contains text', hasVal: true, ph: 'expected text' },
  { value: 'body-not-contains', label: 'Body does not contain', hasVal: true, ph: 'unwanted text' },
  { value: 'body-matches', label: 'Body matches regex', hasVal: true, ph: '"key":"(\\w+)"' },
  { value: 'header-exists', label: 'Header exists', hasVal: true, ph: 'Authorization' },
  { value: 'header-eq', label: 'Header == value', hasVal: true, hasVal2: true, ph: 'Header-Name', ph2: 'Expected value' },
  { value: 'duration-lt', label: 'Response time under (ms)', hasVal: true, numVal: true, ph: '500' },
];

const CHECK_TEMPLATES = [
  { label: 'Successful response', description: 'Status is between 200 and 299', type: 'status-2xx', value: '' },
  { label: 'Expected status', description: 'Status matches a specific code', type: 'status-eq', value: '200' },
  { label: 'Response contains', description: 'Body includes expected text', type: 'body-contains', value: 'expected text' },
  { label: 'Response time', description: 'Request finishes under a limit', type: 'duration-lt', value: '500' },
];

export function assertionRow(type = 'status-2xx', value = '', value2 = '', onRemove = () => {}) {
  const row = document.createElement('div');
  row.className = 'assertion-row';
  const sel = document.createElement('select');
  sel.className = 'assert-type';
  sel.setAttribute('aria-label', 'Check type');
  for (const def of ASSERT_TYPES) {
    const option = document.createElement('option');
    option.value = def.value;
    option.textContent = def.label;
    sel.appendChild(option);
  }
  const val = document.createElement('input');
  val.className = 'assert-val';
  val.setAttribute('aria-label', 'Expected value');
  const val2 = document.createElement('input');
  val2.className = 'assert-val2';
  val2.setAttribute('aria-label', 'Secondary expected value');
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'row-remove';
  remove.title = 'Remove';
  remove.setAttribute('aria-label', 'Remove assertion');
  remove.textContent = '×';

  function sync() {
    const def = ASSERT_TYPES.find(item => item.value === sel.value) || ASSERT_TYPES[0];
    val.classList.toggle('hidden', !def.hasVal);
    val2.classList.toggle('hidden', !def.hasVal2);
    val.type = def.numVal ? 'number' : 'text';
    val.placeholder = def.ph || '';
    val2.placeholder = def.ph2 || '';
  }
  sel.value = type;
  val.value = value ?? '';
  val2.value = value2 ?? '';
  sel.addEventListener('change', sync);
  remove.addEventListener('click', () => {
    row.remove();
    onRemove();
  });
  sync();
  row.append(sel, val, val2, remove);
  return row;
}

export function createChecksPanel(onCountChange = () => {}) {
  const panel = document.createElement('div');
  const hint = document.createElement('p');
  hint.className = 'ext-hint';
  hint.textContent = 'Validate the response — if an assertion fails, k6 records a failed check that you can enforce with thresholds.';
  const list = document.createElement('div');
  list.className = 'assertions-list';
  const templates = document.createElement('div');
  templates.className = 'check-template-list';
  templates.setAttribute('aria-label', 'Check templates');
  for (const template of CHECK_TEMPLATES) {
    const templateButton = document.createElement('button');
    templateButton.type = 'button';
    templateButton.className = 'check-template-btn';
    const label = document.createElement('strong');
    label.textContent = template.label;
    const description = document.createElement('span');
    description.textContent = template.description;
    templateButton.append(label, description);
    templateButton.addEventListener('click', () => {
      list.appendChild(assertionRow(template.type, template.value, '', onCountChange));
      onCountChange();
    });
    templates.appendChild(templateButton);
  }
  const addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.className = 'add-row-btn';
  addButton.textContent = '+ Add custom check';
  addButton.addEventListener('click', () => {
    list.appendChild(assertionRow('status-2xx', '', '', onCountChange));
    onCountChange();
  });
  list.addEventListener('change', onCountChange);
  panel.append(hint, templates, list, addButton);
  return panel;
}
