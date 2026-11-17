// The CSS the page loads: public/css/style.css and every file it imports, in
// order. Tests that check styling read this, so a rule may live in any file.
import fs from 'node:fs';

const directory = new URL('../../public/css/', import.meta.url);
const read = name => fs.readFileSync(new URL(name, directory), 'utf8');

export function readStyles() {
  const entry = read('style.css');
  const imported = [...entry.matchAll(/^@import url\("([^"]+)"\);/gm)].map(match => match[1]);
  return [entry, ...imported.map(read)].join('\n');
}
