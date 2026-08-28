const ASSERT_TYPES = [
  { value: 'status-2xx', label: 'Status success (2xx)', hasVal: false },
  { value: 'status-eq', label: 'Status code ==', hasVal: true, numVal: true, ph: '200' },
  { value: 'status-ne', label: 'Status code !=', hasVal: true, numVal: true, ph: '404' },
  { value: 'status-lt', label: 'Status code <', hasVal: true, numVal: true, ph: '500' },
  { value: 'body-contains', label: 'Body contains', hasVal: true, ph: 'expected text' },
  { value: 'body-not-contains', label: 'Body does not contain', hasVal: true, ph: 'unwanted text' },
  { value: 'body-matches', label: 'Body matches regex', hasVal: true, ph: '"key":"(\\w+)"' },
  { value: 'header-exists', label: 'Header exists', hasVal: true, ph: 'Authorization' },
  { value: 'header-eq', label: 'Header == value', hasVal: true, hasVal2: true, ph: 'Header-Name', ph2: 'Expected value' },
  { value: 'duration-lt', label: 'Response < X ms', hasVal: true, numVal: true, ph: '500' },
];

export function assertionRow(type = 'status-2xx', value = '', value2 = '', onRemove = () => {}) {
  const row = document.createElement('div');
  row.className = 'assertion-row';
  const sel = document.createElement('select');
  sel.className = 'assert-type';
  for (const def of ASSERT_TYPES) {
    const option = document.createElement('option');
    option.value = def.value;
    option.textContent = def.label;
    sel.appendChild(option);
  }
  const val = document.createElement('input');
  val.className = 'assert-val';
  const val2 = document.createElement('input');
  val2.className = 'assert-val2';
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
  hint.textContent = 'Validate the response — if an assertion fails, k6 marks the request as failed.';
  const list = document.createElement('div');
  list.className = 'assertions-list';
  const addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.className = 'add-row-btn';
  addButton.textContent = '+ Add Assertion';
  addButton.addEventListener('click', () => {
    list.appendChild(assertionRow('status-2xx', '', '', onCountChange));
    onCountChange();
  });
  list.addEventListener('change', onCountChange);
  panel.append(hint, list, addButton);
  return panel;
}
