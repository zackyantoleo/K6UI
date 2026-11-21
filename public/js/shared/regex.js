// Regexes as typed in a check "Body matches regex" or a regex extraction, written into
// the generated script as a regex literal (server/generator/helpers.js buildRegex).
// Shared by config.js (checked before Run) and the generator (a 400) (pure, no DOM).

// A regex as typed (a check "Body matches regex", a regex extraction) → its source and
// flags: "/token=(\w+)/i" is source + flags, anything else is the source itself.
const REGEX_LITERAL = /^\/([\s\S]+)\/([gimsuy]*)$/;
export function regexParts(selector) {
  const value = String(selector ?? "");
  const literal = REGEX_LITERAL.exec(value);
  return literal ? { source: literal[1], flags: literal[2] } : { source: value, flags: "" };
}

// A line terminator written as an escape: inside a regex literal it would end the line.
const LINE_TERMINATOR_ESCAPES = {
  "\n": "\\n", "\r": "\\r", [String.fromCharCode(0x2028)]: "\\u2028", [String.fromCharCode(0x2029)]: "\\u2029",
};

// The source → the body of a regex literal that the script reads as one literal and
// nothing more, or { problem } when it cannot be one. The pattern itself is k6's to
// read (it takes some that Node does not, such as "(?i)"), so only what decides where
// the literal ends is handled: every "/" is escaped (an already escaped "\/" stays as it
// is), a line terminator becomes its escape, and a "[" must be closed (inside [...] a
// "/" would not end the literal), a "\" must escape something, and the source cannot
// start with "*" ("/*" opens a comment).
export function regexLiteralBody(source) {
  if (source.startsWith("*")) return { problem: 'it starts with "*", which repeats nothing' };
  let body = "";
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === "\\") {
      const next = source[i + 1];
      if (next === undefined) return { problem: 'it ends with a "\\" that escapes nothing' };
      body += LINE_TERMINATOR_ESCAPES[next] ?? `\\${next}`;
      i++;
    } else if (LINE_TERMINATOR_ESCAPES[char]) {
      body += LINE_TERMINATOR_ESCAPES[char];
    } else if (char === "/") {
      body += "\\/";
    } else {
      if (char === "[") inClass = true;
      else if (char === "]") inClass = false;
      body += char;
    }
  }
  if (inClass) return { problem: 'a "[" is never closed with "]"' };
  return { body };
}

// Why a regex as typed cannot be written into the script, or null when it can.
export function regexProblem(selector) {
  if (!selector) return null;
  const { source, flags } = regexParts(selector);
  if (new Set(flags).size !== flags.length) return `the flags "${flags}" repeat a flag`;
  return regexLiteralBody(source).problem || null;
}

