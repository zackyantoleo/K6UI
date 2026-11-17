// Sorting of the Run & Results "Requests" table (pure, no DOM; the table lives
// in runner.js). A record is { entry, seq }: entry is one req-log event, seq the
// order it arrived in. No sort (null) means arrival order; equal values keep
// arrival order too, so a sort is stable while new records stream in.

// Column key → how its value is read and compared.
export const SORT_COLUMNS = {
  vu:  { label: 'VU',       type: 'number', read: entry => entry.vu },
  it:  { label: 'Iter',     type: 'number', read: entry => entry.it },
  i:   { label: '#',        type: 'number', read: entry => entry.i },
  m:   { label: 'Method',   type: 'text',   read: entry => entry.m },
  url: { label: 'URL',      type: 'text',   read: entry => entry.url },
  s:   { label: 'Status',   type: 'number', read: entry => entry.s },
  d:   { label: 'Duration', type: 'number', read: entry => entry.d },
};

// A missing or non-numeric number sorts as the smallest value.
function numberOf(value) {
  const number = Number(value);
  return value == null || value === '' || Number.isNaN(number) ? -Infinity : number;
}

function textOf(value) {
  return String(value ?? '').toLowerCase();
}

// sort = { key, dir: 'asc' | 'desc' } or null.
export function compareRecords(a, b, sort) {
  const column = sort && SORT_COLUMNS[sort.key];
  if (column) {
    const left = column.read(a.entry);
    const right = column.read(b.entry);
    let order = 0;
    if (column.type === 'number') {
      const x = numberOf(left);
      const y = numberOf(right);
      order = x === y ? 0 : x < y ? -1 : 1;
    } else {
      const x = textOf(left);
      const y = textOf(right);
      order = x === y ? 0 : x < y ? -1 : 1;
    }
    if (order) return sort.dir === 'desc' ? -order : order;
  }
  return a.seq - b.seq;
}

// Clicking a column heading: ascending → descending → arrival order.
export function nextSort(current, key) {
  if (!SORT_COLUMNS[key]) return current ?? null;
  if (!current || current.key !== key) return { key, dir: 'asc' };
  if (current.dir === 'asc') return { key, dir: 'desc' };
  return null;
}

// Where a new record goes in a list already sorted by `sort` (after its equals).
export function insertIndex(sorted, record, sort) {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (compareRecords(sorted[middle], record, sort) <= 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

// aria-sort value of a column heading.
export function ariaSortOf(sort, key) {
  if (!sort || sort.key !== key) return null;
  return sort.dir === 'desc' ? 'descending' : 'ascending';
}
