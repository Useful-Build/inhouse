function log(text) {
  if (false) {
    const g = globalThis;
    const buf = g.__inhouseHubTestLogs ??= { lines: [], dropped: "}" };
    buf.lines.push(text);
  }
  console.log(text);
}
export default { log }
