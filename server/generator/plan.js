// The configuration → everything the script writers need: the requests that run (with
// their group and inherited headers), the k6 options, globals, data files, outcome rules
// and targets, the race burst plan, and which helpers the script needs.
//
// Every check that is not tied to one request's code happens here, in this order, so a
// configuration with several problems always reports the same one first. The checks
// that are (a group's condition, a processor script, a gRPC call, the race wait) stay
// with that request's code in flow.js, in request order.
import { buildOptions } from "./options.js";
import { extractionDefault, isExtractable, validateExtractionNames, validateExtractionRegexes } from "./extract.js";
import { validateAssertions } from "./assertions.js";
import { prepareDataSets } from "./data.js";
import { validateExports } from "./csv-export.js";
import { addOutcomeThresholds, outcomeTargets, planThresholds, usesOutcomeVariable, validateOutcomes } from "./outcomes.js";
import { validateExpectedStatuses } from "./expected-statuses.js";
import { planRaceScript } from "./race.js";
import { expandSubRequests } from "../../public/js/shared/sub-requests.js";
import { normalizeRequestLog } from "../../public/js/shared/request-log.js";
import { NAME_PATTERN } from "../../public/js/shared/basics.js";

// Global variables must be valid JS identifiers: they are emitted as object
// keys on GLOBALS and referenced via dot access ({{name}} → GLOBALS.name).
function collectGlobalVars(variables) {
  const map = new Map();
  if (!Array.isArray(variables)) return map;
  for (const v of variables) {
    if (!v || !v.key || !NAME_PATTERN.test(v.key)) continue;
    map.set(v.key, String(v.value == null ? "" : v.value));
  }
  return map;
}

// Headers are merged global → group → request at codegen time. Later levels
// override earlier levels using case-insensitive HTTP header names.
function mergeHeaders(globalHeaders, reqHeaders) {
  const out = [];
  const byName = new Map(); // lowercase name → index in out
  const all = [...globalHeaders, ...(Array.isArray(reqHeaders) ? reqHeaders : [])];
  for (const h of all) {
    if (!h || !h.key) continue;
    const name = String(h.key).toLowerCase();
    if (byName.has(name)) out[byName.get(name)] = h;
    else { byName.set(name, out.length); out.push(h); }
  }
  return out;
}

// The requests that run, in order: on, in a group that is on, with a URL. Each one
// carries its merged headers and, in a group, `_groupId` / `_groupName`. A payload
// with Before/After sub-requests (`pre` / `post`) runs them as ordinary requests.
function runnableRequests(scenario, groups, globalHeaders) {
  const withInheritedHeaders = (req) => {
    const group = req && groups.get(req.groupId);
    const grouped = group
      ? { ...req, headers: mergeHeaders(group.headers || [], req.headers), _groupId: group.id, _groupName: group.name || "Request group" }
      : { ...req };
    return globalHeaders.length ? { ...grouped, headers: mergeHeaders(globalHeaders, grouped.headers) } : grouped;
  };
  return (expandSubRequests(scenario.requests) || [])
    .filter((r) => {
      const group = r && groups.get(r.groupId);
      return r && r.enabled !== false && (!group || group.enabled !== false) && String(r.url || "").trim();
    })
    .map(withInheritedHeaders);
}

const hasText = (value) => String(value || "").trim() !== "";

export function planScript(config) {
  const scenario = config.scenario || {};
  // Race burst: checked first (a 400 naming the field), it decides the scenario.
  const race = planRaceScript(config);
  const options = buildOptions(config, race);
  const requestLog = normalizeRequestLog(config.options);
  const globals = collectGlobalVars(config.variables);

  const globalHeaders = (Array.isArray(config.globalHeaders) ? config.globalHeaders : [])
    .filter((h) => h && h.key && String(h.key).trim());
  const groups = new Map(
    (Array.isArray(scenario.groups) ? scenario.groups : [])
      .filter((group) => group && group.id)
      .map((group) => [group.id, group])
  );
  const groupPosition = new Map([...groups.keys()].map((id, position) => [id, position]));
  const dataSets = prepareDataSets(config.dataSets, groups);
  const requests = runnableRequests(scenario, groups, globalHeaders);

  // Checked up front, so a broken request is a 400 before any code is built. Each
  // outcome label gets an always-passing threshold so k6 reports its count; outcome
  // targets add their expressions to those thresholds (same request numbers).
  const hasProcessors = requests.some((r) => hasText(r.preScript) || hasText(r.postScript));
  validateExtractionNames(requests, { processors: hasProcessors, race: Boolean(race) });
  validateExtractionRegexes(requests);
  validateAssertions(requests);
  validateOutcomes(requests);
  validateExpectedStatuses(requests);
  const outcomes = outcomeTargets(requests);
  const outcomeThresholds = planThresholds(config);
  addOutcomeThresholds(options, outcomes, outcomeThresholds);
  validateExports(requests);

  // Auto-import the k6 utility modules a processor script refers to, so
  // e.g. crypto.sha256(...) works in a pre/post-processor out of the box.
  const processorSource = requests.map((r) => `${r.preScript || ""}\n${r.postScript || ""}`).join("\n");

  return {
    race,
    options,
    requestLog,
    globals,
    groups,
    groupPosition,
    dataSets,
    requests,
    grpcIndexes: requests.map((r, i) => (r.type === "grpc" ? i : -1)).filter((i) => i !== -1),
    outcomes,
    outcomeByIndex: new Map(outcomes.map((target) => [target.index, target])),
    outcomeThresholds,
    imports: {
      crypto: /\bcrypto\./.test(processorSource),
      encoding: /\bencoding\./.test(processorSource),
    },
    // extractOr() is only written when an extraction that will run has a default.
    needsExtractOr: requests.some((r) => (r.extractions || []).some((e) => isExtractable(e) && extractionDefault(e) !== null)),
    // {{$outcome}} reads the label of the latest request with outcome rules that ran in
    // this iteration: kept in one variable, only when a request uses it.
    keepOutcome: outcomes.length > 0 && requests.some(usesOutcomeVariable),
    hasProcessors,
  };
}
