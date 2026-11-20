// Small value helpers used by the shared modules, the rest of the frontend and the
// server (pure, no DOM). One definition each, so the rules cannot drift apart.

// A K6UI name (variable, data file column, extracted value, condition variable): it
// becomes a JavaScript identifier in the generated script.
export const NAME_PATTERN = /^[A-Za-z_]\w*$/;

// A plain object (not null, not an array).
export const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Any value → text: null and undefined are empty, a string stays as it is.
export const text = value => (typeof value === 'string' ? value : value == null ? '' : String(value));

// Any value → one line of text: \r, \n, U+2028 and U+2029 (all line ends in
// JavaScript) become a space. Safe inside a `//` comment of a generated script.
const LINE_BREAKS = new RegExp(`[${String.fromCharCode(10, 13, 0x2028, 0x2029)}]+`, 'g');
export const oneLine = value => text(value).replace(LINE_BREAKS, ' ').trim();
