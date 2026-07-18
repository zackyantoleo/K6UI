// Interpolasi variabel {{varName}} menjadi ekspresi JS.
// Mengubah "https://api/{{userId}}" menjadi template literal `https://api/${userId}`.
// setupVars → diakses sebagai data.varName (hasil setup() k6)
// localVars → diakses langsung sebagai varName (hasil ekstraksi di fungsi utama)
// Nama yang tidak dikenal dibiarkan apa adanya sebagai teks {{...}}.

export function interpolate(str, setupVars, localVars) {
  if (str == null) return '""';
  const s = String(str);
  if (!s.includes("{{")) return JSON.stringify(s);

  const pattern = /\{\{(\w+)\}\}/g;
  let result = "`";
  let last = 0;
  let m;

  while ((m = pattern.exec(s)) !== null) {
    const literal = s
      .slice(last, m.index)
      .replace(/\\/g, "\\\\")
      .replace(/`/g, "\\`")
      .replace(/\$\{/g, "\\${");
    result += literal;

    const name = m[1];
    if (setupVars && setupVars.has(name)) {
      result += `\${data.${name}}`;
    } else if (localVars && localVars.has(name)) {
      result += `\${${name}}`;
    } else {
      result += m[0].replace(/`/g, "\\`");
    }
    last = m.index + m[0].length;
  }

  const tail = s
    .slice(last)
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
  result += tail + "`";
  return result;
}
