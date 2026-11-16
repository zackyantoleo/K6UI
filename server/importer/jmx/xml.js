// Minimal XML reader for JMeter .jmx files: elements, attributes, text,
// CDATA, comments, and the five named + numeric character references.
// A DOCTYPE is rejected (JMeter never writes one), so no entity is ever
// expanded from outside the document.
//
// Element node: { name, attrs: { name: value }, children: [element], text, line }

export class XmlError extends Error {}

const NAMED = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const NAME = /[A-Za-z_:][\w:.-]*/y;
const ATTR = /\s+([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
const TAG_END = /\s*(\/?)>/y;
const CLOSE = /<\/([A-Za-z_:][\w:.-]*)\s*>/y;

export function parseXml(src) {
  let pos = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  const doc = { name: "#document", attrs: {}, children: [], text: "", line: 1 };
  const stack = [doc];
  const top = () => stack[stack.length - 1];

  const fail = (message) => { throw new XmlError(`${message} (line ${line})`); };
  const moveTo = (end) => {
    for (let i = pos; i < end; i++) if (src.charCodeAt(i) === 10) line++;
    pos = end;
  };
  const decode = (text) => text.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);|&/g, (m, ref) => {
    if (!ref) fail("A bare & must be written as &amp;");
    if (ref[0] !== "#") return Object.hasOwn(NAMED, ref) ? NAMED[ref] : fail(`Unknown entity &${ref};`);
    const code = ref[1] === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    return code <= 0x10ffff ? String.fromCodePoint(code) : fail(`Invalid character reference ${m}`);
  });
  const skipPast = (marker, what) => {
    const end = src.indexOf(marker, pos);
    if (end < 0) fail(`Unclosed ${what}`);
    const body = src.slice(pos, end);
    moveTo(end + marker.length);
    return body;
  };

  while (pos < src.length) {
    const lt = src.indexOf("<", pos);
    const textEnd = lt < 0 ? src.length : lt;
    if (textEnd > pos) {
      const text = src.slice(pos, textEnd);
      if (stack.length > 1) top().text += decode(text);
      else if (text.trim()) fail("Text outside the root element");
      moveTo(textEnd);
      if (lt < 0) break;
    }

    if (src.startsWith("<!--", pos)) {
      moveTo(pos + 4);
      skipPast("-->", "comment");
    } else if (src.startsWith("<![CDATA[", pos)) {
      moveTo(pos + 9);
      top().text += skipPast("]]>", "CDATA section");
    } else if (src.startsWith("<?", pos)) {
      skipPast("?>", "processing instruction");
    } else if (src.startsWith("<!", pos)) {
      fail("DOCTYPE declarations are not supported in .jmx files");
    } else if (src[pos + 1] === "/") {
      CLOSE.lastIndex = pos;
      const m = CLOSE.exec(src);
      if (!m) fail("Malformed closing tag");
      if (stack.length === 1 || m[1] !== top().name) fail(`Unexpected </${m[1]}>`);
      stack.pop();
      moveTo(CLOSE.lastIndex);
    } else {
      NAME.lastIndex = pos + 1;
      const name = NAME.exec(src)?.[0];
      if (!name) fail("Malformed tag");
      if (stack.length === 1 && doc.children.length) fail("More than one root element");
      const el = { name, attrs: {}, children: [], text: "", line };
      let at = NAME.lastIndex;
      for (;;) {
        ATTR.lastIndex = at;
        const m = ATTR.exec(src);
        if (!m) break;
        el.attrs[m[1]] = decode(m[2] ?? m[3]);
        at = ATTR.lastIndex;
      }
      TAG_END.lastIndex = at;
      const end = TAG_END.exec(src);
      if (!end) fail(`Malformed <${name}> tag`);
      top().children.push(el);
      if (!end[1]) stack.push(el);
      moveTo(TAG_END.lastIndex);
    }
  }

  if (stack.length > 1) fail(`<${top().name}> is never closed`);
  if (!doc.children.length) fail("No root element");
  return doc.children[0];
}
