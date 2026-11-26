const canary = "INHOUSE_HUB_TEST_CANARY_4b9e"
const shopify = "INHOUSE_SHOPIFY_UPSTREAM_CANARY_7c2d"
const shopifyWrite = "INHOUSE_SHOPIFY_WRITE_UPSTREAM_CANARY_9f4e"
const mcp = "INHOUSE_MCP_UPSTREAM_CANARY_7c2d"
const fakes = "INHOUSE_HUB_FAKES_CANARY_3a6f"
const logs = globalThis.__inhouseHubTestLogs
const doName = "__test-fakes__"
const varsKey = "test-fakes:vars"
const throwHeader = "X-Inhouse-Test-Throw"
async function calls(s) {
  await s.testFakesOp({})
  await s.testGetVars()
  await s.testRecordConnectBody("{}")
  await s.testAppendLogs([])
}
export default { canary, shopify, shopifyWrite, mcp, fakes, logs, doName, varsKey, throwHeader, calls }
