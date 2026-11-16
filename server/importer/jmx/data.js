// JMeter CSV Data Set Config → K6UI data file (config.dataSets).
// A .jmx file only names the CSV file; it does not contain its rows, so the
// data set is imported without content and the user uploads the file in the
// Data files panel (Data & Rules).
//
//   variableNames       → columns (kept in file order; JMeter variable names are renamed like everywhere else)
//   ignoreFirstLine     → skipHeader
//   delimiter           → delimiter ("\t" = tab)
//   shareMode.all       → share "next-row"; any other share mode → "per-vu"
//   recycle / stopThread → onEnd "recycle" / "stop"
import { normalizeDelimiter } from "../../../public/js/csv-parse.js";
import { bool, jmxText, k6Name, prop, resolveVariables, str, titleOf } from "./props.js";

// "${LOGIN_CSV_FILE}" → the file name held by a User Defined Variable.
function fileNameOf(el, ctx) {
  const raw = str(el, "filename").trim();
  if (!raw) return "";
  const known = new Set(ctx.variables.keys());
  const text = resolveVariables(jmxText(raw, ctx, el, `the file name of "${titleOf(el)}"`), ctx);
  // ${__P(file,default)} would otherwise leave a global variable behind.
  for (const key of ctx.variables.keys()) if (!known.has(key)) ctx.variables.delete(key);
  const unresolved = /\{\{(\w+)\}\}/.exec(text);
  if (unresolved) {
    ctx.warn(el, `The file name of CSV Data Set "${titleOf(el)}" uses \${${unresolved[1]}}, which has no value when the test starts; type the file name under Data & Rules instead.`);
    return raw;
  }
  return text.split(/[\\/]/).pop().trim();
}

function delimiterOf(el, ctx) {
  const raw = prop(el, "delimiter") ? str(el, "delimiter") : ",";
  try {
    return normalizeDelimiter(raw);
  } catch {
    ctx.warn(el, `The delimiter "${raw}" of CSV Data Set "${titleOf(el)}" is longer than one character; K6UI uses its first character.`);
    return raw[0] === '"' ? "," : raw[0];
  }
}

// → the data set; also remembered in ctx.dataSets (with its element, for warnings after the walk).
export function convertCsvDataSet(el, scope, ctx) {
  const title = titleOf(el);
  const fileName = fileNameOf(el, ctx);

  const names = str(el, "variableNames").split(",").map((name) => name.trim());
  while (names.length && !names.at(-1)) names.pop();
  const columns = names.map((name) => (name ? k6Name(name, ctx, el) : ""));

  let skipHeader = bool(el, "ignoreFirstLine");
  if (!columns.length) {
    // JMeter then takes the variable names from the file's first line.
    skipHeader = true;
    ctx.warn(el, `CSV Data Set "${title}" has no variable names, so JMeter reads them from the first line of the file; upload ${fileName ? `"${fileName}"` : "the file"} to fill in the columns.`);
  }

  const shareMode = str(el, "shareMode").trim() || "shareMode.all";
  const share = shareMode === "shareMode.all" ? "next-row" : "per-vu";
  if (share === "per-vu") {
    ctx.warn(el, `CSV Data Set "${title}" uses the share mode "${shareMode}"; K6UI imported it as one row per VU (VU n always reads row n).`);
  }

  const recycle = bool(el, "recycle", true);
  if (!recycle && !bool(el, "stopThread")) {
    ctx.warn(el, `CSV Data Set "${title}" keeps running with "<EOF>" values when the file ends; K6UI ends the iteration instead.`);
  }

  if (scope.level !== "plan" && scope.level !== "thread") {
    ctx.warn(el, `CSV Data Set "${title}" sits inside a controller; K6UI reads its row at the start of every iteration, whether or not that part of the flow runs.`);
  }

  const set = {
    id: `ds_jmx_${ctx.dataSets.length + 1}`,
    name: title.slice(0, 120),
    fileName,
    delimiter: delimiterOf(el, ctx),
    skipHeader,
    columns,
    content: "",
    share,
    onEnd: recycle ? "recycle" : "stop",
  };
  ctx.dataSets.push({ set, el });
  ctx.warn(el, `CSV Data Set "${title}" was imported without data: a .jmx file does not contain the CSV rows. Upload ${fileName ? `"${fileName}"` : "the file"} under Data & Rules (Data files).`);
  return set;
}

// A column that shares its name with a variable extracted from a response:
// {{name}} reads the file until that request has run, then the extracted value.
export function warnDataConflicts(ctx) {
  for (const { set, el } of ctx.dataSets) {
    for (const column of set.columns.filter(Boolean)) {
      const owner = ctx.requests.find((req) => req.extractions.some((e) => e.varName === column));
      if (!owner) continue;
      ctx.warn(el, `Column "${column}" of "${set.fileName || set.name}" has the same name as a variable extracted by "${owner.name}": {{${column}}} reads the file's value until that request has run, and the extracted value after it. Rename the column or the extraction if they should differ.`);
    }
  }
}
