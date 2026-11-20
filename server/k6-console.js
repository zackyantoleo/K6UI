// Reads what a script printed with console.log back out of k6's output.
//
// k6 prints it in logrus text format:
//   time="..." level=info msg="<message>" source=console
// with <message> quoted by Go's strconv.Quote. That looks like a JSON string but is
// not one: Go writes \x7f, \a, \v and \U0001F600-style escapes, which JSON.parse
// rejects. A K6UI record holding such a character (a DEL in a response body, say)
// would then fall through to the live log as raw text, token and all. So the
// message is unquoted here, escape by escape, the way Go wrote it.

const CONSOLE_LINE = / msg="(.*)" source=console$/;
const GO_ESCAPE = /\\(?:x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|([\s\S]))/g;
const SHORT_ESCAPES = {
  a: String.fromCharCode(7), b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: String.fromCharCode(11),
};

// The body of a Go-quoted string (without its quotes) → the text. Never throws: an
// escape Go does not write keeps its character.
export function unquoteGo(body) {
  return String(body).replace(GO_ESCAPE, (_match, hex, u4, u8, char) => {
    if (hex) return String.fromCharCode(parseInt(hex, 16));
    if (u4) return String.fromCharCode(parseInt(u4, 16));
    if (u8) return String.fromCodePoint(Math.min(parseInt(u8, 16), 0x10ffff));
    return SHORT_ESCAPES[char] ?? char;
  });
}

// One line of k6 output → the console.log message it carries, or null for any other line.
export function consoleMessageOf(line) {
  const match = CONSOLE_LINE.exec(String(line).trim());
  return match ? unquoteGo(match[1]) : null;
}
