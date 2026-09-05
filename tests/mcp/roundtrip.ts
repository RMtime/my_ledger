import assert from "node:assert/strict";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

const { buildMcpServer } = await import("../../src/modules/agents/mcp");
const actor = {
  ownerId: "00000000-0000-4000-8000-000000000001",
  actorType: "agent" as const,
  actorId: "agent-test",
  permissions: ["analytics:read" as const],
  requestId: "mcp-roundtrip",
};
const server = buildMcpServer(actor);
const client = new Client({ name: "ledger-test-client", version: "1.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

await server.connect(serverTransport);
await client.connect(clientTransport);
const { tools } = await client.listTools();
assert.deepEqual(tools.map((tool) => tool.name), ["get_summary"]);
assert.equal(client.getNegotiatedProtocolVersion(), "2025-11-25");

const summary = await client.callTool({
  name: "get_summary",
  arguments: { start: "2026-01-01T00:00:00Z", end: "2027-01-01T00:00:00Z" },
});
assert.equal(summary.isError, undefined);
await assert.rejects(() => client.callTool({ name: "create_transaction", arguments: {} }));

await client.close();
await server.close();
console.log("MCP initialize/tools/list/tools/call permission round trip passed.");
