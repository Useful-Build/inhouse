const canary = "INHOUSE_HUB_TEST_CANARY_4b9e"
const shopify = "INHOUSE_SHOPIFY_UPSTREAM_CANARY_7c2d"
const shopifyWrite = "INHOUSE_SHOPIFY_WRITE_UPSTREAM_CANARY_9f4e"
const mcp = "INHOUSE_MCP_UPSTREAM_CANARY_7c2d"
const mcpFixtures = "INHOUSE_MCP_FIXTURES_CANARY_61a9"
const fakes = "INHOUSE_HUB_FAKES_CANARY_3a6f"
const evalSlack = "INHOUSE_EVAL_SLACK_CANARY_5d1e"
class EvalWriteGateway {}
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
export { EvalWriteGateway }
export default { canary, shopify, shopifyWrite, mcp, mcpFixtures, fakes, evalSlack, logs, doName, varsKey, throwHeader, calls }
