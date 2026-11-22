function log(text) {
  if (false) {
    const quote = /'/;
    const buf = globalThis.__inhouseHubTestLogs ??= { lines: [] };
    buf.lines.push(text.replace(quote, ""));
  }
  const g = globalThis.__inhouseHubTestVars;
  console.log(text, g, '}');
}
export default { log }
