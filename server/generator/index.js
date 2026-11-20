// Turns the UI configuration into a ready-to-run k6 script:
//   plan.js        → the requests that run, options, globals, data files, outcome
//                    rules and targets, race plan; every up-front check (400 / 413)
//   index.js       → the preamble: imports, options, constants and helpers
//   flow.js        → the default function, request by request
// Codegen details live in sibling modules:
//   options.js     → k6 options object (load + thresholds)
//   request.js     → code block for one HTTP request (grpc-request.js: one gRPC call)
//   assertions.js  → check() block for per-request assertions
//   extract.js     → variable extraction from responses
//   interpolate.js → {{varName}} interpolation
//   processors.js  → pre/post-processor scripts
//   data.js        → data files (CSV) → SharedArray + the row of each iteration
//   run-if.js      → "run only if" condition of a request group → if (...) { ... }
//   csv-export.js  → "Save to CSV" exports → one logged row after the request
//   outcomes.js    → outcome rules → one label per response, counted in k6ui_outcome
//   expected-statuses.js → expected statuses → responseCallback + the status check
//   race.js        → race burst load mode → setup() T0, the wait before the race request
//   request-log.js → request details: REQUEST_LOG + the helpers that print each record
import { planScript } from "./plan.js";
import { buildDefaultFunction } from "./flow.js";
import { EXTRACT_OR_SOURCE } from "./extract.js";
import { buildDataDeclarations, buildDataImports } from "./data.js";
import { OUTCOME_HELPER_SOURCE, buildOutcomeRulesSource, buildOutcomeThresholdsSource } from "./outcomes.js";
import { buildExpectedStatusesSource } from "./expected-statuses.js";
import { buildRaceSource } from "./race.js";
import { requestLogSource } from "./request-log.js";

// Everything above the default function.
function buildPreamble(plan, { logBodyLimit }) {
  const { options, race, requestLog, globals, dataSets, requests, grpcIndexes, outcomes, imports } = plan;
  let out = "";
  out += `import http from 'k6/http';\n`;
  out += `import { sleep, check } from 'k6';\n\n`;
  if (grpcIndexes.length)          out += `import grpc from 'k6/net/grpc';\n`;
  if (imports.crypto)              out += `import crypto from 'k6/crypto';\n`;
  if (imports.encoding)            out += `import encoding from 'k6/encoding';\n`;
  if (outcomes.length || race)     out += `import { Counter } from 'k6/metrics';\n`;
  out += buildDataImports(dataSets);
  out += `\n`;
  out += `export const options = ${JSON.stringify(options, null, 2)};\n`;
  out += buildOutcomeThresholdsSource(plan.outcomeThresholds);
  if (race) out += buildRaceSource(race);
  if (requestLog.logRequests) out += requestLogSource(requestLog, grpcIndexes.length > 0, options, logBodyLimit);

  if (globals.size > 0) {
    out += `\n// Global variables — used via {{name}} in URLs, headers, and bodies\n`;
    out += `const GLOBALS = {\n`;
    for (const [key, value] of globals) out += `  ${key}: ${JSON.stringify(value)},\n`;
    out += `};\n`;
  }

  out += buildDataDeclarations(dataSets);

  if (grpcIndexes.length) {
    out += `\n// gRPC clients — connect with server reflection (no .proto files needed)\n`;
    for (const i of grpcIndexes) out += `const grpc_client_${i} = new grpc.Client();\n`;
  }

  if (plan.needsExtractOr) out += `\n${EXTRACT_OR_SOURCE}\n`;
  if (outcomes.length) {
    out += `\n${OUTCOME_HELPER_SOURCE}`;
    out += buildOutcomeRulesSource(outcomes, requests);
  }
  out += buildExpectedStatusesSource(requests);
  return out;
}

// `meta` (optional) receives what the run needs to read the results back:
// meta.outcomes = the requests with outcome rules (see outcomes.js outcomeTargets),
// meta.outcomeThresholds = the outcome target plan, meta.race = the race burst plan
// (race.js), only in race mode.
// `logBodyLimit` (optional) raises the request record's body cap (LOG_BODY_LIMIT) for
// Send once (server/send-once.js); without it the script is unchanged.
export function generateScript(config, meta = null, { logBodyLimit } = {}) {
  const plan = planScript(config);
  if (meta) {
    meta.outcomes = plan.outcomes;
    meta.outcomeThresholds = plan.outcomeThresholds;
    if (plan.race) meta.race = plan.race;
  }
  return buildPreamble(plan, { logBodyLimit }) + buildDefaultFunction(plan);
}
