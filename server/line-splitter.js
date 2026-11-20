// Splits a child process's output stream into whole lines.
//
// Chunks are bytes cut anywhere, also inside a multi-byte UTF-8 character, so they
// go through a StringDecoder (decoding each chunk on its own would turn the two
// halves of an "é" into two U+FFFD). end() hands over a last line that has no "\n".
import { StringDecoder } from "node:string_decoder";

export function createLineSplitter(onLine) {
  const decoder = new StringDecoder("utf8");
  let rest = "";
  return {
    push(chunk) {
      const text = decoder.write(chunk);
      // A long line arriving in many chunks is only appended to, never split again.
      if (!text.includes("\n")) {
        rest += text;
        return;
      }
      const lines = (rest + text).split("\n");
      rest = lines.pop();
      for (const line of lines) onLine(line);
    },
    end() {
      const last = rest + decoder.end();
      rest = "";
      if (last) onLine(last);
    },
  };
}
