// Plain-language explanations of the load-testing terms K6UI uses, for people
// who have never run a performance test. One source for the "?" help buttons
// (components/help-tips.js) and the Glossary panel, so both always say the same
// thing (pure, no DOM).

export const GLOSSARY_SECTIONS = Object.freeze([
  Object.freeze({ id: 'traffic', title: 'Traffic' }),
  Object.freeze({ id: 'requests', title: 'Requests and data' }),
  Object.freeze({ id: 'results', title: 'Pass, fail and results' }),
  Object.freeze({ id: 'app', title: 'Using K6UI' }),
]);

const entry = (section, term, text) => Object.freeze({ section, term, text });

// Keys are referenced from markup as data-help="<key>".
export const GLOSSARY = Object.freeze({
  // Traffic
  vu: entry('traffic', 'Virtual user (VU)',
    'A simulated person who runs your requests from top to bottom, then starts again. 10 virtual users is roughly 10 people using the app at the same moment.'),
  iteration: entry('traffic', 'Iteration',
    'One pass through all your requests by one virtual user. Log in, get the profile, create an order: that is one iteration.'),
  duration: entry('traffic', 'Duration',
    'How long the test keeps going. Write it as 30s, 5m, 1h or 1h30m.'),
  stages: entry('traffic', 'Stages (ramp up and down)',
    'Change the number of virtual users step by step instead of all at once, like traffic building up in the morning. Each stage says: over this much time, move to this many users.'),
  iterationsMode: entry('traffic', 'Iterations mode',
    'Every virtual user runs the whole flow a set number of times, then stops. Total runs = virtual users × iterations.'),
  maxDuration: entry('traffic', 'Max duration',
    'A safety limit: k6 stops the test if it is still running after this long, so a stuck run cannot go on forever.'),
  pause: entry('traffic', 'Pause after request (think time)',
    'A wait after the request, like a real person reading the page before the next click. Without it every virtual user sends requests as fast as it can, which is far more load than real people create. The default is 1 second.'),
  smoke: entry('traffic', 'Smoke test',
    'A tiny run, usually 1 virtual user for 30 seconds, to prove the flow works before adding load. Run it first, every time you change the requests.'),
  loadTest: entry('traffic', 'Load test',
    'Normal, expected traffic for a few minutes. It answers: is the service fast enough on a normal day?'),
  stress: entry('traffic', 'Stress test',
    'More traffic than normal, rising until something gives. It answers: where is the limit, and what fails first?'),
  race: entry('traffic', 'Race burst',
    'Many virtual users send the same request at the same instant, for example redeeming one voucher twice. It finds double-spend and stock bugs, not speed problems.'),
  raceLead: entry('traffic', 'Lead time',
    'Time every virtual user gets to finish the requests before the race request (logging in, for example) before the shared moment. Too short, and some users arrive late.'),

  // Requests and data
  variable: entry('requests', 'Variable',
    'A name in double curly braces, like {{base_url}}, replaced with its value when the request is sent. It comes from Global Variables, a data file column, or an earlier response.'),
  globalHeaders: entry('requests', 'Global headers',
    'Headers sent with every request, such as Accept or an Authorization token. A request\'s own header with the same name wins.'),
  dataFile: entry('requests', 'Data file (CSV)',
    'A table of test data, such as 200 test accounts. Each iteration reads one row, so virtual users do not all log in as the same person.'),
  dataFileShare: entry('requests', 'Which row an iteration reads',
    '"Next row" gives every iteration a different row, shared by all virtual users. "One row per user" gives user 1 row 1, user 2 row 2, and so on.'),
  extraction: entry('requests', 'Extraction',
    'Keep part of a response, such as a login token, under a name. Later requests use it as {{token}} in the URL, a header or the body.'),
  check: entry('requests', 'Check',
    'A test on one response, such as "status is 200" or "body contains orderId". Failed checks are counted in the results; the virtual user carries on with the next request.'),
  expectedStatuses: entry('requests', 'Expected statuses',
    'By default only statuses 200–399 count as success. List other codes when they are the right answer, such as 400 "quota reached" in a race test.'),
  outcomes: entry('requests', 'Outcome rules',
    'Give each response a label, such as success or quota_reached, by its status or body. Run & Results counts each label, and an outcome target can limit one.'),
  scripts: entry('requests', 'Pre/post scripts',
    'JavaScript that runs before or after the request, for example to sign a body. Only for cases the other settings cannot cover.'),
  saveCsv: entry('requests', 'Save to CSV',
    'After each response, add a row to a CSV file, such as every order number created. Download it after the run, or use it as the data file of a later run.'),
  group: entry('requests', 'Request group',
    'Requests that belong together. Turn them on or off together, give them shared headers, or run them only when a condition holds.'),
  runIf: entry('requests', 'Run only if',
    'The group runs only when a variable has one of the given values when the group starts. Otherwise its requests are skipped and the rest of the flow carries on.'),

  // Pass, fail and results
  threshold: entry('results', 'Threshold (pass/fail target)',
    'A rule the whole test must meet. If any threshold is missed the test is marked Failed and k6 exits with code 99, so a CI pipeline can stop a release.'),
  p95: entry('results', 'p95 response time',
    'Sort every response time from fastest to slowest; p95 is the one 95% of the way along. A p95 of 300 ms means 95 of every 100 requests finished faster than 300 ms. It shows what slower users feel, which an average hides.'),
  errorRate: entry('results', 'Error rate',
    'The share of requests that failed: no response, a timeout, or a status outside the success list (normally anything outside 200–399).'),
  throughput: entry('results', 'Requests per second',
    'How many requests the service handled each second, on average over the test.'),
  outcomeTarget: entry('results', 'Outcome target',
    'A threshold on how many responses got one outcome label, for example "success at most 100" so a race test cannot redeem more than the quota.'),
  recordRequests: entry('results', 'Record request details',
    'Keeps a copy of each request and response so you can see what went wrong. It slows k6 under heavy load, so record failed requests only when you run many virtual users.'),

  // Using K6UI
  uiMode: entry('app', 'Simple and Advanced',
    'Two layouts of the same project. Simple guides you step by step; Advanced shows every setting at once. Switching never changes what runs or what is saved.'),
});

export function glossaryEntry(key) {
  return Object.hasOwn(GLOSSARY, key) ? GLOSSARY[key] : null;
}

// The entries of one section, in the order above.
export function glossarySection(sectionId) {
  return Object.entries(GLOSSARY)
    .filter(([, item]) => item.section === sectionId)
    .map(([key, item]) => ({ key, ...item }));
}

// Entries whose term or text holds every word of the query (case-insensitive).
export function searchGlossary(query) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return Object.entries(GLOSSARY)
    .filter(([, item]) => {
      const text = `${item.term} ${item.text}`.toLowerCase();
      return words.every(word => text.includes(word));
    })
    .map(([key, item]) => ({ key, ...item }));
}
