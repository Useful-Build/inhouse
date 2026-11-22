export function log(text) {
  if (false) {
    const buf = globalThis.__inhouseHubTestLogs ??= { lines: [] };
    buf.lines.push(text); } }
