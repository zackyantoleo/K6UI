// The Run & Results modules as one text, for the tests that check how the results
// workspace is built by reading its code: runner.js (the run, verdict, figures,
// errors, report), request-table.js (the Requests tab) and live-log.js (k6 output).
import { readFileSync } from 'node:fs';

const FILES = ['runner.js', 'request-table.js', 'live-log.js'];

export const runnerSource = () => FILES
  .map(file => readFileSync(new URL(`../../public/js/${file}`, import.meta.url), 'utf8'))
  .join('\n');
