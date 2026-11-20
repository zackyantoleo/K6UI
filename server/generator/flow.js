// The default function: every request that runs, in order (planScript() in plan.js).
//
// Per request: the race wait (race burst), pre-processor → request (+ check, extractions,
// outcome label, request record, pause) → assertions → post-processor → Save to CSV.
// Consecutive requests of one group form a "run". A run starts by choosing the rows of
// the group's data files and, with a "run only if" condition, opens `if (...) {`
// (closed after the run's last request). The condition is read when the run starts,
// so a group split by other requests is checked per run.
import { buildRequestCode } from "./request.js";
import { buildGrpcRequestCode, validateGrpcRequest } from "./grpc-request.js";
import { buildAssertionsCode } from "./assertions.js";
import { extractionDefault, isExtractable } from "./extract.js";
import { jsLiteral, oneLine, responseVar } from "./helpers.js";
import { buildDataHoists, buildDataRowCode, buildGroupDataRowCode, dataColumns } from "./data.js";
import { buildRunIfCondition, runIfComment } from "./run-if.js";
import { buildExportCode } from "./csv-export.js";
import { buildOutcomeCode } from "./outcomes.js";
import { buildRaceWaitCode, raceRequestCode } from "./race.js";
import { buildProcessorBlock, scanAssignedVars, validateProcessor } from "./processors.js";
import { OUTCOME_VARIABLE } from "../../public/js/shared/outcomes.js";

// What is known at each point of the function, as the requests are written in order.
// `ctx` is what interpolate.js reads to turn {{name}} into code.
function createFlowState(plan) {
  const ctx = {
    localVars: new Set(),     // variables already declared: prevents a double `let`
    processorVars: new Set(), // {{name}}s made available by processor scripts assigning vars.<name>
    dataVars: dataColumns(plan.dataSets),
    globalVars: new Set(plan.globals.keys()),
    hoistedVars: new Set(),   // extracted inside a conditional block, declared with `let` above it
    dynamicVars: new Map(),   // {{$name}}: K6UI's own variables, known from where they get a value
  };
  return { ctx, blockOpen: false };
}

const groupIdOf = (req) => req._groupId || "";

// Names a conditional run extracts or assigns would otherwise live and die inside its
// block. An extracted name starts at its extraction's default (the first extraction of
// that name in the run that has one), else empty, so a skipped group leaves the default.
function hoistRunDeclarations(run, { localVars, hoistedVars }) {
  const extracted = new Map(); // name → default or null
  const assigned = new Set();
  for (const r of run) {
    for (const e of r.extractions || []) {
      if (!isExtractable(e) || localVars.has(e.varName)) continue;
      if (extracted.has(e.varName)) {
        if (extracted.get(e.varName) === null) extracted.set(e.varName, extractionDefault(e));
        continue;
      }
      if (hoistedVars.has(e.varName)) continue;
      hoistedVars.add(e.varName);
      extracted.set(e.varName, extractionDefault(e));
    }
    scanAssignedVars(String(r.preScript || ""), assigned);
    scanAssignedVars(String(r.postScript || ""), assigned);
  }
  let code = "";
  if (extracted.size) {
    const withDefaults = [...extracted.values()].some((value) => value !== null);
    code += `\n  // Extracted inside a conditional group: declared here so later requests can read them (${withDefaults ? "their default, or empty," : "empty"} if the group does not run)\n`;
    for (const [name, fallback] of extracted) code += `  let ${name} = ${fallback === null ? '""' : jsLiteral(fallback)};\n`;
  }
  if (assigned.size) {
    code += `\n  // Set by scripts inside a conditional group: empty until they run\n`;
    for (const name of assigned) code += `  if (vars.${name} === undefined) vars.${name} = "";\n`;
  }
  return code;
}

function beginRun(plan, state, start) {
  const { requests, groups, groupPosition, dataSets } = plan;
  const group = groups.get(requests[start]._groupId);
  let end = start;
  while (end + 1 < requests.length && groupIdOf(requests[end + 1]) === group.id) end++;

  let code = "";
  if (group.runIf != null) {
    const condition = buildRunIfCondition(group, groupPosition.get(group.id), state.ctx, dataSets);
    code += hoistRunDeclarations(requests.slice(start, end + 1), state.ctx);
    code += `\n${runIfComment(group, groupPosition.get(group.id))}`;
    code += `  if (${condition}) {\n`;
    state.blockOpen = true;
  }
  const rows = buildGroupDataRowCode(dataSets, group.id);
  if (rows) code += (state.blockOpen ? "" : "\n") + rows;
  return code;
}

function endRun(state) {
  if (!state.blockOpen) return "";
  state.blockOpen = false;
  return `  }\n`;
}

// One request and everything that belongs to it.
function requestBlock(plan, state, req, i) {
  const { race, requestLog, outcomeByIndex, keepOutcome, exportDefaults } = plan;
  const { ctx } = state;
  const preScript = String(req.preScript || "").trim();
  const postScript = String(req.postScript || "").trim();
  const resVar = responseVar(i);
  let code = "";

  if (req._groupName) code += `\n  // Group: ${oneLine(req._groupName)}\n`;

  // Race burst: warm-up + wait, before the pre-processor
  if (race && race.index === i) {
    const assigned = new Set();
    scanAssignedVars(preScript, assigned);
    code += buildRaceWaitCode(race, req, ctx, assigned);
  }

  if (preScript) {
    validateProcessor(preScript, `Pre-processor of request ${i + 1}`, false);
    scanAssignedVars(preScript, ctx.processorVars);
    code += "\n" + buildProcessorBlock(preScript, `Pre-processor: request ${i + 1}`, null);
  }

  const isGrpc = req.type === "grpc";
  if (isGrpc) {
    validateGrpcRequest(req, `Request ${i + 1}`);
    code += "\n" + buildGrpcRequestCode(req, i, ctx, { logRequests: requestLog.logRequests });
  } else {
    const target = outcomeByIndex.get(i);
    const outcome = target ? buildOutcomeCode(target, resVar, keepOutcome) : null;
    const raceCode = race && race.index === i ? raceRequestCode(race, outcome?.name) : null;
    code += "\n" + buildRequestCode(req, i, ctx, { logRequests: requestLog.logRequests, outcome, race: raceCode });
    // From here on (this request's Save to CSV included), {{$outcome}} has a value.
    if (outcome && keepOutcome) ctx.dynamicVars.set(OUTCOME_VARIABLE, OUTCOME_VARIABLE);
  }
  code += "\n";

  code += buildAssertionsCode(req.assertions, resVar, isGrpc ? "grpc" : "http") || "";

  if (postScript) {
    validateProcessor(postScript, `Post-processor of request ${i + 1}`, true);
    code += "\n" + buildProcessorBlock(postScript, `Post-processor: request ${i + 1}`, resVar);
    scanAssignedVars(postScript, ctx.processorVars);
  }

  for (const e of req.extractions || []) {
    if (e && e.varName) ctx.localVars.add(e.varName);
  }

  // Save to CSV, after everything of this request
  return code + buildExportCode(req.exports, ctx, exportDefaults);
}

export function buildDefaultFunction(plan) {
  const { race, dataSets, requests, keepOutcome, hasProcessors } = plan;
  const state = createFlowState(plan);

  // Race burst: the default function reads T0 from setup()'s data.
  let code = race ? `\nexport default function(data) {\n` : `\nexport default function() {\n`;
  code += buildDataRowCode(dataSets);
  code += buildDataHoists(dataSets);
  if (keepOutcome) {
    code += `  let ${OUTCOME_VARIABLE} = ""; // {{${OUTCOME_VARIABLE}}}: the latest outcome label of this iteration\n`;
  }
  if (hasProcessors) code += `  const vars = {};  // shared by pre/post-processor scripts\n`;

  requests.forEach((req, i) => {
    if (groupIdOf(req) !== (i ? groupIdOf(requests[i - 1]) : "")) {
      code += endRun(state);
      if (req._groupId) code += beginRun(plan, state, i);
    }
    code += requestBlock(plan, state, req, i);
  });

  return code + endRun(state) + `}\n`;
}
